// Arbitrage Scanner (Hard · 200 pts): a Skill that reads one price from two sources in the same scan, nets swap fees, price
// impact, a slippage allowance and gas off the gross spread, and acts ONLY when the net profit clears a configurable threshold.
//   npm run arbitrage-scanner -- scan [--network pharos|atlantic] [--min-profit 0.001] [--sizes 0.01,0.05,0.1] [--slippage-bps 10] [--gas-units 350000]
//                                     [--execute] [--show-plan] [--watch --interval-s 60 --max-scans 10] [--log file] [--proof name]
//   npm run arbitrage-scanner -- backtest [--hours 24] [--every-min 60] [--proof name]
//   npm run arbitrage-scanner -- move-rate --pool A|B --rate 0.665      (Atlantic, owner of our test pools: the demo's "market moves")
// Mainnet (pharos): Uniswap-V3-style WPROS/USDC pool vs FaroSwap (DODO-style) WPROS/USDC pool, read-only through the Chain MCP.
// Atlantic: our own two ArbPool test pools (deployments.json), where a decision to act really executes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, getAddress, isAddress, parseAbi, type Hex } from "viem";
import { wait } from "../../src/lib/net.js";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { envOr } from "../../src/lib/env.js";
import { chainMcp, type Network } from "../../src/lib/mcp.js";
import { explorerTx, TOKENS } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { backtest, pinBlocks, secondsPerBlock } from "../../src/arb/backtest.js";
import { executeOnAtlantic, planRoute } from "../../src/arb/execute.js";
import { appendLog, fmtUnits, logLine, makeRecord, scanText, scanVenues, type Candidate, type ScanConfig } from "../../src/arb/scan.js";
import { readArbPool, readDodo, readUniV3, withRetries, type Market, type Venue } from "../../src/arb/venues.js";

const TASK = "arbitrage-scanner";
const HERE = fileURLToPath(new URL(".", import.meta.url));

export const MAINNET = {
  uniswapStylePool: getAddress("0x912c9ade24d44d8922f0866d8dcb079f1363f647"),
  faroSwapPool: getAddress("0xac998dD78829aDe9f654e0BE7a4D7F60D8B37196"),
  market: {
    base: { symbol: "WPROS", address: TOKENS.pharos.WPROS.address as Hex, decimals: 18 },
    quote: { symbol: "USDC", address: TOKENS.pharos.USDC.address as Hex, decimals: 6 },
  } satisfies Market,
};
const deployments = () => JSON.parse(readFileSync(join(HERE, "deployments.json"), "utf8")) as { tokens: Record<string, { address: Hex; decimals: number }>; pools: Record<"A" | "B", { address: Hex }>; deployer: Hex };
export const atlanticMarket = (): Market => {
  const t = deployments().tokens;
  return { base: { symbol: "WPHRS", address: t.WPHRS!.address, decimals: 18 }, quote: { symbol: "USDC", address: t.USDC!.address, decimals: 6 } };
};

/** "0.25,0.5" → raw units of `decimals`; each must be a positive decimal with at most `decimals` places. */
export function parseAmounts(text: string, decimals: number, flag: string): bigint[] {
  const out = text.split(",").map((p) => {
    const t = p.trim();
    const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
    if (!m || (m[2] ?? "").length > decimals) throw new UsageError(`${flag}: ${JSON.stringify(t)} is not an amount with at most ${decimals} decimals`);
    const v = BigInt(m[1]! + (m[2] ?? "").padEnd(decimals, "0"));
    if (v <= 0n) throw new UsageError(`${flag}: amounts must be positive`);
    return v;
  });
  if (!out.length) throw new UsageError(`${flag}: give at least one amount`);
  return out;
}

/** 0 unless an --execute run did not complete (it stopped after leg 1): the caller must be able to tell. */
export const exitCodeFor = (execution: { outcome: string } | undefined): number => (execution && execution.outcome !== "completed" ? 1 : 0);

const rateAbi = parseAbi(["function setRate(uint256 num,uint256 den)"]);

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- scan|backtest|move-rate [--network pharos|atlantic] [--min-profit USDC] [--sizes a,b,c] [--slippage-bps N] [--gas-units N] [--execute] [--show-plan] [--watch --interval-s N --max-scans N] [--log file] [--proof name] | backtest [--hours N] [--every-min N] | move-rate --pool A|B --rate USDC_PER_BASE`,
      options: {
        network: { type: "string", default: "pharos" }, "min-profit": { type: "string", default: "0.001" }, sizes: { type: "string" },
        "slippage-bps": { type: "string", default: "10" }, "gas-units": { type: "string", default: "350000" }, execute: { type: "boolean", default: false },
        from: { type: "string" }, log: { type: "string", default: envOr("ARB_LOG", join(HERE, "state/scans.jsonl")) }, proof: { type: "string" },
        watch: { type: "boolean", default: false }, "interval-s": { type: "string", default: "60" }, "max-scans": { type: "string", default: "10" }, "show-plan": { type: "boolean", default: false },
        hours: { type: "string", default: "24" }, "every-min": { type: "string", default: "60" }, pool: { type: "string" }, rate: { type: "string" },
      },
      positionals: [1, 1],
    },
    argv,
  );
  const cmd = choice("command", positionals[0], ["scan", "backtest", "move-rate"] as const);
  const network = choice("--network", values.network, ["pharos", "atlantic"] as const) as Network;
  const num = (flag: string, v: string, min: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) throw new UsageError(`${flag} must be a number ≥ ${min}`);
    return n;
  };
  const slippageBps = num("--slippage-bps", values["slippage-bps"]!, 0);
  if (slippageBps >= 10_000) throw new UsageError("--slippage-bps must be below 10000 (100%)");
  const gasUnits = BigInt(Math.round(num("--gas-units", values["gas-units"]!, 1)));

  const intervalS = num("--interval-s", values["interval-s"]!, 1);
  const maxScans = Math.round(num("--max-scans", values["max-scans"]!, 1));
  if (values.watch && (values.execute || values.proof)) throw new UsageError("--watch only scans and logs: it cannot be combined with --execute or --proof");
  if (values.watch && maxScans > 1000) throw new UsageError("--max-scans is at most 1000");

  if (cmd === "move-rate") {
    if (network !== "atlantic") throw new UsageError("move-rate moves our own Atlantic test pool: --network atlantic");
    const pool = choice("--pool", values.pool, ["A", "B"] as const);
    const [rate] = parseAmounts(values.rate ?? "", 6, "--rate");
    const mcp = await chainMcp("atlantic", { broadcast: true });
    onExit(() => mcp.close());
    const signer = testnetSigner(mcp);
    const addr = deployments().pools[pool].address;
    const s = await signer.send({ to: addr, data: encodeFunctionData({ abi: rateAbi, functionName: "setRate", args: [rate!, 10n ** 18n] }) });
    const r = await signer.waitForReceipt(s.hash);
    console.log(`pool ${pool} (${addr}) rate set to ${fmtUnits(rate!, 6)} USDC per WPHRS: ${r.status} ${explorerTx("atlantic", s.hash)}`);
    return r.status === "success" ? 0 : 1;
  }

  const m: Market = network === "pharos" ? MAINNET.market : atlanticMarket();
  const mcp = await chainMcp(network, cmd === "scan" && values.execute ? { broadcast: true } : {});
  onExit(() => mcp.close());
  const call = mcp.call.bind(mcp);
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined;
  const minProfit = parseAmounts(values["min-profit"]!, m.quote.decimals, "--min-profit")[0]!;

  if (cmd === "backtest") {
    if (network !== "pharos") throw new UsageError("backtest replays the real mainnet pools: --network pharos");
    const hours = num("--hours", values.hours!, 1), everyMin = num("--every-min", values["every-min"]!, 1);
    const count = Math.floor((hours * 60) / everyMin) + 1;
    if (count > 200) throw new UsageError(`${count} scans is more than the 200 this run allows`);
    const head = BigInt((await mcp.call("get_block_number")).blockNumber);
    const spb = await secondsPerBlock(call, head);
    const pins = pinBlocks(head, count, everyMin * 60, spb);
    const cfg: ScanConfig = { sizes: parseAmounts(values.sizes ?? "0.01,0.05,0.1,0.25", 6, "--sizes"), minProfit, slippageBps, gasUnits, gasPriceWei: 0n };
    console.log(`backtest: ${count} scans, one every ${everyMin} min over ${hours} h, at pinned blocks ${pins[0]}…${pins[count - 1]} (${spb.toFixed(3)} s/block), thresholds as in a live scan`);
    const lines: string[] = [];
    const { records, summary } = await backtest({
      call, m, uni: MAINNET.uniswapStylePool, dodo: MAINNET.faroSwapPool, pins, cfg,
      onScan: (r, i) => {
        if (!r.at) return void console.log(`#${String(i + 1).padStart(2)} block ${r.block}  ${r.reason}`);
        lines.push(logLine(r, m));
        const b = r.best;
        console.log(`#${String(i + 1).padStart(2)} block ${r.block} ${r.at.slice(0, 16)}Z  gross ${(b?.grossBps ?? 0).toFixed(1).padStart(6)} bps  net ${b ? fmtUnits(b.net, 6) : "n/a"} USDC (size ${b ? fmtUnits(b.amountIn, 6, 2) : "-"})  ${r.decision}`);
      },
    });
    console.log(`\nsummary: ${summary.scans} scans over ${summary.blocks.hoursCovered} h · gross spread positive in ${summary.grossSpreadPositive} · acted ${summary.acted} · skipped ${summary.skipped} (${Object.entries(summary.skippedBecause).map(([k, v]) => `${v}× ${k}`).join("; ") || "none"}) · best net ${summary.bestNet} USDC · median best gross ${summary.medianBestGrossBps} bps · unreadable blocks ${summary.failed}`);
    appendLog(values.log!, lines.join("\n"));
    if (values.proof) {
      const dir = join(HERE, "proof");
      writeFileSync(join(dir, `${values.proof}.jsonl`), lines.join("\n") + "\n");
      console.log(`proof: ${writeProof(join(dir, `${values.proof}.json`), { summary, pins: pins.map(String), scanLog: `${values.proof}.jsonl`, scans: records.map((r) => JSON.parse(logLine(r, m))) }, meta!)}`);
    }
    return 0;
  }

  // scan (once, or --watch: one scan every --interval-s, up to --max-scans)
  const sizes = parseAmounts(values.sizes ?? (network === "pharos" ? "0.01,0.05,0.1,0.25,0.5" : "0.25,0.5,1,2"), m.quote.decimals, "--sizes");
  const showPlan = (c: Candidate, venues: [Venue, Venue], cfg: ScanConfig, acting: boolean, body: Record<string, unknown>) => {
    const buyIdx = venues[0].id === c.buyOn ? 0 : 1;
    const from = values.from && isAddress(values.from) ? getAddress(values.from) : deployments().deployer;
    const ref = (v: Venue) => ({ kind: v.kind, address: v.address });
    const plan = planRoute(c, ref(venues[buyIdx]!), ref(venues[1 - buyIdx]!), m, cfg, from);
    const label = !acting ? "PLAN shown for inspection only: this scan decided SKIP, nothing would be sent" : network === "pharos" ? "PLAN (mainnet is read-only: prepared, never signed)" : "PLAN (prepared, nothing sent: add --execute to run it on Atlantic)";
    console.log(`${label}: ${JSON.stringify(plan.legs.map((l) => ({ venue: l.venue, amountIn: `${l.amountIn} ${l.side}`, minOut: l.minOut })))}`);
    body.plan = plan;
    body.planFor = acting ? "ACT" : "SKIP (shown for inspection)";
  };

  async function scanOnce(): Promise<Record<string, unknown>> {
    const cfg: ScanConfig = { sizes, minProfit, slippageBps, gasUnits, gasPriceWei: BigInt((await mcp.call("get_gas_price")).gasPriceWei) };
    const head = BigInt((await mcp.call("get_block_number")).blockNumber);
    let venues: [Venue, Venue];
    if (network === "pharos") {
      venues = await Promise.all([withRetries(() => readUniV3(call, MAINNET.uniswapStylePool, m, head)), withRetries(() => readDodo(call, MAINNET.faroSwapPool, m, head))]);
    } else {
      const p = deployments().pools;
      venues = await Promise.all([readArbPool(call, p.A.address, m, head), readArbPool(call, p.B.address, m, head)]);
    }
    const candidates = await scanVenues(venues, m, cfg);
    const record = makeRecord({ network, block: head, m, venues, cfg, candidates });
    console.log(scanText(record, m));
    const line = logLine(record, m);
    appendLog(values.log!, line);
    console.log(`logged to ${values.log!.startsWith(HERE) ? values.log!.slice(HERE.length) : values.log}`);

    const body: Record<string, unknown> = { scan: JSON.parse(line), line };
    const acting = record.decision === "ACT" && record.best;
    if (acting && network === "atlantic" && values.execute) {
      const best = record.best!;
      const buyIdx = venues[0].id === best.buyOn ? 0 : 1;
      const signer = testnetSigner(mcp);
      const ref = (v: Venue) => ({ kind: v.kind, address: v.address });
      const report = await executeOnAtlantic({ mcp, signer, m, cfg, candidate: best, buy: ref(venues[buyIdx]!), sell: ref(venues[1 - buyIdx]!), log: (s) => console.log(s) });
      console.log(`${report.outcome}: USDC ${report.before.quote} → ${report.after.quote} · WPHRS ${report.before.base} → ${report.after.base} · predicted net ${report.predictedNet} · realised net after gas ${report.realisedNet}${report.reason ? ` · ${report.reason}` : ""}`);
      body.execution = report;
    } else if (record.best && (acting || values["show-plan"])) {
      showPlan(record.best, venues, cfg, !!acting, body);
    }
    return body;
  }

  if (values.watch) {
    for (let i = 0; i < maxScans; i++) {
      if (i > 0) await wait(intervalS * 1000);
      console.log(`--- scan ${i + 1} of ${maxScans} ---`);
      await scanOnce();
    }
    return 0;
  }
  const { line, ...body } = (await scanOnce()) as { line: string } & Record<string, unknown>;
  const exit = exitCodeFor(body.execution as { outcome: string } | undefined);
  if (values.proof) {
    const dir = join(HERE, "proof");
    writeFileSync(join(dir, `${values.proof}.jsonl`), line + "\n");
    console.log(`proof: ${writeProof(join(dir, `${values.proof}.json`), body, meta!)}`);
  }
  return exit;
}

if (isMain(import.meta.url)) await runCli(main);
