import { pct, usd, type RateView } from "../yield/model.js";
import { DEFAULT_GAS } from "../yield/plan.js";
import type { Holding, Reading } from "../yield/sources.js";
import type { Venue } from "./adapters.js";

// The router: pure functions, no I/O. It sees only what the adapters read (`VenueView`), picks the venue (or venues) for a request
// and writes down WHY in numbers. A venue that cannot take the request is listed with the reason, never silently dropped.

export interface VenueView {
  venue: Venue;
  reading: Reading;
  rate: RateView;
  /** What the wallet holds here, or null for nothing. */
  holding: Holding | null;
}

/** A venue (or a whole protocol) that could not be read, and why. The others are routed without it. */
export interface Down {
  venue: Venue;
  reason: string;
  /** True when the outage was injected with --down (a drill), not met on the chain. */
  simulated: boolean;
}

export interface RouteParams {
  /** How long the money is expected to stay, in days: the horizon over which yield is weighed against fees and gas. */
  holdDays: number;
  /** USD per gas unit. */
  usdPerGas: number;
  /** 6 for USDC. */
  assetDecimals: number;
}

export interface Option {
  venueId: string;
  name: string;
  protocolName: string;
  eligible: boolean;
  /** Why it cannot take the request (empty when eligible). */
  reasons: string[];
  /** The most it can take in one transaction, USD (Infinity = no limit found). */
  capacityUsd: number;
  /** Deposit: yield − fees − gas, in USD, over the horizon. Withdrawal: the COST of taking the money out here (fee + gas + the yield given up). */
  scoreUsd: number | null;
  /** The numbers behind the score. */
  parts: Partial<Record<string, number>>;
  ratePct: string;
}

export interface Allocation {
  venueId: string;
  usd: number;
  /** The whole position (withdrawals). */
  all: boolean;
}

export interface Route {
  request: "deposit" | "withdraw";
  amountUsd: number;
  allocations: Allocation[];
  options: Option[];
  explanation: string[];
  /** Part of the request nobody could take. */
  unplacedUsd: number;
}

const toUsd = (raw: bigint, dec: number) => Number(raw) / 10 ** dec;

function entryBlockers(v: VenueView): string[] {
  const r = v.reading;
  const b = v.venue.actionBlocker ? [`${v.venue.name} is ${v.venue.actionBlocker}`] : [];
  b.push(...r.entry.blockers);
  if (v.rate.pessimistic === null) b.push("no rate could be read, so its yield is unknown");
  if (r.entry.feeBps === null && !b.length) b.push("its entry fee cannot be read");
  return b;
}

/** The venues that can take a deposit, ranked by what the money would earn net of fees and gas over the horizon. */
export function routeDeposit(views: VenueView[], down: Down[], amountUsd: number, p: RouteParams): Route {
  const gas = (DEFAULT_GAS.approve + DEFAULT_GAS.enter) * p.usdPerGas;
  const options: Option[] = views.map((v) => {
    const r = v.reading;
    const reasons = entryBlockers(v);
    const capacity = r.entry.maxDeposit !== null ? toUsd(r.entry.maxDeposit, p.assetDecimals) : Infinity;
    // a Morpho deposit shares the borrowers' interest with everyone already supplying: our deposit dilutes the rate
    const dilutionAt = (usdIn: number) => (v.venue.protocol === "morpho" && r.tvl !== null && r.tvl > 0n ? toUsd(r.tvl, p.assetDecimals) / (toUsd(r.tvl, p.assetDecimals) + usdIn) : 1);
    if (capacity <= 0 && reasons.length === 0) reasons.push("it takes no deposit from this wallet today (maxDeposit(wallet) = 0)");
    const eligible = reasons.length === 0;
    const net = (usdIn: number) => {
      const gross = usdIn * (v.rate.pessimistic ?? 0) * dilutionAt(usdIn) * (p.holdDays / 365);
      const fee = usdIn * ((r.entry.feeBps ?? 0) / 10_000);
      return { gross, fee, gas, net: gross - fee - gas };
    };
    const n = eligible ? net(Math.min(amountUsd, capacity)) : null;
    return {
      venueId: v.venue.id,
      name: v.venue.name,
      protocolName: v.venue.protocolName,
      eligible,
      reasons,
      capacityUsd: eligible ? capacity : 0,
      scoreUsd: n ? n.net : null,
      parts: n ? { grossUsd: n.gross, entryFeeUsd: n.fee, gasUsd: n.gas, dilution: dilutionAt(Math.min(amountUsd, capacity)) } : {},
      ratePct: pct(v.rate.pessimistic),
    };
  });
  const ranked = options.filter((o) => o.eligible).sort((a, b) => b.scoreUsd! / Math.min(amountUsd, b.capacityUsd) - a.scoreUsd! / Math.min(amountUsd, a.capacityUsd));
  const allocations: Allocation[] = [];
  let left = amountUsd;
  for (const o of ranked) {
    if (left <= 1e-9) break;
    const put = Math.min(left, o.capacityUsd);
    if (put > 0) allocations.push({ venueId: o.venueId, usd: put, all: false });
    left -= put;
  }
  const lines: string[] = [];
  const name = (id: string) => options.find((o) => o.venueId === id)!;
  if (!allocations.length) lines.push(`No venue can take ${usd(amountUsd)} today: ${options.map((o) => `${o.name}: ${o.reasons.join(" / ")}`).join("; ")}`);
  else {
    const top = name(allocations[0]!.venueId);
    lines.push(
      `Chose ${top.name} (${top.protocolName})${allocations.length > 1 ? ` for the first ${usd(allocations[0]!.usd)}` : ""}: over ${p.holdDays} d it nets ${usd(top.scoreUsd!)} = yield ${usd(top.parts.grossUsd!)} at its conservative ${top.ratePct}${top.parts.dilution! < 0.9999 ? ` × ${(top.parts.dilution! * 100).toFixed(2)}% for the dilution our deposit causes` : ""} − entry fee ${usd(top.parts.entryFeeUsd!)} − gas ${usd(top.parts.gasUsd!)}.`,
    );
    const runner = ranked.find((o) => o.venueId !== top.venueId);
    if (runner) lines.push(`Next best: ${runner.name} nets ${usd(runner.scoreUsd!)} (conservative ${runner.ratePct}); ${top.name} is ${usd(top.scoreUsd! - runner.scoreUsd!)} ahead.`);
    if (allocations.length > 1) lines.push(`${top.name} takes at most ${usd(top.capacityUsd)} in one deposit (maxDeposit), so the rest goes to the next best: ${allocations.slice(1).map((a) => `${usd(a.usd)} to ${name(a.venueId).name}`).join(", ")}.`);
    if (left > 1e-9) lines.push(`${usd(left)} could not be placed: every eligible venue is at its limit.`);
  }
  if (allocations.length && name(allocations[0]!.venueId).scoreUsd! < 0) lines.push(`Warning: over ${p.holdDays} d this deposit nets less than nothing (yield below the fee and gas); a longer --hold-days or a larger amount would change that.`);
  if (allocations.length) for (const o of options.filter((x) => !x.eligible)) lines.push(`Not eligible: ${o.name} (${o.protocolName}): ${o.reasons.join("; ")}.`);
  for (const d of down) lines.push(`${d.simulated ? "SIMULATED OUTAGE" : "Unavailable"}: ${d.venue.name} (${d.venue.protocolName}): ${d.reason}. Routed without it.`);
  return { request: "deposit", amountUsd, allocations, options, explanation: lines, unplacedUsd: Math.max(0, left) };
}

/**
 * The venues the wallet can take money out of. The cost of leaving a venue is its exit fee, the gas, and the yield the money would
 * have kept earning there (credited at the optimistic rate: money that stays in a good venue is not free to take out). The venue
 * where leaving costs least is used first, so the best-paying positions are the last to be touched.
 */
export function routeWithdraw(views: VenueView[], down: Down[], amountUsd: number | "all", p: RouteParams): Route {
  const gas = DEFAULT_GAS.exit * p.usdPerGas;
  const held = views.filter((v) => v.holding && v.holding.assets > 0n);
  const options: Option[] = held.map((v) => {
    const r = v.reading;
    const posUsd = toUsd(v.holding!.assets, p.assetDecimals);
    const reasons = v.venue.actionBlocker ? [`${v.venue.name} is ${v.venue.actionBlocker}`] : [];
    reasons.push(...r.exit.blockers);
    if (r.exit.feeBps === null && !reasons.length) reasons.push("its exit fee cannot be read");
    // what can leave in one go: the position, and for Morpho the market's idle liquidity
    const cap = v.venue.protocol === "morpho" && r.exit.depth !== null ? Math.min(posUsd, toUsd(r.exit.depth, p.assetDecimals)) : posUsd;
    const eligible = reasons.length === 0 && cap > 0;
    if (!eligible && reasons.length === 0) reasons.push("nothing can leave right now");
    const sized = amountUsd === "all" ? cap : Math.min(amountUsd, cap);
    const fee = sized * ((r.exit.feeBps ?? 0) / 10_000);
    const rateKnown = v.rate.optimistic !== null;
    const forgone = sized * (v.rate.optimistic ?? 0) * (p.holdDays / 365);
    return {
      venueId: v.venue.id,
      name: v.venue.name,
      protocolName: v.venue.protocolName,
      eligible,
      reasons: eligible ? [] : reasons,
      capacityUsd: eligible ? cap : 0,
      scoreUsd: eligible ? fee + gas + forgone : null,
      parts: eligible ? { exitFeeUsd: fee, gasUsd: gas, forgoneYieldUsd: forgone, positionUsd: posUsd, atUsd: sized, rateUnknown: rateKnown ? 0 : 1 } : {},
      ratePct: pct(v.rate.optimistic),
    };
  });
  // a venue whose rate could not be read has an unknown cost of leaving: it is used last, never first
  const key = (o: Option) => (o.parts.rateUnknown ? 1e12 : 0) + o.scoreUsd! / Math.max(o.parts.atUsd!, 1e-9);
  const ranked = options.filter((o) => o.eligible).sort((a, b) => key(a) - key(b));
  const total = amountUsd === "all" ? ranked.reduce((a, o) => a + o.capacityUsd, 0) : amountUsd;
  const allocations: Allocation[] = [];
  let left = total;
  for (const o of ranked) {
    if (left <= 1e-9) break;
    const take = Math.min(left, o.capacityUsd);
    allocations.push({ venueId: o.venueId, usd: take, all: take >= toUsd(held.find((v) => v.venue.id === o.venueId)!.holding!.assets, p.assetDecimals) - 1e-9 });
    left -= take;
  }
  const lines: string[] = [];
  const name = (id: string) => options.find((o) => o.venueId === id)!;
  if (!held.length) lines.push("The wallet holds nothing in any venue that answered, so there is nothing to withdraw.");
  else if (!allocations.length) lines.push("Nothing can be withdrawn today.");
  else {
    const top = name(allocations[0]!.venueId);
    lines.push(
      `Chose ${top.name} (${top.protocolName})${allocations.length > 1 ? ` first` : ""}: taking ${usd(allocations[0]!.usd)} out costs ${usd(top.scoreUsd!)} over ${p.holdDays} d = exit fee ${usd(top.parts.exitFeeUsd!)} + gas ${usd(top.parts.gasUsd!)} + yield given up ${usd(top.parts.forgoneYieldUsd!)} at its optimistic ${top.ratePct}.`,
    );
    if (top.parts.rateUnknown) lines.push(`Note: the rate of ${top.name} could not be read, so what leaving it gives up is unknown (counted as $0); venues with a known rate are used before it.`);
    const runner = ranked.find((o) => o.venueId !== top.venueId);
    if (runner) lines.push(`Next cheapest: ${runner.name} would cost ${usd(runner.scoreUsd!)} for ${usd(Math.min(runner.parts.atUsd!, allocations[0]!.usd))}; it keeps earning ${runner.ratePct}.`);
    if (allocations.length > 1) lines.push(`No single venue holds the whole amount, so it is split: ${allocations.map((a) => `${usd(a.usd)} from ${name(a.venueId).name}`).join(", ")}.`);
    if (left > 1e-9) lines.push(`${usd(left)} of the request cannot be covered by what the wallet can take out today.`);
  }
  for (const o of options.filter((x) => x.eligible && x.capacityUsd < x.parts.positionUsd! - 1e-9)) lines.push(`Only ${usd(o.capacityUsd)} of the ${usd(o.parts.positionUsd!)} in ${o.name} can leave in one transaction today (the market's idle liquidity); the rest stays until borrowers repay.`);
  for (const o of options.filter((x) => !x.eligible)) lines.push(`Cannot withdraw from ${o.name} (${o.protocolName}), position ${usd(toUsd(held.find((v) => v.venue.id === o.venueId)!.holding!.assets, p.assetDecimals))}: ${o.reasons.join("; ")}.`);
  for (const d of down) lines.push(`${d.simulated ? "SIMULATED OUTAGE" : "Unavailable"}: ${d.venue.name} (${d.venue.protocolName}): ${d.reason}. The wallet's position there is UNKNOWN, so it is not counted.`);
  return { request: "withdraw", amountUsd: total, allocations, options, explanation: lines, unplacedUsd: Math.max(0, left) };
}
