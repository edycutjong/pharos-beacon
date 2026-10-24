// Yield Optimizer (Hard · 200 pts): compares the yield of several on-chain sources, nets out gas, entry/exit fees and a minimum
// holding period, and recommends a move or "stay put" with the reason. A move is PREPARED for the owner's signature, never signed:
// this file, src/yield/ and the plan hold no key. (tasks/yield-optimizer/wallet.ts stands in for the owner's wallet on testnet.)
//   npm run yield-optimizer -- recommend --wallet 0x… [--network pharos|atlantic] [--windows 1d,7d,30d] [--hold-days 30]
//        [--min-net-usd 1] [--slippage-bps 10] [--haircut 0.5] [--block N] [--native-usd N] [--plan file.json] [--proof name]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Hex } from "viem";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";

import { atlantic, pharos } from "../../src/lib/networks.js";
import { PROS_POOL, readProsPrice, headerAt } from "../../src/portfolio/read.js";
import { DEFAULT_RATE_OPTIONS, parseWindows } from "../../src/yield/model.js";
import { renderReport, toJson } from "../../src/yield/format.js";
import { NoPosition, analyse } from "../../src/yield/run.js";
import { MAINNET_VAULT_SOURCES, USDC_MAINNET, morphoUsdcSources, type Source } from "../../src/yield/sources.js";

const TASK = "yield-optimizer";
const HERE = fileURLToPath(new URL(".", import.meta.url));

interface Deployments {
  asset: { address: Hex; decimals: number };
  vaults: Record<string, { name: string; address: Hex }>;
}
const deployments = () => JSON.parse(readFileSync(join(HERE, "deployments.json"), "utf8")) as Deployments;

export const atlanticSources = (): Source[] => Object.entries(deployments().vaults).map(([key, v]) => ({ key, name: v.name, kind: "testvault" as const, contract: getAddress(v.address) }));

function num(flag: string, v: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${flag} must be a number between ${min} and ${max}, got ${JSON.stringify(v)}`);
  return n;
}

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- recommend --wallet 0x… [--network pharos|atlantic] [--windows 1d,7d,30d] [--hold-days 30] [--min-net-usd 1] [--slippage-bps 10] [--haircut 0.5] [--block N] [--native-usd N] [--plan file.json] [--proof name]`,
      options: {
        wallet: { type: "string" },
        network: { type: "string", default: "pharos" },
        windows: { type: "string" },
        "hold-days": { type: "string", default: "30" },
        "min-net-usd": { type: "string", default: "1" },
        "slippage-bps": { type: "string", default: "10" },
        haircut: { type: "string", default: "0.5" },
        block: { type: "string" },
        "native-usd": { type: "string" },
        plan: { type: "string" },
        proof: { type: "string" },
      },
      positionals: [1, 1],
    },
    argv,
  );
  choice("command", positionals[0], ["recommend"] as const);
  const network = choice("--network", values.network, ["pharos", "atlantic"] as const);
  if (!values.wallet || !isAddress(values.wallet)) throw new UsageError("--wallet must be an address");
  const wallet = getAddress(values.wallet);
  let windows;
  try {
    windows = parseWindows(values.windows ?? (network === "pharos" ? "1d,7d,30d" : "10m,30m,1h"));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const holdDays = num("hold-days", values["hold-days"]!, 0.0001, 3650);
  const minNetUsd = num("min-net-usd", values["min-net-usd"]!, 0, 1e9);
  const slippageBps = num("slippage-bps", values["slippage-bps"]!, 0, 500);
  const haircut = num("haircut", values.haircut!, 0, 1); // 0 = judge every source by its median rate, 1 = take the whole spread off a destination
  const rate = { ...DEFAULT_RATE_OPTIONS, haircut };
  if (values.block !== undefined && !/^\d{1,12}$/.test(values.block)) throw new UsageError("--block must be a block number");

  const givenNativeUsd = values["native-usd"] === undefined ? undefined : num("native-usd", values["native-usd"], 1e-9, 1e9); // validated before any chain call

  const mcp = await chainMcp(network);
  onExit(() => mcp.close());
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined;
  const call = mcp.call.bind(mcp) as typeof mcp.call;
  const pinned = values.block === undefined ? undefined : BigInt(values.block);

  // the price of the gas token in USD: mainnet from its own WPROS/USDC pool; Atlantic's PHRS has no market, so a stand-in is used and named
  let nativeUsd: { value: number; basis: string };
  if (givenNativeUsd !== undefined) nativeUsd = { value: givenNativeUsd, basis: "given with --native-usd" };
  else if (network === "pharos") {
    const h = await headerAt(call, pinned);
    const p = await readProsPrice(call, h.block);
    nativeUsd = { value: p.price, basis: `PROS in USDC from the WPROS/USDC pool ${PROS_POOL} slot0 at block ${h.block}` };
  } else {
    const main = await chainMcp("pharos");
    onExit(() => main.close());
    const mc = main.call.bind(main) as typeof main.call;
    const h = await headerAt(mc);
    const p = await readProsPrice(mc, h.block);
    nativeUsd = { value: p.price, basis: `stand-in: Atlantic PHRS has no market, so the MAINNET PROS price is used (WPROS/USDC pool slot0 at mainnet block ${h.block})` };
  }

  let sources: Source[];
  let skipped: string[] = [];
  let usdc: Hex;
  if (network === "pharos") {
    const h = await headerAt(call, pinned);
    const m = await morphoUsdcSources(call, USDC_MAINNET, h.block, h.timestamp);
    sources = [...MAINNET_VAULT_SOURCES, ...m.sources];
    skipped = m.skipped;
    usdc = USDC_MAINNET;
  } else {
    sources = atlanticSources();
    usdc = getAddress(deployments().asset.address);
  }

  let report;
  try {
    report = await analyse({ call, chainId: network === "pharos" ? pharos.id : atlantic.id, network, wallet, sources, usdc, assetDecimals: 6, windows, holdDays, minNetUsd, slippageBps, nativeUsd, block: pinned, skipped, rate });
  } catch (e) {
    if (e instanceof NoPosition) {
      console.log(`nothing to optimise: ${e.message}`);
      return 1;
    }
    throw e;
  }
  const lines = renderReport(report);
  for (const l of lines) console.log(l);

  if (values.plan) {
    if (!report.plan) console.log(`\nno plan file written: ${report.planNote ?? "no move recommended"}`);
    else {
      writeFileSync(values.plan, JSON.stringify(toJson(report.plan), null, 2) + "\n");
      console.log(`\nplan written to ${values.plan} (unsigned; sign it with your wallet)`);
    }
  }
  if (values.proof) {
    const file = join(HERE, "proof", `${values.proof}.json`);
    writeFileSync(join(HERE, "proof", `${values.proof}.txt`), lines.join("\n") + "\n");
    console.log(`\nproof: ${writeProof(file, toJson(report) as Record<string, unknown>, meta!)} (+ ${values.proof}.txt)`);
  }
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
