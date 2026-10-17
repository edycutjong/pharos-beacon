import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendAudit, verifyAudit } from "../src/gatekeeper/audit.js";
import { evaluate } from "../src/gatekeeper/evaluate.js";
import { parseGatekeeperPolicy } from "../src/gatekeeper/policy.js";
import { runRequests, type Send } from "../src/gatekeeper/run.js";
import { formatOutcome } from "../tasks/policy-gatekeeper/index.js";

const A = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B";
const B = "0x000000000000000000000000000000000000dEaD";
const base = {
  name: "t",
  network: "atlantic",
  spendLimit: { perTx: "0.005", perWindow: "0.008", windowSeconds: 3600 },
  allowlist: [A],
  timeWindow: { start: "00:00", end: "12:00" },
};
const policy = parseGatekeeperPolicy(base);
const at = (t: string) => new Date(`2026-10-17T${t}Z`);
const tmp = () => mkdtempSync(join(tmpdir(), "gk-"));
const wei = (s: string) => (BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n).toString();

describe("policy parsing", () => {
  it("accepts the three rule types and lower-cases the allowlist", () => {
    expect(policy.allowlist).toEqual([A.toLowerCase()]);
    expect(policy.spendLimit).toMatchObject({ perTx: 5n * 10n ** 15n, windowSeconds: 3600 });
    expect(policy.timeWindow).toEqual({ startMin: 0, endMin: 720 });
  });
  it.each([
    [{ ...base, network: "pharos" }, /atlantic/],
    [{ ...base, extra: 1 }, /unknown field/],
    [{ name: "x", network: "atlantic" }, /at least one rule/],
    [{ ...base, allowlist: [] }, /non-empty/],
    [{ ...base, allowlist: ["0x123"] }, /address/],
    [{ ...base, spendLimit: { perTx: "-1" } }, /decimal/],
    [{ ...base, spendLimit: { perWindow: "1" } }, /windowSeconds/],
    [{ ...base, spendLimit: { windowSeconds: 5 } }, /needs/],
    [{ ...base, spendLimit: { perTx: "1.0000000000000000001" } }, /18 decimals/],
    [{ ...base, timeWindow: { start: "9:00", end: "10:00" } }, /HH:MM/],
    [{ ...base, timeWindow: { start: "10:00", end: "10:00" } }, /differ/],
    [{ ...base, timeWindow: { start: "01:00", end: "02:00", days: [7] } }, /0-6/],
    [null, /not an object/],
  ])("rejects a bad policy %#", (raw, msg) => expect(() => parseGatekeeperPolicy(raw)).toThrow(msg));
});

describe("evaluate: one deny per rule type, and the deciding rule is named", () => {
  const ok = { to: A, amount: "0.001" };
  it("allows a request that satisfies every rule and reports each check", () => {
    const d = evaluate(policy, ok, [], at("05:00:00"));
    expect(d).toMatchObject({ decision: "allow", rule: "all_rules_passed" });
    expect(d.checks.map((c) => c.rule)).toEqual(["allowlist", "time_window", "spend_limit_per_tx", "spend_limit_per_window"]);
  });
  it("denies a recipient off the allowlist (case-insensitively matching the ones on it)", () => {
    expect(evaluate(policy, { to: B, amount: "0.001" }, [], at("05:00:00"))).toMatchObject({ decision: "deny", rule: "allowlist" });
    expect(evaluate(policy, { to: A.toLowerCase(), amount: "0.001" }, [], at("05:00:00")).decision).toBe("allow");
  });
  it("denies outside the time window; the end minute is exclusive, the start inclusive", () => {
    expect(evaluate(policy, ok, [], at("18:30:00"))).toMatchObject({ decision: "deny", rule: "time_window" });
    expect(evaluate(policy, ok, [], at("12:00:00")).rule).toBe("time_window");
    expect(evaluate(policy, ok, [], at("11:59:59")).decision).toBe("allow");
    expect(evaluate(policy, ok, [], at("00:00:00")).decision).toBe("allow");
  });
  it("handles a window that wraps midnight, with weekdays counted from the day it started", () => {
    const night = parseGatekeeperPolicy({ name: "n", network: "atlantic", timeWindow: { start: "22:00", end: "02:00", days: [5] } }); // Friday night
    const fri2330 = new Date("2026-10-16T23:30:00Z"); // Friday
    const sat0100 = new Date("2026-10-17T01:00:00Z"); // still Friday's window
    const sat2330 = new Date("2026-10-17T23:30:00Z"); // Saturday's: not allowed
    expect(fri2330.getUTCDay()).toBe(5);
    expect(evaluate(night, ok, [], fri2330).decision).toBe("allow");
    expect(evaluate(night, ok, [], sat0100).decision).toBe("allow");
    expect(evaluate(night, ok, [], sat2330).rule).toBe("time_window");
    expect(evaluate(night, ok, [], at("12:00:00")).rule).toBe("time_window");
  });
  it("denies over the per-transaction limit, allows exactly at it", () => {
    expect(evaluate(policy, { to: A, amount: "0.006" }, [], at("05:00:00"))).toMatchObject({ decision: "deny", rule: "spend_limit_per_tx" });
    expect(evaluate(policy, { to: A, amount: "0.005" }, [], at("05:00:00")).decision).toBe("allow");
  });
  it("denies when the window budget would be exceeded; spend older than the window no longer counts", () => {
    const hist = [{ at: "2026-10-17T04:30:00.000Z", wei: wei("0.005") }];
    expect(evaluate(policy, { to: A, amount: "0.004" }, hist, at("05:00:00"))).toMatchObject({ decision: "deny", rule: "spend_limit_per_window" });
    expect(evaluate(policy, { to: A, amount: "0.003" }, hist, at("05:00:00")).decision).toBe("allow"); // exactly 0.008
    expect(evaluate(policy, { to: A, amount: "0.004" }, hist, at("05:30:01")).decision).toBe("allow"); // 04:30 left the 1 h window
  });
  it.each([
    [{ to: "nope", amount: "1" }, /valid address/],
    [{ to: A, amount: "abc" }, /decimal/],
    [{ to: A, amount: "0" }, /greater than 0/],
    [{ to: A, amount: 0.001 }, /decimal string/],
    [{ to: A, amount: undefined }, /decimal string/],
    [{ to: undefined, amount: "1" }, /valid address/],
  ])("denies a malformed request without evaluating rules %#", (req, msg) => {
    const d = evaluate(policy, req as never, [], at("05:00:00"));
    expect(d).toMatchObject({ decision: "deny", rule: "request" });
    expect(d.reason).toMatch(msg);
  });
  it("denies an invalid clock", () => expect(evaluate(policy, { to: A, amount: "1" }, [], new Date("garbage")).rule).toBe("request"));
  it("a policy with a single rule only checks that rule", () => {
    const only = parseGatekeeperPolicy({ name: "o", network: "atlantic", spendLimit: { perTx: "1" } });
    expect(evaluate(only, { to: B, amount: "1" }, [], at("23:00:00")).checks).toHaveLength(1);
  });
});

describe("runRequests", () => {
  const files = () => ({ stateFile: join(tmp(), "state.json"), auditFile: join(tmp(), "audit.jsonl") });
  const okSend = (): Send & ReturnType<typeof vi.fn> =>
    vi.fn(async (_to, _wei, before) => {
      before("0xabc" as never);
      return { tx: "0xabc" as never, status: "success" as const, block: "7", gasUsed: "21000" };
    }) as never;

  it("never calls send for a denied request, even with --execute", async () => {
    const send = okSend();
    const out = await runRequests(policy, [{ to: B, amount: "0.001" }, { to: A, amount: "9" }, { to: A, amount: "x" }, { to: A, amount: "0.001", at: "2026-10-17T18:00:00Z" }], { ...files(), execute: true, send, now: () => at("05:00:00") });
    expect(out.map((o) => o.status)).toEqual(["denied", "denied", "denied", "denied"]);
    expect(send).not.toHaveBeenCalled();
  });
  it("dry-run never sends an allowed request; a simulated clock never sends either", async () => {
    const send = okSend();
    const f = files();
    const dry = await runRequests(policy, [{ to: A, amount: "0.001" }], { ...f, execute: false, send, now: () => at("05:00:00") });
    const sim = await runRequests(policy, [{ to: A, amount: "0.001", at: "2026-10-17T06:00:00Z" }], { ...f, execute: true, send, now: () => at("05:00:00") });
    expect(dry[0]).toMatchObject({ status: "allowed-dry-run", note: expect.stringContaining("--execute") });
    expect(sim[0]).toMatchObject({ status: "allowed-dry-run", note: expect.stringContaining("simulated") });
    expect(send).not.toHaveBeenCalled();
  });
  it("a dry-run batch counts its earlier ALLOWs toward the window, without saving anything", async () => {
    const f = files();
    const out = await runRequests(policy, [{ to: A, amount: "0.005" }, { to: A, amount: "0.004" }], { ...f, execute: false, now: () => at("05:00:00") });
    expect(out.map((o) => [o.status, o.decision.rule])).toEqual([["allowed-dry-run", "all_rules_passed"], ["denied", "spend_limit_per_window"]]);
    expect(() => readFileSync(f.stateFile)).toThrow(/ENOENT/);
  });
  it("sends an allowed request, counts it toward the window, and then denies the one that would exceed it", async () => {
    const send = okSend();
    const f = files();
    const out = await runRequests(policy, [{ to: A, amount: "0.005" }, { to: A, amount: "0.004" }, { to: A, amount: "0.003" }], { ...f, execute: true, send, now: () => at("05:00:00") });
    expect(out.map((o) => o.status)).toEqual(["executed", "denied", "executed"]);
    expect(out[1]!.decision.rule).toBe("spend_limit_per_window");
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(f.stateFile, "utf8")).spends).toHaveLength(2);
    // a later run reads the persisted state
    const later = await runRequests(policy, [{ to: A, amount: "0.001" }], { ...f, execute: true, send, now: () => at("05:10:00") });
    expect(later[0]!.status).toBe("denied");
  });
  it("counts the spend before the broadcast, so a failed send still uses budget, and logs the error", async () => {
    const f = files();
    const send: Send = async (_t, _w, before) => {
      before("0xdead" as never);
      throw new Error("node refused");
    };
    const [o] = await runRequests(policy, [{ to: A, amount: "0.005" }], { ...f, execute: true, send, now: () => at("05:00:00") });
    expect(o).toMatchObject({ status: "error", tx: "0xdead" });
    expect(JSON.parse(readFileSync(f.stateFile, "utf8")).spends).toHaveLength(1);
    const log = readFileSync(f.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((l) => l.event)).toEqual(["decision", "result"]);
    expect(log[1]).toMatchObject({ status: "error", tx: "0xdead", decisionSeq: 1 });
  });
  it("reports a reverted transaction as reverted", async () => {
    const send: Send = async (_t, _w, b) => (b("0x1" as never), { tx: "0x1" as never, status: "reverted", block: "1", gasUsed: "1" });
    expect((await runRequests(policy, [{ to: A, amount: "0.001" }], { ...files(), execute: true, send, now: () => at("05:00:00") }))[0]!.status).toBe("reverted");
  });
  it("refuses a state file of the wrong shape or invalid JSON instead of guessing", async () => {
    const f = files();
    for (const bad of ["{not json", '{"spends": 3}', '{"spends":[{"at":"x","wei":"1"}]}']) {
      writeFileSync(f.stateFile, bad);
      await expect(runRequests(policy, [{ to: A, amount: "0.001" }], { ...f, execute: true, send: okSend(), now: () => at("05:00:00") })).rejects.toThrow(/state file|wrong shape/);
    }
  });
  it("audits every decision (allow and deny) with the deciding rule, in order", async () => {
    const f = files();
    await runRequests(policy, [{ to: A, amount: "0.001", label: "one" }, { to: B, amount: "0.001", label: "two" }], { ...f, execute: false, now: () => at("05:00:00") });
    const log = readFileSync(f.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((l) => [l.seq, l.label, l.decision, l.rule])).toEqual([[1, "one", "allow", "all_rules_passed"], [2, "two", "deny", "allowlist"]]);
    expect(verifyAudit(f.auditFile)).toBe(2);
  });
  it("formats an outcome with the checks, the deciding rule and the audit number", async () => {
    const [o] = await runRequests(policy, [{ to: B, amount: "0.001" }], { ...files(), execute: false, now: () => at("05:00:00") });
    const text = formatOutcome(o!, 0);
    expect(text).toContain("=> DENY by allowlist (audit #1)");
    expect(text).toContain("not sent: denied requests are never executed");
  });
});

describe("audit log", () => {
  const log = () => join(tmp(), "a.jsonl");
  it("chains entries and detects an edited, removed or reordered line", () => {
    const f = log();
    for (let i = 0; i < 4; i++) appendAudit(f, { event: "decision", i });
    expect(verifyAudit(f)).toBe(4);
    const lines = readFileSync(f, "utf8").trim().split("\n");
    const edit = (ls: string[]) => (writeFileSync(f, ls.join("\n") + "\n"), () => verifyAudit(f));
    expect(edit(lines.map((l, i) => (i === 1 ? l.replace('"i":1', '"i":9') : l)))).toThrow(/line 3/);
    expect(edit([lines[0]!, lines[2]!, lines[3]!])).toThrow(/line 2/);
    expect(edit([lines[1]!, lines[0]!, lines[2]!, lines[3]!])).toThrow(/line 1/);
    expect(edit(lines.slice(0, 3))).not.toThrow(); // a truncated tail is not detectable by a chain alone; documented in the README
  });
  it("rejects a line that is not JSON", () => {
    const f = log();
    writeFileSync(f, "garbage\n");
    expect(() => verifyAudit(f)).toThrow(/not valid JSON/);
  });
  it("starts at genesis and an empty/missing file verifies as 0", () => {
    const f = log();
    expect(verifyAudit(f)).toBe(0);
    expect(appendAudit(f, { event: "decision" })).toMatchObject({ seq: 1, prev: "genesis" });
  });
});
