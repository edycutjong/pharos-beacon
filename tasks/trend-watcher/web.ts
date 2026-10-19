// Live demo endpoint for the Trend Watcher (api/trend-watcher.ts). Read-only and stateless: the page cannot keep the CLI's
// history file, so it does two honest things instead.
//   replay: re-read, live, every observation of a committed history file (state/*.json at the pinned commit) at its own block,
//           check each value against the stored one, and evaluate the rule on the re-read series with the CLI's evaluate().
//   sample: read the metric now at N+1 blocks spaced `gap` apart, ending at the head, and evaluate the same rule.
//   GET ?action=info
//   GET ?action=run&mode=replay&history=mainnet|spike|first[&steps=3&direction=fall]                NDJSON
//   GET ?action=run&mode=sample&metric=balance|basefee[&address=0x…][&gap=100][&steps=3&direction=fall]  NDJSON
// Mainnet reads go through the hosted Chain MCP; Atlantic reads through the public Atlantic RPC (the Atlantic Chain MCP runs locally).
import { getAddress, isAddress, type Hex } from "viem";
import { chainMcp, type ChainMcp, type Network } from "../../src/lib/mcp.js";
import { MIN_STEPS, describeMetric, evaluate, fmt, historyTable, readMetric, sparkline, triggerMessage, type MetricSpec, type Observation, type Rule, type TrendState } from "../../src/trend/watch.js";
import { atlanticRpcCall } from "../../src/web/atlantic-rpc.js";
import { InputError, actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, pinnedJson, stepper, type Emit } from "../../src/web/live.js";

export const HISTORIES = {
  mainnet: "tasks/trend-watcher/state/mainnet-balance.json",
  spike: "tasks/trend-watcher/state/big-spike.json",
  first: "tasks/trend-watcher/state/history.json",
} as const;
export const GAPS = [10, 100, 1000] as const;
export const MAX_STEPS = 6;
/** The mainnet wallet the README's mainnet trend reads (it pays gas all day, so its balance moves). */
export const DEFAULT_ADDRESS = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";

type Call = ChainMcp["call"];
export interface Conn {
  call: Call;
  endpoint: string;
  close(): Promise<void>;
}
export interface Deps {
  connect: (network: Network) => Promise<Conn>;
  fetch?: typeof fetch;
  now?: () => Date;
}
const defaultDeps: Deps = {
  connect: async (network) => {
    if (network === "atlantic") return { call: atlanticRpcCall(), endpoint: "public Atlantic RPC https://atlantic.dplabs-internal.com", close: async () => {} };
    const m = await chainMcp("pharos", { timeoutMs: 20_000 });
    return { call: m.call, endpoint: `hosted Chain MCP ${m.endpoint}`, close: () => m.close() };
  },
};

export type RunParams =
  | { mode: "replay"; history: keyof typeof HISTORIES; rule: Rule }
  | { mode: "sample"; spec: MetricSpec; gap: number; rule: Rule };

export function parseRun(url: URL): RunParams {
  const q = url.searchParams;
  const steps = Number(q.get("steps") ?? 3);
  if (!Number.isInteger(steps) || steps < MIN_STEPS || steps > MAX_STEPS) throw new InputError(`steps must be a whole number from ${MIN_STEPS} to ${MAX_STEPS} (a trend needs steps + 1 observations)`);
  const direction = q.get("direction") ?? "fall";
  if (direction !== "fall" && direction !== "rise") throw new InputError('direction must be "fall" or "rise"');
  const rule: Rule = { steps, direction };
  const mode = q.get("mode") ?? "replay";
  if (mode === "replay") {
    const history = q.get("history") ?? "mainnet";
    if (!(history in HISTORIES)) throw new InputError(`history must be one of ${Object.keys(HISTORIES).join(", ")}`);
    return { mode, history: history as keyof typeof HISTORIES, rule };
  }
  if (mode !== "sample") throw new InputError('mode must be "replay" or "sample"');
  const gap = Number(q.get("gap") ?? 100);
  if (!(GAPS as readonly number[]).includes(gap)) throw new InputError(`gap must be one of ${GAPS.join(", ")} blocks`);
  const metric = q.get("metric") ?? "balance";
  let spec: MetricSpec;
  if (metric === "balance") {
    const a = (q.get("address") || DEFAULT_ADDRESS).trim();
    if (!isAddress(a, { strict: false })) throw new InputError("address must be a 0x address");
    spec = { kind: "balance", network: "pharos", address: getAddress(a) as Hex };
  } else if (metric === "basefee") spec = { kind: "basefee", network: "pharos" };
  else throw new InputError('metric must be "balance" or "basefee" (mainnet)');
  return { mode, spec, gap, rule };
}

export async function run(p: RunParams, emit: Emit, deps: Deps = defaultDeps): Promise<void> {
  const t0 = Date.now();
  const s = stepper(emit);
  let spec: MetricSpec;
  let stored: Observation[] | undefined;
  let source: string;
  if (p.mode === "replay") {
    const st = await pinnedJson<TrendState>(HISTORIES[p.history], deps.fetch);
    if (!st?.metric || !Array.isArray(st.observations) || st.observations.length < 1) throw new Error(`${HISTORIES[p.history]} is not a trend history`);
    spec = st.metric;
    stored = st.observations;
    source = HISTORIES[p.history];
  } else {
    spec = p.spec;
    source = "live sample";
  }
  const conn = await deps.connect(spec.network);
  try {
    let blocks: bigint[];
    if (stored) blocks = stored.map((o) => BigInt(o.block));
    else {
      const head = BigInt((await conn.call("get_block_number")).blockNumber);
      blocks = Array.from({ length: p.rule.steps + 1 }, (_, i) => head - BigInt((p.rule.steps - i) * (p as { gap: number }).gap));
    }
    emit({ type: "start", mode: p.mode, metric: describeMetric(spec), spec, network: spec.network, endpoint: conn.endpoint, rule: p.rule, source, blocks: blocks.map(String) });
    const series: Observation[] = [];
    const checks: { block: string; value: string; stored?: string; matches?: boolean }[] = [];
    for (const [i, b] of blocks.entries()) {
      const id = `obs-${i + 1}`;
      s.begin(id);
      const o = await readMetric(conn.call, spec, b, deps.now);
      const kept = stored ? { ...o, at: stored[i]!.at } : o; // a replay keeps the time the observation was first taken
      series.push(kept);
      const prev = series[i - 1];
      const move = !prev ? "start" : BigInt(o.value) === BigInt(prev.value) ? "flat" : BigInt(o.value) < BigInt(prev.value) ? "fall" : "rise";
      const matches = stored ? stored[i]!.value === o.value : undefined;
      checks.push({ block: o.block, value: fmt(spec, BigInt(o.value)), ...(stored ? { stored: fmt(spec, BigInt(stored[i]!.value)), matches } : {}) });
      s.end(id, matches === false ? "failed" : "ok", `${move} · ${fmt(spec, BigInt(o.value))}`, { block: o.block, move, ...(stored ? { matches } : {}) });
    }
    s.begin("evaluate");
    const ev = evaluate(series, p.rule);
    const first = ev.triggers[0];
    const label = ev.state === "too-few" ? `too few: ${series.length} of ${p.rule.steps + 1}` : first !== undefined ? `TREND MET at #${first + 1}` : `no trigger · streak ${ev.streak} of ${p.rule.steps}`;
    s.end("evaluate", first !== undefined ? "ok" : "refused", label);
    emit({
      type: "done", totalMs: Date.now() - t0, evaluation: ev, sparkline: sparkline(series.map((o) => BigInt(o.value))),
      table: historyTable(spec, series, p.rule, 12), observations: checks,
      allMatch: stored ? checks.every((c) => c.matches) : null,
      alerts: ev.triggers.map((i) => ({ index: i + 1, block: series[i]!.block, message: triggerMessage(spec, series, i, p.rule) })),
    });
  } finally {
    await conn.close().catch(() => {});
  }
}

const gate = concurrencyGate(2);

export function handle(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  return guard(async () => {
    const url = new URL(req.url);
    const action = actionOf(url, ["info", "run"] as const, "info");
    if (action === "info") {
      return json({ task: "trend-watcher", histories: HISTORIES, limits: { steps: [MIN_STEPS, MAX_STEPS], gaps: GAPS }, defaultAddress: DEFAULT_ADDRESS, deploy: deployInfo() });
    }
    const p = parseRun(url);
    if (!gate.take()) return busy();
    return ndjson((emit) => run(p, emit, deps), gate.release);
  });
}
