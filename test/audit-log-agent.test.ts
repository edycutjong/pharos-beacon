import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateToTs, main } from "../tasks/audit-log-agent/index.js";
import { UsageError } from "../src/lib/cli.js";
import { fakeWorld, W, world } from "./helpers/fake-activity.js";

const ctx = { onExit: () => {}, signal: new AbortController().signal };
const conn = (spy: { tool: string; args: any }[] = []) => async () => ({ call: fakeWorld(world(), 400, spy), close: async () => {}, endpoint: "fake://chain", network: "pharos" as const, chainId: 1672, server: undefined });
const NOW = () => new Date("2026-10-24T00:00:00Z");
let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("dateToTs", () => {
  it("reads a UTC date and refuses a wrong shape or an impossible day", () => {
    expect(dateToTs("--from", "2023-11-14")).toBe(1_699_920_000);
    expect(() => dateToTs("--from", "14/11/2023")).toThrow(UsageError);
    expect(() => dateToTs("--from", "2023-02-30")).toThrow(/not a real date/);
  });
});

describe("audit-log-agent main", () => {
  it("a date range maps to blocks and prints the report (to is inclusive)", async () => {
    const spy: { tool: string; args: any }[] = [];
    expect(await main(ctx, ["--wallet", W.toLowerCase(), "--from", "2023-11-14", "--to", "2023-11-14", "--baseline", "none"], conn(spy), NOW)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("period 2023-11-14 to 2023-11-14 UTC · blocks 0–400");
    expect(text).toContain("# Wallet activity report:");
    expect(text).toContain("5 TKN");
    expect(spy.filter((s) => s.tool === "send_raw_transaction")).toHaveLength(0);
  });

  it("--out writes Markdown and CSV files, named for the wallet and the period", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    await main(ctx, ["--wallet", W, "--from-block", "90", "--to-block", "200", "--baseline", "none", "--format", "both", "--out", dir, "--scan-blocks", "111"], conn(), NOW);
    expect(readdirSync(dir).sort()).toEqual(["audit-0x317bca-90-200.csv", "audit-0x317bca-90-200.md"]);
    expect(readFileSync(join(dir, "audit-0x317bca-90-200.csv"), "utf8").split("\n")[0]).toMatch(/^time_utc,block,category/);
    expect(readFileSync(join(dir, "audit-0x317bca-90-200.md"), "utf8")).toContain("Outgoing transactions found: 5 of 5");
  });

  it("by default the previous period of the same length is read for first-time counterparties", async () => {
    await main(ctx, ["--wallet", W, "--from-block", "120", "--to-block", "170"], conn(), NOW);
    expect(out.join("\n")).not.toContain("First-time counterparties are not checked");
  });

  it.each([
    [[], /--wallet is required/],
    [["--wallet", "0x12"], /not an address/],
    [["--wallet", W], /give a period/],
    [["--wallet", W, "--from", "2023-11-14"], /--from and --to go together/],
    [["--wallet", W, "--from", "2023-11-15", "--to", "2023-11-14"], /must not be before/],
    [["--wallet", W, "--from", "2023-11-14", "--to", "2023-11-14", "--from-block", "1", "--to-block", "2"], /not both/],
    [["--wallet", W, "--from-block", "9", "--to-block", "3"], /must not be before/],
    [["--wallet", W, "--from-block", "1", "--to-block", "2", "--format", "pdf"], /--format/],
    [["--wallet", W, "--from-block", "1", "--to-block", "2", "--scan-blocks=-1"], /whole number/],
    [["--wallet", W, "--from-block", "1", "--to-block", "2", "--proof", "Bad Label"], /label of lower-case/],
  ])("refuses bad input %j", async (argv, re) => {
    await expect(main(ctx, argv as string[], conn(), NOW)).rejects.toThrow(re);
  });
});
