import { type Hex } from "viem";
import { remedy, type MarketSnapshot, type PositionHealth } from "./morpho.js";

// Thresholds, alert levels with hysteresis, and the alert text (with a concrete action).

export type Level = "ok" | "warn" | "critical" | "liquidatable";
const ORDER: Level[] = ["ok", "warn", "critical", "liquidatable"];
export const severity = (l: Level) => ORDER.indexOf(l);

export interface Thresholds {
  /** Warn below this health factor (default 1.3). */
  warn: number;
  /** Critical below this (default 1.1). */
  critical: number;
  /** A level only clears when the health factor is this far above its threshold (default 0.02): no flapping. */
  rearm: number;
}

export function checkThresholds(t: Thresholds): Thresholds {
  if (!(Number.isFinite(t.warn) && Number.isFinite(t.critical) && Number.isFinite(t.rearm))) throw new RangeError("thresholds must be numbers");
  if (t.critical <= 1) throw new RangeError("--critical must be above 1.0 (at 1.0 the position is already liquidatable)");
  if (t.warn <= t.critical) throw new RangeError("--warn must be above --critical");
  if (t.rearm < 0 || t.rearm > t.warn - 1) throw new RangeError("--rearm must be between 0 and warn − 1");
  return t;
}

/** The level a health factor sits at right now, ignoring history. */
export function levelOf(hf: number, t: Thresholds): Level {
  return hf < 1 ? "liquidatable" : hf < t.critical ? "critical" : hf < t.warn ? "warn" : "ok";
}

/**
 * The level to report given the previous one: worsening is reported at once, improvement only after the health factor is
 * `rearm` clear of the threshold it left (so a position hovering around 1.30 does not alert on every poll).
 */
export function nextLevel(prev: Level, hf: number, t: Thresholds): Level {
  const now = levelOf(hf, t);
  if (severity(now) >= severity(prev)) return now;
  const cleared = levelOf(hf - t.rearm, t);
  return severity(cleared) < severity(prev) ? (severity(now) < severity(cleared) ? cleared : now) : prev;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** 1234567n, 6 → "1.234567" trimmed to `dp` places with thousands separators. */
export function fmtToken(raw: bigint, decimals: number, dp = 2): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  if (v !== 0n && v < 10n ** BigInt(decimals)) dp = Math.max(dp, Math.min(decimals, 6)); // under one unit: show enough places that it is not "0.00"
  const base = 10n ** BigInt(decimals);
  const scale = 10n ** BigInt(dp);
  const rounded = decimals >= dp ? (v * scale + base / 2n) / base : v * scale;
  const whole = (rounded / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${whole}${dp ? "." + (rounded % scale).toString().padStart(dp, "0") : ""}`;
}

export const pct = (x: number, dp = 2) => `${(x * 100).toFixed(dp)}%`;

/** A health factor for display; a position with next to no debt has an absurd one, shown as "> 1000". */
export const fmtHf = (hf: number, dp = 4) => (hf > 1000 ? "> 1000" : hf.toFixed(dp));

export interface Alert {
  level: Exclude<Level, "ok">;
  market: Hex;
  marketLabel: string;
  user: Hex;
  hf: number;
  text: string;
}

export const marketLabel = (s: MarketSnapshot) => `${s.collateral.symbol}/${s.loan.symbol}`;

/** One alert: the state, how far the price is from liquidation, and the action that restores the safe line (the warn threshold). */
export function buildAlert(level: Exclude<Level, "ok">, s: MarketSnapshot, p: PositionHealth, t: Thresholds, now: Date, shock = 0): Alert {
  const label = marketLabel(s);
  const scenario = shock > 0 ? ` [scenario: ${s.collateral.symbol} price −${pct(shock, 1)}]` : "";
  const head = `[${now.toISOString()}] ${level.toUpperCase()} Morpho ${label} ${short(p.user)}${scenario}: health factor ${fmtHf(p.hfNumber)}`;
  const debt = `debt ${fmtToken(p.debt, s.loan.decimals)} ${s.loan.symbol}, collateral ${fmtToken(p.collateral, s.collateral.decimals)} ${s.collateral.symbol}`;
  const danger = level === "liquidatable" ? "Liquidatable now." : `Liquidated if ${s.collateral.symbol} falls ${pct(p.dropToLiquidation)} further.`;
  // the remedy is computed at the (possibly shocked) price, so the action matches the number in the headline
  const price = shock > 0 ? (s.price * BigInt(Math.round((1 - shock) * 1e9))) / 1_000_000_000n : s.price;
  const r = remedy(p.collateral, price, s.params.lltv, p.debt, t.warn);
  const action = `Act now: repay ${fmtToken(r.repay, s.loan.decimals)} ${s.loan.symbol} or add ${fmtToken(r.addCollateral, s.collateral.decimals)} ${s.collateral.symbol} collateral to get back to ${t.warn.toFixed(2)}.`;
  return { level, market: s.id, marketLabel: label, user: p.user, hf: p.hfNumber, text: `${head} (${debt}). ${danger} ${action}` };
}
