import { formatUnits } from "viem";
import { parseAmount, type GatekeeperPolicy, type GateRequest } from "./policy.js";
import { isAddress } from "viem";

// Pure decision logic: (policy, request, spend history, clock) → allow/deny + the rule that decided. No I/O, so every
// outcome is unit-testable. Rules run in a fixed order and the FIRST failing rule is the deciding one; evaluation stops there, so `checks` holds
// the rules that passed before it plus the failing one.

export type RuleName = "request" | "allowlist" | "time_window" | "spend_limit_per_tx" | "spend_limit_per_window";
export interface Spend {
  /** ISO time the transfer was let through. */
  at: string;
  wei: string;
  tx?: string;
}
export interface Check {
  rule: RuleName;
  pass: boolean;
  detail: string;
}
export interface Decision {
  decision: "allow" | "deny";
  /** The rule that decided: the first failing one, or the last rule that passed for an allow. */
  rule: RuleName | "all_rules_passed";
  reason: string;
  checks: Check[];
}

const phros = (wei: bigint) => `${formatUnits(wei, 18)} PHRS`;
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function evaluate(policy: GatekeeperPolicy, req: GateRequest, history: Spend[], now: Date): Decision {
  const checks: Check[] = [];
  const deny = (rule: RuleName, reason: string): Decision => {
    checks.push({ rule, pass: false, detail: reason });
    return { decision: "deny", rule, reason, checks };
  };

  // A request that cannot be read exactly is denied before any rule runs.
  if (typeof req.to !== "string" || !isAddress(req.to)) return deny("request", "recipient is not a valid address");
  let wei: bigint;
  try {
    wei = parseAmount(req.amount);
  } catch (e) {
    return deny("request", (e as Error).message.replace(/^invalid policy: /, "request: "));
  }
  if (isNaN(now.getTime())) return deny("request", "request time is not a valid date");
  const to = req.to.toLowerCase();

  if (policy.allowlist) {
    if (!policy.allowlist.includes(to)) return deny("allowlist", `${req.to} is not on the allowlist (${policy.allowlist.length} address${policy.allowlist.length === 1 ? "" : "es"})`);
    checks.push({ rule: "allowlist", pass: true, detail: `${req.to} is on the allowlist` });
  }
  if (policy.timeWindow) {
    const w = policy.timeWindow;
    const m = now.getUTCHours() * 60 + now.getUTCMinutes();
    const inside = w.startMin < w.endMin ? m >= w.startMin && m < w.endMin : m >= w.startMin || m < w.endMin;
    // For a window that wraps midnight, the part after midnight belongs to the day the window STARTED on.
    const day = w.startMin > w.endMin && m < w.endMin ? (now.getUTCDay() + 6) % 7 : now.getUTCDay();
    const span = `${hm(w.startMin)}–${hm(w.endMin)} UTC${w.days ? ` on days ${w.days.join(",")}` : ""}`;
    if (!inside || (w.days && !w.days.includes(day))) return deny("time_window", `${now.toISOString()} is outside the allowed window ${span}`);
    checks.push({ rule: "time_window", pass: true, detail: `${hm(m)} UTC is inside ${span}` });
  }
  const s = policy.spendLimit;
  if (s?.perTx !== undefined) {
    if (wei > s.perTx) return deny("spend_limit_per_tx", `${phros(wei)} exceeds the per-transaction limit of ${phros(s.perTx)}`);
    checks.push({ rule: "spend_limit_per_tx", pass: true, detail: `${phros(wei)} ≤ ${phros(s.perTx)} per transaction` });
  }
  if (s?.perWindow !== undefined) {
    const from = now.getTime() - s.windowSeconds! * 1000;
    const spent = history.filter((h) => Date.parse(h.at) > from && Date.parse(h.at) <= now.getTime()).reduce((a, h) => a + BigInt(h.wei), 0n);
    if (spent + wei > s.perWindow)
      return deny("spend_limit_per_window", `${phros(wei)} on top of ${phros(spent)} already sent in the last ${s.windowSeconds} s exceeds ${phros(s.perWindow)}`);
    checks.push({ rule: "spend_limit_per_window", pass: true, detail: `${phros(spent + wei)} ≤ ${phros(s.perWindow)} over ${s.windowSeconds} s` });
  }
  return { decision: "allow", rule: "all_rules_passed", reason: checks.map((c) => c.detail).join("; "), checks };
}
