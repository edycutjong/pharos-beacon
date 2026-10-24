// Live demo endpoint for the Weekly Digest Agent (api/router.ts → this file). Read-only: it runs the CLI's own collectActivity,
// metricsOf, compare and topEvents on the last N blocks of a wallet against the N blocks before them. It never sends a Discord
// message and never signs. The CLI works in calendar periods (weekly/daily/monthly/Nd) on a schedule; this page uses block windows
// so one request stays inside the function time and the RPC rate limits.
//   GET ?action=info
//   GET ?action=run&wallet=0x…[&network=pharos|atlantic][&blocks=1000|5000|10000|30000][&toBlock=N]   NDJSON (steps, then one "done" line with a View)
import { collectActivity } from "../../src/activity/engine.js";
import { CRON, compare, metricsOf, topEvents } from "../../src/activity/digest.js";
import { explorerTx } from "../../src/lib/networks.js";
import { activityLabel, activityPhase, defaultDeps, parseWindow, windowEnd, WINDOWS, type Deps, type WindowParams } from "../../src/web/activity-live.js";
import { actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, stepper, trackPhases, type Emit } from "../../src/web/live.js";
import type { View } from "../../src/web/view.js";

export { parseWindow as parseRun };

export async function run(p: WindowParams, emit: Emit, deps: Deps = defaultDeps): Promise<void> {
  const t0 = Date.now();
  const conn = await deps.connect(p.network);
  emit({ type: "start", network: p.network, wallet: p.wallet, blocks: p.blocks, endpoint: conn.endpoint });
  const t = trackPhases(conn.call, emit, (tool) => activityPhase(tool), activityLabel);
  try {
    const head = BigInt((await t.call("get_block_number")).blockNumber);
    const n = BigInt(p.blocks);
    const end = windowEnd(p, head);
    if (end < 2n * n) throw new Error(`the chain has only ${end} blocks: not enough for two windows of ${p.blocks}`);
    const cur = { fromBlock: end - n + 1n, toBlock: end };
    const prev = { fromBlock: end - 2n * n + 1n, toBlock: end - n };
    const opts = { scanBlocks: 0, maxTxs: 100, maxDiscoverCalls: 60 };
    const activity = await collectActivity(t.call, p.network, p.wallet, cur, opts);
    const previousActivity = await collectActivity(t.call, p.network, p.wallet, prev, { ...opts, discoverSent: false });
    t.finish();
    const s = stepper(emit);
    s.begin("digest");
    const metrics = metricsOf(activity, `blocks ${cur.fromBlock}–${cur.toBlock}`);
    const previous = metricsOf(previousActivity, `blocks ${prev.fromBlock}–${prev.toBlock}`);
    const events = topEvents(activity, previous);
    const rows = compare(metrics, previous, activity.nativeSymbol);
    s.end("digest", "ok", `${events.length} highlight${events.length === 1 ? "" : "s"}`);
    const view: View = {
      tone: "ok",
      verdict: `${metrics.txs} transaction${metrics.txs === 1 ? "" : "s"} now, ${previous.txs} before`,
      note: `Digest of the last ${p.blocks.toLocaleString()} blocks against the ${p.blocks.toLocaleString()} blocks before them. The CLI builds the same digest for a calendar week on a schedule and posts it to Discord; this page sends nothing.`,
      tables: [
        { head: ["Metric", "This period", "Previous", "Change"], rows: rows.map((r) => [r.metric, r.current, r.previous, r.change]) },
        { head: ["#", "Top notable events", "Transaction"], rows: events.length ? events.map((e, i) => [String(i + 1), `${e.kind}: ${e.why}`, { t: `${e.tx.slice(0, 10)}…`, href: explorerTx(p.network, e.tx) }]) : [["—", "No activity to rank", "—"]] },
      ],
      evidence: [
        ["Wallet", p.wallet],
        ["This period", `blocks ${cur.fromBlock}–${cur.toBlock}`],
        ["Previous", `blocks ${prev.fromBlock}–${prev.toBlock}`],
        ["Schedule (CLI)", `weekly = cron "${CRON.weekly}" (UTC); daily "${CRON.daily}"; monthly "${CRON.monthly}"`],
      ],
      summary: `${events.length} highlight${events.length === 1 ? "" : "s"}; ${metrics.txs} transactions against ${previous.txs} in the window before.`,
    };
    emit({ type: "done", totalMs: Date.now() - t0, reads: t.total(), view });
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
    if (action === "info") return json({ task: "weekly-digest-agent", windows: WINDOWS, cron: CRON, reads: { pharos: "hosted Chain MCP", atlantic: "public Atlantic RPC" }, deploy: deployInfo() });
    const p = parseWindow(url);
    if (!gate.take()) return busy();
    return ndjson((emit) => run(p, emit, deps), gate.release);
  });
}
