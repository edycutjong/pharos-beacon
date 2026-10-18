import { formatEther, formatGwei, formatUnits, getAddress, isAddress, type Hex } from "viem";
import { readState, writeState } from "../lib/state.js";
import type { ChainMcp, Network } from "../lib/mcp.js";
import { atlantic, pharos } from "../lib/networks.js";

// A watcher with memory. Each run reads ONE observation of a metric at a pinned block, stores it, and acts only when the
// stored history shows a trend: `steps` consecutive moves in one direction. The history is the single source of truth
// (the trigger points are recomputed from it), so a restart can neither lose an observation nor trigger twice.

export type MetricSpec =
  | { kind: "balance"; network: Network; address: Hex }
  | { kind: "supply"; network: Network; token: Hex; decimals: number }
  | { kind: "basefee"; network: Network };

export interface Observation {
  block: string; // the block the value was read AT (decimal); the dedupe key
  value: string; // decimal string of a bigint, in the metric's base unit
  at: string; // ISO time of the read
}
export interface TrendState {
  metric: MetricSpec;
  observations: Observation[]; // strictly increasing by block
  acted: string[]; // trigger blocks whose action has been taken
}
export interface Rule {
  direction: "fall" | "rise";
  steps: number; // consecutive moves; steps + 1 observations are needed, so at least 3
}
export const MAX_OBSERVATIONS = 1000;
export const MIN_STEPS = 2;

export function parseMetric(m: { metric: string; network: Network; address?: string; token?: string; decimals?: number }): MetricSpec {
  if (m.metric === "balance") {
    if (!m.address || !isAddress(m.address)) throw new Error("--metric balance needs --address 0x…");
    return { kind: "balance", network: m.network, address: getAddress(m.address) };
  }
  if (m.metric === "supply") {
    if (!m.token || !isAddress(m.token)) throw new Error("--metric supply needs --token 0x… (an ERC-20)");
    return { kind: "supply", network: m.network, token: getAddress(m.token), decimals: m.decimals ?? 18 };
  }
  if (m.metric === "basefee") return { kind: "basefee", network: m.network };
  throw new Error(`unknown metric ${m.metric}: use balance, supply or basefee`);
}

export const describeMetric = (s: MetricSpec): string =>
  s.kind === "balance" ? `native balance of ${s.address} on ${s.network}` : s.kind === "supply" ? `totalSupply of ${s.token} on ${s.network}` : `base fee on ${s.network}`;

export function fmt(s: MetricSpec, v: bigint): string {
  if (s.kind === "balance") return `${formatEther(v)} ${(s.network === "pharos" ? pharos : atlantic).nativeCurrency.symbol}`; // PROS on mainnet, PHRS on Atlantic
  if (s.kind === "basefee") return `${formatGwei(v)} gwei`;
  return `${formatUnits(v, s.decimals)}`;
}

type Call = ChainMcp["call"];

/** One reading. The value is read AT the block number it is stored under, so the pair is always consistent. */
export async function readMetric(call: Call, spec: MetricSpec, pinBlock?: bigint, now: () => Date = () => new Date()): Promise<Observation> {
  const block = pinBlock ?? BigInt((await call("get_block_number")).blockNumber);
  const tag = block.toString();
  let value: bigint;
  if (spec.kind === "balance") value = BigInt((await call("get_balance", { address: spec.address, block: tag })).balanceWei);
  else if (spec.kind === "supply") {
    const r = await call("eth_call", { transaction: { to: spec.token, data: "0x18160ddd" }, block: tag });
    if (!/^0x[0-9a-fA-F]{64}$/.test(r.result)) throw new Error(`totalSupply() of ${spec.token} did not return a uint256 (got ${r.result.slice(0, 20)}): not an ERC-20?`);
    value = BigInt(r.result);
  } else {
    const b = await call("get_block", { block: tag });
    if (!b?.baseFeePerGas) throw new Error(`block ${tag} has no base fee`);
    value = BigInt(b.baseFeePerGas);
  }
  return { block: tag, value: value.toString(), at: now().toISOString() };
}

const sameMetric = (a: MetricSpec, b: MetricSpec) => JSON.stringify(a) === JSON.stringify(b);

function check(file: string, spec: MetricSpec) {
  return (v: unknown): TrendState => {
    const s = v as TrendState;
    const ok = s && s.metric && Array.isArray(s.observations) && Array.isArray(s.acted) &&
      s.observations.every((o, i, a) => /^\d+$/.test(String(o?.block)) && /^\d+$/.test(String(o?.value)) && typeof o?.at === "string" && (i === 0 || BigInt(a[i - 1]!.block) < BigInt(o.block)));
    if (!ok) throw new Error(`${file}: trend state has the wrong shape (or blocks out of order); refusing to guess (fix or remove it)`);
    if (!sameMetric(s.metric, spec)) throw new Error(`${file} holds history of a different metric (${describeMetric(s.metric)}); use another --state file`);
    return s;
  };
}
export const loadTrend = (file: string, spec: MetricSpec): TrendState => readState<TrendState>(file, { metric: spec, observations: [], acted: [] }, check(file, spec));

export type Added = "added" | "duplicate" | "stale";
/** Append by block number. The same block is stored once; a block older than the newest stored one is refused. */
export function addObservation(st: TrendState, o: Observation): { state: TrendState; status: Added } {
  const last = st.observations.at(-1);
  if (last) {
    if (BigInt(o.block) === BigInt(last.block)) return { state: st, status: "duplicate" };
    if (BigInt(o.block) < BigInt(last.block)) return { state: st, status: "stale" };
  }
  return { state: { ...st, observations: [...st.observations, o].slice(-MAX_OBSERVATIONS) }, status: "added" };
}
export const saveTrend = (file: string, st: TrendState): void => writeState(file, st);

export interface Evaluation {
  streak: number; // consecutive moves in the rule's direction ending at the newest observation
  triggers: number[]; // indexes (into observations) where the streak first reached `steps`
  state: "triggered" | "building" | "none" | "too-few";
}
const moves = (a: bigint, b: bigint, dir: Rule["direction"]) => (dir === "fall" ? b < a : b > a);

export function evaluate(obs: Observation[], rule: Rule): Evaluation {
  if (rule.steps < MIN_STEPS) throw new Error(`a trend needs at least ${MIN_STEPS + 1} observations: --steps must be ≥ ${MIN_STEPS}`);
  let streak = 0;
  const triggers: number[] = [];
  for (let i = 1; i < obs.length; i++) {
    streak = moves(BigInt(obs[i - 1]!.value), BigInt(obs[i]!.value), rule.direction) ? streak + 1 : 0;
    if (streak === rule.steps) triggers.push(i);
  }
  const state = obs.length < rule.steps + 1 ? "too-few" : streak >= rule.steps ? "triggered" : streak > 0 ? "building" : "none";
  return { streak, triggers, state };
}

const BARS = "▁▂▃▄▅▆▇█";
export function sparkline(values: bigint[]): string {
  if (!values.length) return "";
  const min = values.reduce((a, b) => (b < a ? b : a)), max = values.reduce((a, b) => (b > a ? b : a));
  if (min === max) return BARS[0]!.repeat(values.length);
  return values.map((v) => BARS[Number(((v - min) * 7n) / (max - min))]).join("");
}

export interface Slope {
  perObservation: bigint;
  perBlock: bigint;
  total: bigint;
  observations: number;
  blocks: bigint;
}
/** The slope over the `steps` moves that ended at observation `index`. */
export function slopeAt(obs: Observation[], index: number, steps: number): Slope {
  const a = obs[index - steps]!, b = obs[index]!;
  const total = BigInt(b.value) - BigInt(a.value);
  const blocks = BigInt(b.block) - BigInt(a.block);
  return { total, observations: steps, blocks, perObservation: total / BigInt(steps), perBlock: total / blocks };
}
const signed = (spec: MetricSpec, v: bigint) => `${v > 0n ? "+" : ""}${fmt(spec, v)}`;
export const describeSlope = (spec: MetricSpec, s: Slope) =>
  `slope ${signed(spec, s.perObservation)} per observation, ${signed(spec, s.perBlock)} per block (${signed(spec, s.total)} over ${s.observations} observations, ${s.blocks} blocks)`;

export function historyTable(spec: MetricSpec, obs: Observation[], rule: Rule, last = 12): string {
  if (!obs.length) return "no observations yet";
  const ev = evaluate(obs, rule);
  const from = Math.max(0, obs.length - last);
  const lines = [`history: ${describeMetric(spec)} · ${obs.length} observations, showing ${obs.length - from} · rule: ${rule.steps} consecutive ${rule.direction}s`];
  let streak = 0;
  for (let i = 0; i < obs.length; i++) {
    const delta = i ? BigInt(obs[i]!.value) - BigInt(obs[i - 1]!.value) : 0n;
    streak = i && moves(BigInt(obs[i - 1]!.value), BigInt(obs[i]!.value), rule.direction) ? streak + 1 : 0;
    if (i < from) continue;
    const mark = !i ? "start" : delta === 0n ? "flat" : delta < 0n ? "fall" : "rise";
    lines.push(`  #${String(i + 1).padEnd(3)} block ${obs[i]!.block.padEnd(9)} ${fmt(spec, BigInt(obs[i]!.value)).padEnd(26)} ${mark.padEnd(5)} streak ${streak}${ev.triggers.includes(i) ? `   ◀ TREND MET: ${rule.steps} consecutive ${rule.direction}s` : ""}`);
  }
  lines.push(`trend: ${sparkline(obs.slice(from).map((o) => BigInt(o.value)))}   (${ev.state}, current streak ${ev.streak}/${rule.steps})`);
  return lines.join("\n");
}

export function triggerMessage(spec: MetricSpec, obs: Observation[], index: number, rule: Rule): string {
  const o = obs[index]!;
  return `TREND MET: ${describeMetric(spec)} — ${rule.steps} consecutive ${rule.direction}s at observation #${index + 1} (block ${o.block}, ${o.at}). ` +
    `${sparkline(obs.slice(index - rule.steps).map((x) => BigInt(x.value)))} ${describeSlope(spec, slopeAt(obs, index, rule.steps))}`;
}

export interface ObserveResult {
  added: Added;
  observation: Observation;
  evaluation: Evaluation;
  acted: number[]; // trigger indexes the action ran for in this run
  state: TrendState;
}
/**
 * Read → store → evaluate → act. `act` runs for every trigger not yet acted on (also one a crashed run left behind) and a
 * trigger is marked acted only after `act` returned, so a crash between the two repeats one alert but never loses it.
 */
export async function observe(opts: {
  file: string; spec: MetricSpec; rule: Rule; call: Call; pinBlock?: bigint;
  act: (message: string, index: number) => Promise<void>; now?: () => Date;
}): Promise<ObserveResult> {
  const { file, spec, rule } = opts;
  evaluate([], rule);
  let st = loadTrend(file, spec);
  const observation = await readMetric(opts.call, spec, opts.pinBlock, opts.now);
  const r = addObservation(st, observation);
  st = r.state;
  if (r.status === "added") saveTrend(file, st);
  const evaluation = evaluate(st.observations, rule);
  const acted: number[] = [];
  for (const i of evaluation.triggers) {
    if (st.acted.includes(st.observations[i]!.block)) continue;
    await opts.act(triggerMessage(spec, st.observations, i, rule), i);
    st = { ...st, acted: [...st.acted, st.observations[i]!.block] };
    saveTrend(file, st);
    acted.push(i);
  }
  return { added: r.status, observation, evaluation, acted, state: st };
}
