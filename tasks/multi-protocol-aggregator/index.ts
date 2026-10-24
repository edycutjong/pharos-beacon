// Multi-Protocol Aggregator (Hard · 200 pts): ONE interface over several Pharos mainnet protocols (RockawayX vault, Morpho Blue
// markets, Centrifuge fund vaults). It answers queries (positions, rates) and prepares actions (a deposit or a withdrawal, as
// unsigned transactions for the owner's wallet), routes each request to the best venue and says why, and keeps working when a
// protocol is down. It holds no key and sends nothing: src/aggregator/ and this file import no signer.
//   npm run multi-protocol-aggregator -- positions|rates|deposit|withdraw --wallet 0x… [--amount 500|all] [--hold-days 30]
//        [--windows 1d,7d,30d] [--haircut 0.5] [--down morpho,rockawayx,morpho-c79579] [--timeout-ms 120000] [--assume-funded]
//        [--block N] [--native-usd N] [--plan file.json] [--proof name]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, parseUnits } from "viem";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { pharos } from "../../src/lib/networks.js";
import { PROS_POOL, headerAt, readProsPrice } from "../../src/portfolio/read.js";
import { DEFAULT_RATE_OPTIONS, parseWindows } from "../../src/yield/model.js";
import { MAINNET_VAULT_SOURCES, USDC_MAINNET, morphoUsdcSources } from "../../src/yield/sources.js";
import { venuesFromSources } from "../../src/aggregator/adapters.js";
import { renderReport, toJson } from "../../src/aggregator/format.js";
import { InsufficientFunds, aggregate, type Request } from "../../src/aggregator/run.js";

const TASK = "multi-protocol-aggregator";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const COMMANDS = ["positions", "rates", "deposit", "withdraw"] as const;
const PROTOCOLS = ["rockawayx", "morpho", "centrifuge"] as const;

function num(flag: string, v: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${flag} must be a number between ${min} and ${max}, got ${JSON.stringify(v)}`);
  return n;
}

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- ${COMMANDS.join("|")} --wallet 0x… [--amount 500|all] [--hold-days 30] [--windows 1d,7d,30d] [--haircut 0.5] [--down protocol-or-venue-id,…] [--timeout-ms 120000] [--assume-funded] [--block N] [--native-usd N] [--plan file.json] [--proof name]`,
      options: {
        wallet: { type: "string" },
        amount: { type: "string" },
        "hold-days": { type: "string", default: "30" },
        windows: { type: "string", default: "1d,7d,30d" },
        haircut: { type: "string", default: "0.5" },
        down: { type: "string" },
        "timeout-ms": { type: "string", default: "120000" },
        "assume-funded": { type: "boolean", default: false },
        block: { type: "string" },
        "native-usd": { type: "string" },
        plan: { type: "string" },
        proof: { type: "string" },
      },
      positionals: [1, 1],
    },
    argv,
  );
  const command = choice("command", positionals[0], COMMANDS);
  if (!values.wallet || !isAddress(values.wallet)) throw new UsageError("--wallet must be an address");
  const wallet = getAddress(values.wallet);
  let windows;
  try {
    windows = parseWindows(values.windows!);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const holdDays = num("hold-days", values["hold-days"]!, 0.0001, 3650);
  const haircut = num("haircut", values.haircut!, 0, 1);
  const timeoutMs = num("timeout-ms", values["timeout-ms"]!, 100, 3_600_000);
  // a protocol (every venue of it) or one venue by id, e.g. morpho-c79579 (see the ids printed by `rates`)
  const down = values.down ? values.down.split(",").map((p) => (/^[a-z]+-[0-9a-f]{6}$/.test(p.trim()) ? p.trim() : (choice("--down", p.trim(), PROTOCOLS) as string))) : [];
  if (values.block !== undefined && !/^\d{1,12}$/.test(values.block)) throw new UsageError("--block must be a block number");

  let request: Request;
  if (command === "deposit" || command === "withdraw") {
    if (!values.amount) throw new UsageError(`${command} needs --amount${command === "withdraw" ? " (a USDC amount or all)" : " (a USDC amount, e.g. 500)"}`);
    if (values.amount === "all") {
      if (command === "deposit") throw new UsageError("--amount all only makes sense for a withdrawal");
      request = { kind: "withdraw", assets: "all" };
    } else {
      if (!/^\d{1,10}(\.\d{1,6})?$/.test(values.amount) || Number(values.amount) <= 0) throw new UsageError(`--amount must be a positive USDC amount (under 10 billion) with at most 6 decimals, got ${JSON.stringify(values.amount)}`);
      request = { kind: command, assets: parseUnits(values.amount, 6) };
    }
  } else {
    if (values.amount) throw new UsageError(`--amount is for deposit and withdraw, not ${command}`);
    request = { kind: command };
  }
  if (values["assume-funded"] && command !== "deposit") throw new UsageError("--assume-funded is for deposit");

  const mcp = await chainMcp("pharos");
  onExit(() => mcp.close());
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined;
  const call = mcp.call.bind(mcp) as typeof mcp.call;
  const pinned = values.block === undefined ? undefined : BigInt(values.block);
  const h = await headerAt(call, pinned);

  let nativeUsd: { value: number; basis: string };
  if (values["native-usd"] !== undefined) nativeUsd = { value: num("native-usd", values["native-usd"], 1e-9, 1e9), basis: "given with --native-usd" };
  else {
    const p = await readProsPrice(call, h.block);
    nativeUsd = { value: p.price, basis: `PROS in USDC from the WPROS/USDC pool ${PROS_POOL} slot0 at block ${h.block}` };
  }

  const m = await morphoUsdcSources(call, USDC_MAINNET, h.block, h.timestamp);
  const venues = venuesFromSources([...MAINNET_VAULT_SOURCES, ...m.sources]);

  const unknown = down.filter((d) => !(PROTOCOLS as readonly string[]).includes(d) && !venues.some((v) => v.id === d));
  if (unknown.length) throw new UsageError(`--down: no venue ${unknown.join(", ")}; venues: ${venues.map((v) => v.id).join(", ")}`);

  let report;
  try {
    report = await aggregate({ call, chainId: pharos.id, network: "pharos", wallet, venues, usdc: USDC_MAINNET, assetDecimals: 6, windows, holdDays, nativeUsd, request, block: pinned, rate: { ...DEFAULT_RATE_OPTIONS, haircut }, down, venueTimeoutMs: timeoutMs, assumeFunded: values["assume-funded"], skipped: m.skipped });
  } catch (e) {
    if (e instanceof InsufficientFunds) {
      console.log(`refused: ${e.message}`);
      return 1;
    }
    throw e;
  }
  const lines = renderReport(report);
  for (const l of lines) console.log(l);

  if (values.plan) {
    if (!report.plan) console.log(`\nno plan file written: ${report.planNote ?? "no transactions prepared"}`);
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
