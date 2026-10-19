// The Gas Fee Optimizer CLI as a user runs it: real process. Only the argument checks are run here (they need no chain).
import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/lib/env.js";
import { defaultLead } from "../tasks/gas-fee-optimizer/index.js";

const run = (args: string[]): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve) =>
    execFile(join(REPO_ROOT, "node_modules/.bin/tsx"), [join(REPO_ROOT, "tasks/gas-fee-optimizer/index.ts"), ...args],
      { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", PHAROS_MCP_URL: "http://127.0.0.1:9/never" } },
      (err, _stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code) : 0, stderr })),
  );

const SEND = ["send", "--to", "0x000000000000000000000000000000000000dEaD", "--value", "0.0001", "--target-gwei", "1"];

describe("gas-fee-optimizer CLI --lead", () => {
  it("refuses a lead that leaves no time to hold", async () => {
    const r = await run([...SEND, "--deadline", "5", "--lead", "5"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--lead must be shorter than --deadline");
  });
  it("refuses a negative lead", async () => {
    const r = await run([...SEND, "--deadline", "30", "--lead=-1"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--lead must be a number ≥ 0");
  });
  it("a short deadline needs no --lead: the default lead is capped at half of it", () => {
    expect([defaultLead(undefined, 40), defaultLead(undefined, 6), defaultLead(undefined, 1)]).toEqual([8, 3, 0.5]);
    expect(defaultLead("2", 6)).toBe(2); // a lead the user did pass is kept
  });
});
