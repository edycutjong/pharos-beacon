// The Yield Optimizer's decision maths. Pure functions: numbers in, numbers out, no chain and no keys.
//
// A source's rate is measured, not quoted: how much its share price grew over each of several windows (1 d / 7 d / 30 d on mainnet),
// annualised by simple extrapolation (APR, no compounding). The spread between the windows says how steady the rate is.
// A move only counts when the destination's PESSIMISTIC rate beats the current position's OPTIMISTIC rate by enough to pay for
// gas, exit fee, entry fee and the lock-in, inside the holding period the user asked for.

export interface Window {
  label: string;
  seconds: number;
}

/** "1d,7d,30d" or "10m,30m,1h" → windows, shortest first. */
export function parseWindows(spec: string): Window[] {
  const out = spec.split(",").map((raw) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([mhd])\s*$/.exec(raw);
    if (!m) throw new Error(`window ${JSON.stringify(raw.trim())} must look like 30m, 12h or 7d`);
    const n = Number(m[1]);
    const seconds = Math.round(n * { m: 60, h: 3600, d: 86400 }[m[2] as "m" | "h" | "d"]);
    if (!(seconds > 0)) throw new Error(`window ${JSON.stringify(raw.trim())} must be longer than zero`);
    return { label: `${m[1]}${m[2]}`, seconds };
  });
  if (out.length < 2 || out.length > 6) throw new Error("give between 2 and 6 windows, e.g. 1d,7d,30d");
  if (new Set(out.map((w) => w.seconds)).size !== out.length) throw new Error("windows must all be different");
  return out.sort((a, b) => a.seconds - b.seconds);
}

export interface PricePoint {
  block: bigint;
  timestamp: bigint;
  /** Assets (whole units, e.g. USDC) per one whole share. */
  price: number;
}

/** Simple annualised rate from two price points; null when the clock did not move. */
export function aprBetween(then: PricePoint, now: PricePoint): number | null {
  const dt = Number(now.timestamp - then.timestamp);
  if (!(dt > 0) || !(then.price > 0)) return null;
  return (now.price / then.price - 1) * ((365 * 86_400) / dt);
}

export interface WindowRate {
  label: string;
  seconds: number;
  /** null = this window could not be read (see `reason`). */
  apr: number | null;
  reason?: string;
}

export interface RateOptions {
  /** A source is jumpy when its windows differ by at least this much (absolute, 0.01 = 1 percentage point)… */
  jumpyAbs: number;
  /** …and by at least this fraction of its reference rate. */
  jumpyRel: number;
  /** How much of the spread is taken off (destination) or added on (current position). */
  haircut: number;
  /** Windows that must be readable before a source can be judged at all. */
  minWindows: number;
}

export const DEFAULT_RATE_OPTIONS: RateOptions = { jumpyAbs: 0.01, jumpyRel: 0.5, haircut: 0.5, minWindows: 2 };

export interface RateView {
  windows: WindowRate[];
  read: number;
  /** Median of the readable windows (the "reference" rate). */
  ref: number | null;
  spread: number;
  jumpy: boolean;
  /** ref − haircut × spread (it may be negative: a source that loses value is not flattered): the rate a destination is credited with. */
  pessimistic: number | null;
  /** ref + haircut × spread: the rate the position we already hold is credited with. */
  optimistic: number | null;
  /** True when too few windows were readable to judge the rate. */
  thin: boolean;
}

export function rateView(windows: WindowRate[], o: RateOptions = DEFAULT_RATE_OPTIONS): RateView {
  const aprs = windows.map((w) => w.apr).filter((a): a is number => a !== null && Number.isFinite(a));
  if (aprs.length === 0) return { windows, read: 0, ref: null, spread: 0, jumpy: false, pessimistic: null, optimistic: null, thin: true };
  const sorted = [...aprs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const ref = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const spread = sorted[sorted.length - 1]! - sorted[0]!;
  const jumpy = aprs.length >= 2 && spread >= o.jumpyAbs && spread >= o.jumpyRel * Math.max(Math.abs(ref), 0.01);
  return {
    windows,
    read: aprs.length,
    ref,
    spread,
    jumpy,
    pessimistic: ref - o.haircut * spread,
    optimistic: ref + o.haircut * spread,
    thin: aprs.length < o.minWindows,
  };
}

// ---------------------------------------------------------------- what a move costs

export interface Held {
  key: string;
  name: string;
  /** What the position is worth if exited now, in USDC. */
  usd: number;
  rate: RateView;
  /** Exit fee in basis points, null when it cannot be read. */
  exitFeeBps: number | null;
  /** Reasons the position cannot be exited in one transaction right now. */
  exitBlockers: string[];
}

export interface Target {
  key: string;
  name: string;
  rate: RateView;
  entryFeeBps: number | null;
  lockSeconds: number;
  /** Reasons this wallet cannot deposit here (closed, full, asynchronous, not approved). */
  entryBlockers: string[];
  /** Gas for the whole move to this destination (exit + approve + deposit), in USD. */
  gasUsd: number;
  /**
   * What your deposit does to the destination's rate: 1 = nothing. A Morpho market pays its suppliers the borrowers' interest, so
   * adding `amount` to a market with `supply` already in it scales the supply rate by supply / (supply + amount).
   */
  dilution: number;
}

export interface Params {
  /** The user's minimum holding period after a move, in days. */
  holdDays: number;
  /** The smallest net gain worth the trouble, in USD. */
  minNetUsd: number;
}

export interface Evaluation {
  key: string;
  name: string;
  /** Days the money stays: the holding period, or the destination's lock-in when that is longer. */
  horizonDays: number;
  rateGap: number | null;
  grossUsd: number | null;
  gasUsd: number;
  exitFeeUsd: number | null;
  entryFeeUsd: number | null;
  costUsd: number | null;
  netUsd: number | null;
  /** The same net gain with both sides at their MEDIAN rate (no haircut or credit for jumpiness): the "expected" figure beside the conservative one. */
  netAtMedianUsd: number | null;
  /** The destination's rate after your deposit dilutes it (conservative rate × dilution). */
  destRate: number | null;
  dilution: number;
  /** Days until the extra yield has paid back the costs; null = never (no positive gap). */
  breakEvenDays: number | null;
  /** Why the position cannot be exited (applies to every destination). */
  exitBlockers: string[];
  /** Why this destination cannot be entered, or its rate cannot be judged. */
  entryBlockers: string[];
  /** Not blockers: things the reader should know (e.g. the horizon was extended to a lock-in). */
  notes: string[];
  verdict: "move" | "no";
}

export function evaluateMove(held: Held, t: Target, p: Params): Evaluation {
  const exitBlockers = [...held.exitBlockers];
  const entryBlockers = [...t.entryBlockers];
  const notes: string[] = [];
  if (t.rate.thin) entryBlockers.push(`rate history too short to judge (${t.rate.read} of ${t.rate.windows.length} windows readable)`);
  if (held.rate.thin) exitBlockers.push(`the rate of ${held.name} cannot be judged (${held.rate.read} of ${held.rate.windows.length} windows readable)`);
  const horizonDays = Math.max(p.holdDays, t.lockSeconds / 86_400);
  if (t.lockSeconds / 86_400 > p.holdDays) notes.push(`${t.name} locks deposits for ${fmtDays(t.lockSeconds / 86_400)}, longer than the ${fmtDays(p.holdDays)} holding period: the horizon is extended to the lock-in`);
  const base = { key: t.key, name: t.name, horizonDays, gasUsd: t.gasUsd, exitBlockers, entryBlockers, notes, dilution: t.dilution };
  if (held.rate.optimistic === null || t.rate.pessimistic === null || held.exitFeeBps === null || t.entryFeeBps === null || held.rate.ref === null || t.rate.ref === null) {
    return { ...base, rateGap: null, grossUsd: null, exitFeeUsd: null, entryFeeUsd: null, costUsd: null, netUsd: null, netAtMedianUsd: null, destRate: null, breakEvenDays: null, verdict: "no" };
  }
  if (t.dilution < 1) notes.push(`your deposit would dilute ${t.name}'s rate to ${(t.dilution * 100).toFixed(2)}% of what it pays today`);
  const destRate = t.rate.pessimistic * t.dilution;
  const rateGap = destRate - held.rate.optimistic;
  const grossUsd = (held.usd * rateGap * horizonDays) / 365;
  const exitFeeUsd = (held.usd * held.exitFeeBps) / 10_000;
  const entryFeeUsd = ((held.usd - exitFeeUsd) * t.entryFeeBps) / 10_000;
  const costUsd = t.gasUsd + exitFeeUsd + entryFeeUsd;
  const netUsd = grossUsd - costUsd;
  const netAtMedianUsd = (held.usd * (t.rate.ref * t.dilution - held.rate.ref) * horizonDays) / 365 - costUsd;
  const perDay = (held.usd * rateGap) / 365;
  const breakEvenDays = perDay > 0 ? costUsd / perDay : null;
  const move = exitBlockers.length === 0 && entryBlockers.length === 0 && netUsd >= p.minNetUsd && breakEvenDays !== null && breakEvenDays <= p.holdDays;
  return { ...base, rateGap, grossUsd, exitFeeUsd, entryFeeUsd, costUsd, netUsd, netAtMedianUsd, destRate, breakEvenDays, verdict: move ? "move" : "no" };
}

export interface Recommendation {
  decision: "MOVE" | "STAY";
  best: Evaluation | null;
  evaluations: Evaluation[];
  /** One sentence: why move, or why stay put. */
  reason: string;
}

export function recommend(held: Held, targets: Target[], p: Params): Recommendation {
  const evaluations = targets.filter((t) => t.key !== held.key).map((t) => evaluateMove(held, t, p));
  const movers = evaluations.filter((e) => e.verdict === "move").sort((a, b) => b.netUsd! - a.netUsd!);
  if (movers.length) {
    const b = movers[0]!;
    return {
      decision: "MOVE",
      best: b,
      evaluations,
      reason: `move to ${b.name}: net gain ${usd(b.netUsd!)} at conservative rates (${usd(b.netAtMedianUsd!)} at median rates) over ${fmtDays(b.horizonDays)}, after ${usd(b.costUsd!)} of costs; the costs are earned back in ${fmtDays(b.breakEvenDays!)} (holding period ${fmtDays(p.holdDays)})`,
    };
  }
  // stay put: say what stops each alternative, then explain with the best one that could be entered
  const parts: string[] = [];
  if (held.exitBlockers.length) parts.push(`${held.name} cannot be exited in one transaction today (${held.exitBlockers.join("; ")})`);
  const open = evaluations.filter((e) => e.entryBlockers.length === 0 && e.netUsd !== null).sort((a, b) => b.netUsd! - a.netUsd!);
  const shut = evaluations.filter((e) => e.entryBlockers.length > 0);
  if (!evaluations.length) parts.push(`there is no other source to compare ${held.name} with`);
  else if (!open.length) parts.push(`no alternative can be entered by this wallet today (${shut.map((e) => `${e.name}: ${e.entryBlockers[0]}`).join("; ")})`);
  else {
    const c = open[0]!;
    parts.push(
      `the best alternative that could be entered, ${c.name}, would net ${usd(c.netUsd!)} at conservative rates (${usd(c.netAtMedianUsd!)} at median rates) over ${fmtDays(c.horizonDays)} after ${usd(c.costUsd!)} of costs${c.breakEvenDays === null ? " (its conservative rate is not above the current one, so the costs are never earned back)" : `, earned back only in ${fmtDays(c.breakEvenDays)}`}; a move must net at least ${usd(p.minNetUsd)} and pay back within the ${fmtDays(p.holdDays)} holding period`,
    );
    if (shut.length) parts.push(`${shut.length} other source${shut.length > 1 ? "s" : ""} cannot be entered (${shut.map((e) => e.name).join(", ")})`);
  }
  const best = open[0] ?? evaluations.filter((e) => e.netUsd !== null).sort((a, b) => b.netUsd! - a.netUsd!)[0] ?? null;
  return { decision: "STAY", best, evaluations, reason: parts.join("; ") };
}

// ---------------------------------------------------------------- formatting

export function usd(n: number): string {
  const a = Math.abs(n);
  const s = a >= 1000 ? a.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : a >= 1 ? a.toFixed(2) : a.toFixed(a < 0.01 ? 6 : 4);
  return `${n < 0 ? "-" : ""}$${s}`;
}
export const pct = (x: number | null, digits = 2): string => (x === null ? "n/a" : `${(x * 100).toFixed(digits)}%`);
export function fmtDays(d: number): string {
  if (d < 1 / 24) return `${Math.max(1, Math.round(d * 1440))} min`;
  if (d < 1) return `${(d * 24).toFixed(1)} h`;
  return `${d >= 10 ? d.toFixed(0) : d.toFixed(1)} d`;
}
