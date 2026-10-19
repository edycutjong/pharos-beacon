// Live demo endpoint for the Batch Executor (api/batch-executor.ts). Read-only: it runs the CLI's own runBatch
// (src/batch/batch.ts) with execute off, so the batch is simulated (one eth_call of Multicall3.aggregate3Value plus
// estimate_gas of the batch and of each action alone) and nothing is signed or sent. Atlantic reads go through the public
// Atlantic RPC (the Atlantic Chain MCP runs locally over stdio, not on Vercel).
//   GET ?action=info
//   GET ?action=simulate&plan=one-fails|all-success-mix[&from=0x…][&drop=1]                         NDJSON
//   GET ?action=simulate&plan=custom&actions=<JSON list of actions>[&from=0x…][&drop=1]              NDJSON
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, type Hex } from "viem";
import type { ChainMcp } from "../../src/lib/mcp.js";
import { MULTICALL3, PlanError, pct, resolveActions, runBatch, type Action } from "../../src/batch/batch.js";
import { atlanticRpcCall } from "../../src/web/atlantic-rpc.js";
import { InputError, actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, pinnedJson, stepper, trackPhases, type Emit } from "../../src/web/live.js";

export const PLANS = ["one-fails", "all-success-mix"] as const;
/** The wallet the recorded runs sent from (wallet 1). A simulation needs a sender; no key is involved. */
export const DEFAULT_FROM = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975";
export const MAX_ACTIONS = 8;

type Call = ChainMcp["call"];
export interface Deps {
  call: () => Call;
  fetch?: typeof fetch;
}
const defaultDeps: Deps = { call: () => atlanticRpcCall() };

export interface SimParams {
  plan: (typeof PLANS)[number] | "custom";
  specs?: unknown[];
  from: Hex;
  drop: boolean;
}

export function parseSim(url: URL): SimParams {
  const q = url.searchParams;
  const plan = q.get("plan") ?? "one-fails";
  if (plan !== "custom" && !(PLANS as readonly string[]).includes(plan)) throw new InputError(`plan must be one of ${PLANS.join(", ")}, or custom`);
  const f = (q.get("from") || DEFAULT_FROM).trim();
  if (!isAddress(f, { strict: false })) throw new InputError("from must be a 0x address");
  const drop = q.get("drop") === "1" || q.get("drop") === "true";
  let specs: unknown[] | undefined;
  if (plan === "custom") {
    const raw = q.get("actions") ?? "";
    if (raw.length > 4000) throw new InputError("actions is too long (4,000 characters at most)");
    let v: unknown;
    try { v = JSON.parse(raw); } catch { throw new InputError("actions must be a JSON list, e.g. [{\"type\":\"native\",\"to\":\"0x…\",\"value\":\"0.0001\"}, …]"); }
    if (!Array.isArray(v)) throw new InputError("actions must be a JSON list");
    if (v.length > MAX_ACTIONS) throw new InputError(`at most ${MAX_ACTIONS} actions per simulation on this page`);
    specs = v;
    try { resolveActions(specs, getAddress(f)); } catch (e) { if (e instanceof PlanError) throw new InputError(e.message); throw e; }
  }
  return { plan: plan as SimParams["plan"], ...(specs ? { specs } : {}), from: getAddress(f), drop };
}

/** Phases of simulateBatch's tool calls: block + gas price, the batch eth_call, each action alone, the batch's own estimate. */
const batchPhase = (tool: string, args: Record<string, unknown>): string => {
  if (tool === "eth_call") return "batch-call";
  if (tool === "estimate_gas") return String((args.transaction as { to?: string })?.to ?? "").toLowerCase() === MULTICALL3.toLowerCase() ? "batch-gas" : "alone";
  if (tool === "get_balance") return "batch-call";
  return "prep";
};
const batchLabel = (p: string, n: number) =>
  p === "prep" ? "block, base fee, tip" : p === "batch-call" ? "aggregate3Value eth_call" : p === "alone" ? `${n} estimate_gas, one per action` : "batch estimate_gas";

const actionJson = (a: Action) => ({ n: a.index + 1, label: a.label, asset: a.watch.asset, to: a.watch.holder, amount: formatUnits(a.watch.amount, a.watch.decimals) });

export async function simulate(p: SimParams, emit: Emit, deps: Deps = defaultDeps): Promise<void> {
  const t0 = Date.now();
  const s = stepper(emit);
  const call = deps.call();

  s.begin("plan");
  const specs = p.specs ?? (await pinnedJson<{ actions?: unknown }>(`tasks/batch-executor/plans/${p.plan}.json`, deps.fetch)).actions;
  const actions = resolveActions(specs, p.from);
  s.end("plan", "ok", `${actions.length} actions · ${p.plan === "custom" ? "typed on the page" : `plans/${p.plan}.json`}`);
  emit({ type: "start", plan: p.plan, from: p.from, drop: p.drop, multicall3: MULTICALL3, actions: actions.map(actionJson) });

  // What the token actions depend on: Multicall3 moves the tokens with transferFrom, so it needs an allowance from the sender.
  s.begin("allowance");
  const tokens = new Map<string, { asset: string; token: Hex; need: bigint; decimals: number }>();
  for (const a of actions) if (a.watch.token) {
    const k = a.watch.token.toLowerCase();
    tokens.set(k, { asset: a.watch.asset, token: a.watch.token, decimals: a.watch.decimals, need: (tokens.get(k)?.need ?? 0n) + a.watch.amount });
  }
  const allowances = [];
  for (const t of tokens.values()) {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [p.from, MULTICALL3] });
    const have = BigInt((await call("eth_call", { transaction: { to: t.token, data } })).result);
    allowances.push({ asset: t.asset, allowance: formatUnits(have, t.decimals), needed: formatUnits(t.need, t.decimals), enough: have >= t.need });
  }
  const short = allowances.filter((x) => !x.enough).length;
  s.end("allowance", tokens.size === 0 ? "skip" : short ? "refused" : "ok", tokens.size === 0 ? "no token actions" : short ? `${short} of ${tokens.size} token allowance${tokens.size === 1 ? "" : "s"} too low` : `${tokens.size} allowance${tokens.size === 1 ? "" : "s"} cover the plan`);

  const t = trackPhases(call, emit, batchPhase, batchLabel);
  let r;
  try {
    r = await runBatch(t.call, p.from, actions, { execute: false, dropFailing: p.drop });
    t.finish();
  } catch (e) {
    t.finish(e as Error);
    throw e;
  }
  const sim = r.sim;
  s.begin("verdict");
  const comparable = sim.actions.filter((a) => a.aloneGas !== undefined);
  const alone = comparable.reduce((x, a) => x + a.aloneGas!, 0n);
  const failing = sim.actions.filter((a) => !a.ok).length;
  // Like for like only: when an action would fail inside the batch, the batch's estimate is not the cost of doing that action.
  const comparison = sim.batchGas !== undefined && comparable.length && failing === 0
    ? { comparable: comparable.length, aloneGas: alone.toString(), batchGas: sim.batchGas.toString(), saved: (alone - sim.batchGas).toString(), pct: pct(alone - sim.batchGas, alone), steps: { alone: comparable.length, batch: 1 } }
    : null;
  s.end("verdict", r.status === "blocked" ? "refused" : "ok", r.status === "blocked" ? "BLOCKED: nothing would be sent" : `would send 1 tx · ${sim.actions.length - failing} of ${sim.actions.length} would apply`);
  emit({
    type: "done", totalMs: Date.now() - t0, status: r.status, blockReason: r.blockReason ?? null, block: sim.block, gasPriceWei: sim.gasPriceWei.toString(),
    batchFailure: sim.batchFailure ?? null, batchGas: sim.batchGas?.toString() ?? null, allowances, comparison, reads: t.total(),
    sim: sim.actions.map((a) => ({ ...actionJson(a.action), ok: a.ok, failure: a.failure ?? null, aloneGas: a.aloneGas?.toString() ?? null, aloneFailure: a.aloneFailure ?? null })),
    dropped: r.dropped,
  });
}

const gate = concurrencyGate(2);

export function handle(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  return guard(async () => {
    const url = new URL(req.url);
    const action = actionOf(url, ["info", "simulate"] as const, "info");
    if (action === "info") return json({ task: "batch-executor", network: "atlantic", multicall3: MULTICALL3, plans: PLANS, defaultFrom: DEFAULT_FROM, maxActions: MAX_ACTIONS, reads: "public Atlantic RPC (simulation only; nothing is signed)", deploy: deployInfo() });
    const p = parseSim(url);
    if (!gate.take()) return busy();
    return ndjson((emit) => simulate(p, emit, deps), gate.release);
  });
}
