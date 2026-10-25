// Live demo endpoint for the Arbitrage Scanner (api/router.ts → this file). Read-only, Pharos mainnet only: it runs the CLI's own scan of the
// two real WPROS/USDC pools (Uniswap-V3-style and FaroSwap) at one block and renders the same table and decision. It never calls the signer:
// a decision to act is shown as an unsigned plan for inspection. The executed trade (our own Atlantic test pools) needs a key and stays in the CLI.
//   GET ?action=info
//   GET ?action=run[&minProfit=0.001][&slippageBps=10][&gasUnits=350000][&sizes=0.01,0.05,0.1,0.25,0.5]   NDJSON (steps, then one "done" line with a View)
import { getAddress, type Hex } from "viem";
import { planRoute } from "../../src/arb/execute.js";
import { fmtUnits, makeRecord, scanText, scanVenues, type ScanConfig } from "../../src/arb/scan.js";
import { readDodo, readUniV3, withRetries, type Venue } from "../../src/arb/venues.js";
import { InputError, stepper, trackPhases, type Emit } from "../../src/web/live.js";
import { numParam, serve, type Deps } from "../../src/web/mainnet-live.js";
import type { View } from "../../src/web/view.js";
import { MAINNET, parseAmounts } from "./index.js";

export interface RunParams { minProfit: string; slippageBps: number; gasUnits: number; sizes: string }

export function parseRun(url: URL): RunParams {
  const q = url.searchParams;
  const sizes = (q.get("sizes") ?? "0.01,0.05,0.1,0.25,0.5").trim();
  const minProfit = (q.get("minProfit") ?? "0.001").trim();
  try {
    if (parseAmounts(sizes, 6, "sizes").length > 6) throw new Error("sizes: at most 6 amounts");
    parseAmounts(minProfit, 6, "minProfit");
  } catch (e) {
    throw new InputError((e as Error).message);
  }
  return { minProfit, sizes, slippageBps: numParam(q, "slippageBps", 10, 0, 500), gasUnits: numParam(q, "gasUnits", 350_000, 21_000, 5_000_000) };
}

const phaseOf = (tool: string) => (tool === "get_gas_price" || tool === "get_block_number" ? "head" : "pools");

export async function run(p: RunParams, emit: Emit, deps: Deps): Promise<void> {
  const t0 = Date.now();
  const conn = await deps.connect();
  emit({ type: "start", network: "pharos", endpoint: conn.endpoint });
  const t = trackPhases(conn.call, emit, phaseOf, (_ph, n) => `${n} call${n === 1 ? "" : "s"}`);
  try {
    const call = t.call;
    const m = MAINNET.market;
    const cfg: ScanConfig = { sizes: parseAmounts(p.sizes, 6, "sizes"), minProfit: parseAmounts(p.minProfit, 6, "minProfit")[0]!, slippageBps: p.slippageBps, gasUnits: BigInt(Math.round(p.gasUnits)), gasPriceWei: BigInt((await call("get_gas_price")).gasPriceWei) };
    const head = BigInt((await call("get_block_number")).blockNumber);
    const venues: [Venue, Venue] = await Promise.all([withRetries(() => readUniV3(call, MAINNET.uniswapStylePool, m, head)), withRetries(() => readDodo(call, MAINNET.faroSwapPool, m, head))]);
    const candidates = await scanVenues(venues, m, cfg);
    const record = makeRecord({ network: "pharos", block: head, m, venues, cfg, candidates });
    t.finish();
    const s = stepper(emit);
    s.begin("decision");
    s.end("decision", record.decision === "ACT" ? "ok" : "skip", record.decision);
    const best = record.best;
    let plan = "";
    if (best) {
      const buyIdx = venues[0].id === best.buyOn ? 0 : 1;
      const ref = (v: Venue) => ({ kind: v.kind, address: v.address });
      const route = planRoute(best, ref(venues[buyIdx]!), ref(venues[1 - buyIdx]!), m, cfg, getAddress("0x000000000000000000000000000000000000dEaD") as Hex);
      plan = `\n${record.decision === "ACT" ? "PLAN (mainnet is read-only: prepared, never signed)" : "PLAN shown for inspection only: this scan decided SKIP, nothing would be sent"}: ${JSON.stringify(route.legs.map((l) => ({ venue: l.venue, amountIn: `${l.amountIn} ${l.side}`, minOut: l.minOut })))}`;
    }
    const f = (v: bigint) => fmtUnits(v, m.quote.decimals, 6);
    const idx = (id: string) => (record.sources.findIndex((x) => x.id === id) === 0 ? "A→B" : "B→A");
    const view: View = {
      tone: record.decision === "ACT" ? "ok" : "warn",
      verdict: `${record.decision}${best ? `: best round trip nets ${f(best.net)} USDC after costs` : ""}`,
      note: `${record.reason} Block ${record.block} on Pharos mainnet. Route A→B = buy WPROS on the Uniswap-V3-style pool, sell on FaroSwap. Mainnet is read-only: nothing is ever sent from this page.`,
      tables: [{
        head: ["Route", "In (USDC)", "Gross bps", "Fees", "Impact", "Slippage", "Gas", "Net"],
        rows: record.candidates.map((c) => [idx(c.buyOn), f(c.amountIn), c.grossBps.toFixed(1), f(c.fees), f(c.impact), f(c.slippageBuffer), f(c.gas), f(c.net)]),
      }],
      text: scanText(record, m) + plan,
      evidence: [
        ["Sources", record.sources.map((x) => `${x.id} mid ${x.mid.toFixed(6)}`).join(" · ")],
        ["Block", `${record.block} (the head, read first)`],
        ["Threshold", `net ≥ ${p.minProfit} USDC · slippage ${p.slippageBps} bps · gas ${p.gasUnits.toLocaleString("en-US")} units`],
        ["Chain MCP reads", `${t.total() + 0} calls`],
        ["Signed", "nothing: this page has no key"],
      ],
      summary: `${record.decision}: ${record.reason.slice(0, 160)}`,
    };
    emit({ type: "done", totalMs: Date.now() - t0, reads: t.total(), view });
  } catch (e) {
    t.finish(e as Error);
    throw e;
  } finally {
    await conn.close().catch(() => {});
  }
}

export const handle = serve("arbitrage-scanner", parseRun, run, { sources: "Uniswap-V3-style WPROS/USDC pool vs FaroSwap WPROS/USDC pool", executes: "never from this page" });
