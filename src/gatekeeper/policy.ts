import { getAddress, isAddress, parseUnits } from "viem";
import type { Hex } from "viem";

// The Policy Gatekeeper's policy file: three rule types, each optional, at least one required. A policy that cannot be
// read exactly is rejected whole (fail closed): there is no "best effort" reading of a spend limit.

export interface SpendLimit {
  /** Largest single amount, in PHRS (decimal string). */
  perTx?: bigint;
  /** Largest total over any `windowSeconds` span, counting only transfers this gatekeeper let through. */
  perWindow?: bigint;
  windowSeconds?: number;
}
export interface TimeWindow {
  /** Minutes since 00:00 UTC. start < end is a same-day window; start > end wraps over midnight. */
  startMin: number;
  endMin: number;
  /** UTC weekdays (0 = Sunday) the window applies to; all days when unset. */
  days?: number[];
}
export interface GatekeeperPolicy {
  name: string;
  network: "atlantic";
  spendLimit?: SpendLimit;
  /** Lower-case recipient addresses (EOAs or contracts) a request may pay. */
  allowlist?: string[];
  timeWindow?: TimeWindow;
}

const fail = (msg: string): never => {
  throw new Error(`invalid policy: ${msg}`);
};

function amount(v: unknown, where: string): bigint {
  if (typeof v !== "string" || !/^\d+(\.\d{1,18})?$/.test(v)) fail(`${where} must be a decimal string with at most 18 decimals`);
  return parseUnits(v as string, 18);
}

function hhmm(v: unknown, where: string): number {
  const m = typeof v === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v) : null;
  if (!m) return fail(`${where} must be "HH:MM" (24 h, UTC)`);
  return Number(m![1]) * 60 + Number(m![2]);
}

/** Amount in the request: same grammar as the policy, but always `> 0`. */
export function parseAmount(v: unknown): bigint {
  const wei = amount(v, "amount");
  if (wei === 0n) fail("amount must be greater than 0");
  return wei;
}

export function parseGatekeeperPolicy(raw: unknown): GatekeeperPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("not an object");
  const p = raw as Record<string, unknown>;
  const known = ["name", "network", "spendLimit", "allowlist", "timeWindow"];
  for (const k of Object.keys(p)) if (!known.includes(k)) fail(`unknown field "${k}"`);
  if (typeof p.name !== "string" || !p.name) fail("name is required");
  if (p.network !== "atlantic") fail('network must be "atlantic" (the gatekeeper only sends on testnet)');
  const out: GatekeeperPolicy = { name: p.name as string, network: "atlantic" };

  if (p.spendLimit !== undefined) {
    const s = p.spendLimit as Record<string, unknown>;
    if (!s || typeof s !== "object") fail("spendLimit must be an object");
    for (const k of Object.keys(s)) if (!["perTx", "perWindow", "windowSeconds"].includes(k)) fail(`spendLimit: unknown field "${k}"`);
    const limit: SpendLimit = {};
    if (s.perTx !== undefined) limit.perTx = amount(s.perTx, "spendLimit.perTx");
    if (s.perWindow !== undefined) {
      limit.perWindow = amount(s.perWindow, "spendLimit.perWindow");
      if (!Number.isInteger(s.windowSeconds) || (s.windowSeconds as number) < 1) fail("spendLimit.windowSeconds must be a positive integer when perWindow is set");
      limit.windowSeconds = s.windowSeconds as number;
    } else if (s.windowSeconds !== undefined) fail("spendLimit.windowSeconds needs spendLimit.perWindow");
    if (limit.perTx === undefined && limit.perWindow === undefined) fail("spendLimit needs perTx and/or perWindow");
    out.spendLimit = limit;
  }
  if (p.allowlist !== undefined) {
    if (!Array.isArray(p.allowlist) || p.allowlist.length === 0) fail("allowlist must be a non-empty array of addresses (an empty list would deny everything; omit the rule instead)");
    out.allowlist = (p.allowlist as unknown[]).map((a, i) => {
      if (typeof a !== "string" || !isAddress(a)) return fail(`allowlist[${i}] must be an address`);
      return (a as string).toLowerCase();
    });
  }
  if (p.timeWindow !== undefined) {
    const t = p.timeWindow as Record<string, unknown>;
    if (!t || typeof t !== "object") fail("timeWindow must be an object");
    for (const k of Object.keys(t)) if (!["start", "end", "days"].includes(k)) fail(`timeWindow: unknown field "${k}"`);
    const w: TimeWindow = { startMin: hhmm(t.start, "timeWindow.start"), endMin: hhmm(t.end, "timeWindow.end") };
    if (w.startMin === w.endMin) fail("timeWindow.start and end must differ");
    if (t.days !== undefined) {
      if (!Array.isArray(t.days) || t.days.length === 0 || !t.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) fail("timeWindow.days must be a non-empty array of 0-6 (0 = Sunday)");
      w.days = [...new Set(t.days as number[])].sort();
    }
    out.timeWindow = w;
  }
  if (!out.spendLimit && !out.allowlist && !out.timeWindow) fail("at least one rule (spendLimit, allowlist, timeWindow) is required");
  return out;
}

/** A request as received: untrusted. `to` and `amount` are validated by `evaluate`, never trusted here. */
export interface GateRequest {
  to: unknown;
  amount: unknown;
  /** Simulated clock (ISO 8601, UTC) for a dry-run. A request that carries it is evaluated but never sent. */
  at?: string;
  label?: string;
}
export type Checksummed = Hex;
export const checksum = (a: string): Checksummed => getAddress(a);
