// Live demo endpoint for Skill + Chain MCP Flow (api/router.ts → this file). Read-only: it runs the same `judge` the settlement-verdict
// skill drives, on Pharos mainnet through the hosted Chain MCP. It never signs and has no send tool.
//   GET ?action=info
//   GET ?action=run[&hash=0x…|latest=1][&expectTo=0x…][&minValue=0.5]   NDJSON (steps, then one "done" line with a View)
import { isAddress, type Hex } from "viem";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import { DEFAULT_TIERS, judge, latestTransaction, parseCoins, render, type Report } from "../../src/settle/verdict.js";
import { InputError, actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, stepper, trackPhases, type Emit } from "../../src/web/live.js";
import type { View } from "../../src/web/view.js";

type Call = ChainMcp["call"];
export interface Conn { call: Call; endpoint: string; close(): Promise<void> }
export interface Deps { connect: () => Promise<Conn> }
const defaultDeps: Deps = {
  connect: async () => {
    const m = await chainMcp("pharos", { timeoutMs: 20_000 });
    return { call: m.call, endpoint: `hosted Chain MCP ${m.endpoint}`, close: () => m.close() };
  },
};

const HASH = /^0x[0-9a-fA-F]{64}$/;
export interface RunParams { hash?: Hex; latest: boolean; expectTo?: Hex; minValue?: string }

export function parseRun(url: URL): RunParams {
  const q = url.searchParams;
  const hash = (q.get("hash") ?? "").trim();
  const latest = q.get("latest") === "1";
  if (hash && latest) throw new InputError("give a transaction hash or latest=1, not both");
  if (!hash && !latest) throw new InputError("give a transaction hash (0x + 64 hex digits) or latest=1");
  if (hash && !HASH.test(hash)) throw new InputError(`"${hash.slice(0, 80)}" is not a transaction hash (0x + 64 hex digits)`);
  const expectTo = (q.get("expectTo") ?? "").trim();
  if (expectTo && !isAddress(expectTo, { strict: false })) throw new InputError("expectTo must be an address (0x + 40 hex digits)");
  const minValue = (q.get("minValue") ?? "").trim();
  if (minValue) {
    try { parseCoins(minValue); } catch (e) { throw new InputError(`minValue: ${(e as Error).message}`); }
  }
  return { ...(hash ? { hash: hash as Hex } : {}), latest, ...(expectTo ? { expectTo: expectTo as Hex } : {}), ...(minValue ? { minValue } : {}) };
}

const TONE: Record<Report["verdict"], View["tone"]> = { SETTLED: "ok", WAIT: "warn", FAILED: "bad", MISMATCH: "bad", NOT_FOUND: "bad" };
const MEANING: Record<Report["verdict"], string> = {
  SETTLED: "Yes: treat it as paid.",
  WAIT: "Not yet: it is mined (or pending) but not deep enough for its value tier.",
  FAILED: "No: it was mined and reverted, so nothing it was meant to do happened.",
  MISMATCH: "No: it is mined and deep enough, but it is not the payment that was expected.",
  NOT_FOUND: "No: the node has no such transaction.",
};

export function viewOf(r: Report, calls: string[]): View {
  const f = r.facts;
  const rows: string[][] = [["Transaction", f.hash], ["Head block", f.head.toString()]];
  if (f.block !== undefined) rows.push(["Mined in block", f.block.toString()], ["Receipt status", f.status ?? "—"]);
  if (r.confirmations !== undefined) rows.push(["Confirmations", `${r.confirmations}${r.required !== undefined ? ` of ${r.required} required` : ""}`]);
  if (r.tier) rows.push(["Value tier", r.tier]);
  if (r.waitBlocks !== undefined) rows.push(["Still to wait", `${r.waitBlocks} block(s)${r.waitSeconds !== undefined ? `, about ${r.waitSeconds} s` : ""}`]);
  return {
    tone: TONE[r.verdict],
    verdict: r.verdict,
    note: `${MEANING[r.verdict]} Deciding rule: ${r.rule}.`,
    tables: [{ head: ["Fact", "Value"], rows }],
    text: render(r, "Pharos mainnet"),
    evidence: [
      ["Chain MCP calls", calls.join(" → ")],
      ...(f.block !== undefined || r.verdict !== "NOT_FOUND" ? ([["Explorer", { t: "open the transaction", href: explorerTx("pharos", f.hash) }]] as View["evidence"]) : []),
      ["Tiers", DEFAULT_TIERS.map((t) => `${t.below === null ? "above" : `below ${t.below}`}: ${t.confirmations}`).join(" · ")],
    ],
    summary: `${r.verdict}: ${r.rule}`,
  };
}

export async function run(p: RunParams, emit: Emit, deps: Deps = defaultDeps): Promise<void> {
  const t0 = Date.now();
  const conn = await deps.connect();
  emit({ type: "start", network: "pharos", endpoint: conn.endpoint });
  const calls: string[] = [];
  const t = trackPhases(conn.call, emit, (tool) => (calls.push(tool), tool), (_p, n) => `${n} call${n === 1 ? "" : "s"}`);
  try {
    let hash = p.hash;
    if (!hash) {
      const found = await latestTransaction(t.call);
      if (!found) throw new Error("no transaction in the last 60 blocks: pass a hash");
      hash = found.hash;
    }
    const report = await judge(t.call, hash, { expect: { ...(p.expectTo ? { to: p.expectTo } : {}), ...(p.minValue ? { minValue: p.minValue } : {}) } });
    t.finish();
    const s = stepper(emit);
    s.begin("verdict");
    s.end("verdict", report.verdict === "SETTLED" ? "ok" : report.verdict === "WAIT" ? "skip" : "refused", report.verdict);
    emit({ type: "done", totalMs: Date.now() - t0, view: viewOf(report, calls) });
  } catch (e) {
    t.finish(e as Error);
    throw e;
  } finally {
    await conn.close().catch(() => {});
  }
}

const gate = concurrencyGate(2);

export function handle(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  return guard(async () => {
    const url = new URL(req.url);
    const action = actionOf(url, ["info", "run"] as const, "info");
    if (action === "info") return json({ task: "skill-chain-mcp-flow", reads: "hosted Chain MCP https://mcp.pharos.xyz/mcp (Pharos mainnet, read-only)", tiers: DEFAULT_TIERS, deploy: deployInfo() });
    const p = parseRun(url);
    if (!gate.take()) return busy();
    return ndjson((emit) => run(p, emit, deps), gate.release);
  });
}
