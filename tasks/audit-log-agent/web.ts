// Live demo endpoint for the Audit-Log Agent (api/router.ts → this file). Read-only: it runs the CLI's own collectActivity and
// markdownReport on the last N blocks of a wallet; it never signs and has no send tool. The CLI reads days; this reads blocks.
//   GET ?action=info
//   GET ?action=run&wallet=0x…[&network=pharos|atlantic][&blocks=1000|5000|10000|30000][&toBlock=N]   NDJSON (steps, then one "done" line with a View)
import { collectActivity, fmtLeg, type Activity } from "../../src/activity/engine.js";
import { markdownReport, notableTxs } from "../../src/activity/report.js";
import { explorerTx } from "../../src/lib/networks.js";
import { activityLabel, activityPhase, defaultDeps, parseWindow, windowEnd, WINDOWS, type Deps, type WindowParams } from "../../src/web/activity-live.js";
import { actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, stepper, trackPhases, type Emit } from "../../src/web/live.js";
import type { View } from "../../src/web/view.js";

export { parseWindow as parseRun };

const CATEGORIES = ["transfer-in", "transfer-out", "swap", "approval", "contract-call"] as const;

export function viewOf(a: Activity, p: WindowParams, md: string): View {
  const c = a.coverage;
  const count = (cat: string) => a.items.filter((i) => i.category === cat).length;
  const txs = new Set(a.items.map((i) => i.tx)).size;
  const notable = notableTxs(a);
  const sentLine = c.sentExpected === null ? "the chain's nonce could not be read" : `${c.sentFound} of ${c.sentExpected} sent transactions matched by the chain's nonce`;
  return {
    tone: c.sentExpected !== null && c.sentFound < c.sentExpected ? "warn" : "ok",
    verdict: `${txs} transaction${txs === 1 ? "" : "s"} in ${p.blocks.toLocaleString()} blocks`,
    note: `Blocks ${a.range.fromBlock}–${a.range.toBlock} on ${p.network === "pharos" ? "Pharos mainnet" : "Pharos Atlantic"}. Completeness: ${sentLine}. Incoming native transfers are invisible to the logs (see the report's Coverage section).`,
    tables: [
      { head: ["Category", "Items"], rows: CATEGORIES.map((k) => [k, String(count(k))]) },
      ...(notable.length ? [{ head: ["Notable transaction", "Why"], rows: notable.map((n) => [{ t: `${n.tx.slice(0, 10)}…${n.tx.slice(-4)}`, href: explorerTx(p.network, n.tx) }, n.why]) }] : []),
      ...(a.items.length ? [{ head: ["Transaction", "Category", "Status", "What"], rows: a.items.slice(0, 15).map((i) => [{ t: `${i.tx.slice(0, 10)}…`, href: explorerTx(p.network, i.tx) }, i.category, i.status, [...i.out, ...i.in].map(fmtLeg).join(" · ") || i.method || "—"]) }] : []),
    ],
    text: md,
    download: { name: `audit-${p.wallet.slice(0, 8).toLowerCase()}-${a.range.fromBlock}-${a.range.toBlock}.md`, text: md },
    evidence: [
      ["Wallet", p.wallet],
      ["Window", `${p.blocks.toLocaleString()} blocks ending at block ${a.range.toBlock}${p.toBlock !== undefined ? " (a pinned sample)" : " (the head read first)"}`],
      ["Log reads", `${c.logsRead} matching logs over ${c.logWindows} get_logs windows`],
      ["Completeness", sentLine],
    ],
    summary: `${a.items.length} item${a.items.length === 1 ? "" : "s"} in ${txs} transaction${txs === 1 ? "" : "s"}; ${sentLine}.`,
  };
}

export async function run(p: WindowParams, emit: Emit, deps: Deps = defaultDeps): Promise<void> {
  const t0 = Date.now();
  const conn = await deps.connect(p.network);
  emit({ type: "start", network: p.network, wallet: p.wallet, blocks: p.blocks, endpoint: conn.endpoint });
  const t = trackPhases(conn.call, emit, (tool) => activityPhase(tool), activityLabel);
  try {
    const head = BigInt((await t.call("get_block_number")).blockNumber);
    const end = windowEnd(p, head);
    const range = { fromBlock: end - BigInt(p.blocks) + 1n < 0n ? 0n : end - BigInt(p.blocks) + 1n, toBlock: end };
    const activity = await collectActivity(t.call, p.network, p.wallet, range, { scanBlocks: 0, maxTxs: 100, maxDiscoverCalls: 60 });
    t.finish();
    const s = stepper(emit);
    s.begin("report");
    const md = markdownReport(activity, { generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
    s.end("report", "ok", `${activity.items.length} items`);
    emit({ type: "done", totalMs: Date.now() - t0, reads: t.total(), view: viewOf(activity, p, md) });
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
    if (action === "info") return json({ task: "audit-log-agent", windows: WINDOWS, reads: { pharos: "hosted Chain MCP", atlantic: "public Atlantic RPC" }, deploy: deployInfo() });
    const p = parseWindow(url);
    if (!gate.take()) return busy();
    return ndjson((emit) => run(p, emit, deps), gate.release);
  });
}
