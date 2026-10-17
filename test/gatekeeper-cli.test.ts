// The Policy Gatekeeper CLI as a user runs it: real process, temp state/audit. Only paths that need no chain are run
// here (denies and dry-runs), which is also the point: a denied request must work, and never send, with no network.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/lib/env.js";

const A = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B";
const dir = mkdtempSync(join(tmpdir(), "gk-cli-"));
const policy = join(dir, "p.json");
writeFileSync(policy, JSON.stringify({ name: "cli", network: "atlantic", allowlist: [A], spendLimit: { perTx: "0.005" } }));

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const state = join(dir, "state.json");
  const audit = join(dir, "audit.jsonl");
  return new Promise((resolve) =>
    execFile(join(REPO_ROOT, "node_modules/.bin/tsx"), [join(REPO_ROOT, "tasks/policy-gatekeeper/index.ts"), policy, "--state", state, "--audit", audit, ...args],
      { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", HOME: dir, PHAROS_MCP_URL: "http://127.0.0.1:9/never" } },
      (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code) : 0, stdout, stderr })),
  );
}

describe("policy-gatekeeper CLI", () => {
  it("denies with the deciding rule and sends nothing, even with --execute and no chain reachable", async () => {
    const r = await run(["--to", "0x000000000000000000000000000000000000dEaD", "--amount", "0.001", "--execute"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("=> DENY by allowlist (audit #1)");
    expect(r.stdout).toContain("summary: 1 requests · 0 allowed · 1 denied · 0 sent");
    expect(existsSync(join(dir, "state.json"))).toBe(false); // nothing was spent
  });
  it("--fail-on-deny exits 3", async () => expect((await run(["--to", A, "--amount", "0.006", "--fail-on-deny"])).code).toBe(3));
  it("a dry-run of an allowed request prints ALLOW, says it was not sent, exits 0 and spends nothing", async () => {
    const r = await run(["--to", A, "--amount", "0.001"]);
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout).toContain("=> ALLOW by all_rules_passed");
    expect(r.stdout).toContain("not sent: dry-run: pass --execute to send");
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });
  it("appends every decision to a hash-chained audit log that survives across runs", async () => {
    const lines = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.seq, l.decision, l.rule])).toEqual([[1, "deny", "allowlist"], [2, "deny", "spend_limit_per_tx"], [3, "allow", "all_rules_passed"]]);
  });
  it("exit 2 with a usage line for bad input; --at with --requests; unreadable policy", async () => {
    expect((await run(["--to", A])).code).toBe(2);
    expect((await run(["--to", A, "--amount", "1", "--bogus"])).code).toBe(2);
    expect((await run(["--requests", join(dir, "nope.json")])).stderr).toMatch(/nope\.json/);
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ name: "x", network: "pharos", allowlist: [A] }));
    const bad = await new Promise<{ code: number; stderr: string }>((res) => execFile(join(REPO_ROOT, "node_modules/.bin/tsx"), [join(REPO_ROOT, "tasks/policy-gatekeeper/index.ts"), join(dir, "bad.json"), "--to", A, "--amount", "1"], { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", HOME: dir } }, (e, _o, se) => res({ code: Number((e as any)?.code ?? 0), stderr: se })));
    expect(bad).toMatchObject({ code: 2 });
    expect(bad.stderr).toMatch(/network must be "atlantic"/);
  });
  it("a plain dry-run without --audit leaves the committed audit log alone (logs to a scratch file)", async () => {
    const committed = join(REPO_ROOT, "tasks/policy-gatekeeper/audit/audit.jsonl");
    const before = readFileSync(committed, "utf8");
    const r = await new Promise<{ code: number; stdout: string }>((resolve) =>
      execFile(join(REPO_ROOT, "node_modules/.bin/tsx"), [join(REPO_ROOT, "tasks/policy-gatekeeper/index.ts"), policy, "--state", join(dir, "s2.json"), "--to", A, "--amount", "0.001"],
        { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir, PHAROS_MCP_URL: "http://127.0.0.1:9/never" } },
        (err, stdout) => resolve({ code: err ? Number((err as { code?: number }).code) : 0, stdout })),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(join(dir, "beacon-policy-gatekeeper", "audit.jsonl"));
    expect(readFileSync(committed, "utf8")).toBe(before);
  });
});
