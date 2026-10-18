import { formatGwei } from "viem";
import { readState, writeState } from "../lib/state.js";
import type { Call } from "../dryrun/simulate.js";

// Gas price tracking and the hold-until-cheap loop. The price is what a transaction actually pays per gas: the latest
// block's base fee plus the node's priority fee (get_block + get_gas_price through the Chain MCP). The loop NEVER outlives
// its deadline: the send happens at the deadline whatever the price, and even when sampling itself is failing.

export interface Sample {
  at: string; // ISO time of the read
  block: string;
  baseFeeWei: string;
  priorityWei: string;
  priceWei: string; // base + priority
}
export interface GasState {
  samples: Sample[];
}
export const MAX_SAMPLES = 500;

export async function takeSample(call: Call, now: () => Date = () => new Date()): Promise<Sample> {
  const [block, price] = await Promise.all([call("get_block", { block: "latest" }), call("get_gas_price")]);
  if (!block?.baseFeePerGas) throw new Error("the latest block has no base fee");
  const base = BigInt(block.baseFeePerGas);
  const priority = BigInt(price.maxPriorityFeePerGasWei);
  return { at: now().toISOString(), block: BigInt(block.number ?? 0).toString(), baseFeeWei: base.toString(), priorityWei: priority.toString(), priceWei: (base + priority).toString() };
}

const checkState = (v: unknown): GasState => {
  const s = v as GasState;
  if (!s || !Array.isArray(s.samples) || !s.samples.every((x) => typeof x?.at === "string" && /^\d+$/.test(String(x?.priceWei))))
    throw new Error("gas state file has the wrong shape; refusing to guess (fix or remove it)");
  return s;
};
export const loadSamples = (file: string): Sample[] => readState<GasState>(file, { samples: [] }, checkState).samples;
export function saveSample(file: string, s: Sample): Sample[] {
  const samples = [...loadSamples(file), s].slice(-MAX_SAMPLES);
  writeState(file, { samples });
  return samples;
}

/** Nearest-rank percentile (p in 1..100) of the sample prices. */
export function percentilePrice(samples: Sample[], p: number): bigint {
  if (samples.length === 0) throw new Error("no samples");
  const sorted = samples.map((s) => BigInt(s.priceWei)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export type Target = { kind: "price"; wei: bigint } | { kind: "percentile"; p: number; window: number; /** history needed before the percentile means anything (default 5) */ minSamples?: number };

/** The price to beat, or null while a percentile target has too little history (one sample is always its own p25, so it would send at once). */
export function resolveTarget(t: Target, samples: Sample[]): bigint | null {
  if (t.kind === "price") return t.wei;
  const recent = samples.slice(-t.window);
  return recent.length < (t.minSamples ?? 5) ? null : percentilePrice(recent, t.p);
}

export function historyTable(samples: Sample[], n = 10): string {
  const rows = samples.slice(-n);
  if (rows.length === 0) return "no samples yet";
  const prices = samples.map((s) => BigInt(s.priceWei));
  const min = prices.reduce((a, b) => (b < a ? b : a));
  const max = prices.reduce((a, b) => (b > a ? b : a));
  const head = `  time (UTC)   block      base fee      priority      price (gwei)`;
  const lines = rows.map((s) => `  ${s.at.slice(11, 19)}     ${s.block.padEnd(10)} ${formatGwei(BigInt(s.baseFeeWei)).padEnd(13)} ${formatGwei(BigInt(s.priorityWei)).padEnd(13)} ${formatGwei(BigInt(s.priceWei))}`);
  return [`last ${rows.length} of ${samples.length} samples:`, head, ...lines, `  min ${formatGwei(min)} · max ${formatGwei(max)} gwei over all ${samples.length}`].join("\n");
}

export interface HoldOptions {
  deadline: Date;
  target: Target;
  intervalMs: number;
  stateFile: string;
  sample: () => Promise<Sample>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}
export interface HoldDecision {
  reason: "gas at or below target" | "deadline reached";
  requestPriceWei: bigint; // price at the first read, i.e. when the request was made
  decisionPriceWei: bigint | null; // price at the last successful read (null if none worked)
  targetWei: bigint | null;
  samplesTaken: number;
  sampleErrors: number;
  heldMs: number;
}

/** Wait until the price is at or below the target or the deadline passes, then return why. The caller sends. */
export async function holdUntilFavourable(o: HoldOptions): Promise<HoldDecision> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? (() => {});
  const started = now().getTime();
  let requestPrice: bigint | null = null;
  let last: bigint | null = null;
  let targetWei: bigint | null = null;
  let taken = 0;
  let errors = 0;
  for (;;) {
    let atDeadline = now() >= o.deadline;
    if (!atDeadline) {
      try {
        const s = await raceDeadline(o.sample(), Math.max(1, o.deadline.getTime() - now().getTime()));
        const samples = saveSample(o.stateFile, s);
        taken++;
        last = BigInt(s.priceWei);
        requestPrice ??= last;
        targetWei = resolveTarget(o.target, samples);
        const left = Math.max(0, Math.round((o.deadline.getTime() - now().getTime()) / 1000));
        log(`${s.at.slice(11, 19)} price ${formatGwei(last)} gwei · target ${targetWei === null ? "n/a" : formatGwei(targetWei)} · ${left}s to deadline`);
        if (targetWei === null) log(`warming up: ${samples.length} samples, the percentile needs more history`);
        else if (last <= targetWei) return { reason: "gas at or below target", requestPriceWei: requestPrice, decisionPriceWei: last, targetWei, samplesTaken: taken, sampleErrors: errors, heldMs: now().getTime() - started };
      } catch (e) {
        errors++; // a failing read must not stop the clock: the deadline still sends
        log(`sample failed (${(e as Error).message}); still holding`);
      }
      atDeadline = now() >= o.deadline;
    }
    if (atDeadline) {
      // Nothing read in time at all (every sample failed): the request price falls back to the last stored sample, else 0.
      requestPrice ??= (() => { const s = loadSamples(o.stateFile).at(-1); return s ? BigInt(s.priceWei) : 0n; })();
      return { reason: "deadline reached", requestPriceWei: requestPrice, decisionPriceWei: last, targetWei, samplesTaken: taken, sampleErrors: errors, heldMs: now().getTime() - started };
    }
    await sleep(Math.max(1, Math.min(o.intervalMs, o.deadline.getTime() - now().getTime())));
  }
}

/** Block timestamps are whole seconds, so the gap to the deadline is counted on whole seconds too (the deadline floored). Same second = cannot tell. */
export function deadlineGap(deadline: Date, minedAt: Date): { seconds: number; side: "before" | "same second as" | "AFTER" } {
  const d = Math.floor(deadline.getTime() / 1000) - Math.floor(minedAt.getTime() / 1000);
  return d > 0 ? { seconds: d, side: "before" } : d === 0 ? { seconds: 0, side: "same second as" } : { seconds: -d, side: "AFTER" };
}

/** `p`, or a rejection after `ms`: a read that hangs (the Chain MCP waits up to 30 s) must not push the send past the deadline. */
function raceDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("read did not finish before the deadline")), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export interface PaidReport {
  paidWei: bigint;
  atRequestPriceWei: bigint;
  /** positive = cheaper than sending at request time */
  savedWei: bigint;
  savedPct: string;
}
export function paidReport(gasUsed: bigint, effectiveGasPrice: bigint, requestPriceWei: bigint): PaidReport {
  const paidWei = gasUsed * effectiveGasPrice;
  const atRequestPriceWei = gasUsed * requestPriceWei;
  const savedWei = atRequestPriceWei - paidWei;
  const bp = atRequestPriceWei === 0n ? 0n : (savedWei * 10000n) / atRequestPriceWei;
  const abs = bp < 0n ? -bp : bp;
  return { paidWei, atRequestPriceWei, savedWei, savedPct: `${bp < 0n ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}` };
}
