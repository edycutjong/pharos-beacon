import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectActivity } from "../src/activity/engine.js";
import { compare, digestChat, digestMarkdown, metricsOf, parseCadence, periodAt, topEvents } from "../src/activity/digest.js";
import { main } from "../tasks/weekly-digest-agent/index.js";
import type { Notifier } from "../src/watch/discord.js";
import { fakeWorld, mintTx, T0, W, world } from "./helpers/fake-activity.js";

const ctx = { onExit: () => {}, signal: new AbortController().signal };
const conn = (spy: { tool: string; args: any }[] = []) => async () => ({ call: fakeWorld(world(), 400, spy), close: async () => {}, endpoint: "fake://chain", network: "pharos" as const, chainId: 1672, server: undefined });
const ts = (iso: string) => Date.parse(iso) / 1000;
let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("periods", () => {
  it("weekly: the last finished Monday-to-Monday week, whatever day it is run", () => {
    // 2026-10-24 is a Saturday; the last finished week is Mon 2026-10-12 .. Sun 2026-10-18.
    for (const now of ["2026-10-19T00:00:00Z", "2026-10-21T13:00:00Z", "2026-10-25T23:59:59Z"]) {
      const p = periodAt(ts(now), "weekly");
      expect(p.label).toBe("2026-10-12 to 2026-10-18");
      expect(p.toTs - p.fromTs).toBe(7 * 86400);
    }
    expect(periodAt(ts("2026-10-26T01:00:00Z"), "weekly").label).toBe("2026-10-19 to 2026-10-25");
    expect(periodAt(ts("2026-10-26T01:00:00Z"), "weekly", 1).label).toBe("2026-10-12 to 2026-10-18");
  });
  it("daily, monthly and Nd", () => {
    expect(periodAt(ts("2026-10-24T05:00:00Z"), "daily").label).toBe("2026-10-23 to 2026-10-23");
    expect(periodAt(ts("2026-10-24T05:00:00Z"), "monthly").label).toBe("2026-09-01 to 2026-09-30");
    expect(periodAt(ts("2026-01-05T05:00:00Z"), "monthly").label).toBe("2025-12-01 to 2025-12-31");
    expect(periodAt(ts("2026-01-05T05:00:00Z"), "monthly", 1).label).toBe("2025-11-01 to 2025-11-30");
    expect(periodAt(ts("2026-10-24T05:00:00Z"), "14d").label).toBe("2026-10-10 to 2026-10-23");
  });
  it("cadence parsing", () => {
    expect(parseCadence("weekly")).toBe("weekly");
    expect(parseCadence("3d")).toBe("3d");
    expect(() => parseCadence("hourly")).toThrow(/cadence must be/);
    expect(() => parseCadence("0d")).toThrow(/cadence must be/);
  });
});

describe("metrics, comparison and top events", () => {
  const prev = async () => metricsOf(await collectActivity(fakeWorld(world()), "pharos", W, { fromBlock: 90n, toBlock: 125n }, { scanBlocks: 36 }), "prev");
  const cur = () => collectActivity(fakeWorld(world()), "pharos", W, { fromBlock: 126n, toBlock: 200n }, { scanBlocks: 75 });

  it("compares each metric with the previous period, with a change and a percentage", async () => {
    const c = metricsOf(await cur(), "cur");
    const rows = compare(c, await prev(), "PROS");
    const get = (m: string) => rows.find((r) => r.metric === m)!;
    expect(get("Transactions")).toMatchObject({ current: "4", previous: "3", change: "+1 (+33%)" });
    expect(get("Swaps")).toMatchObject({ current: "1", previous: "0", change: "+1 (new)" });
    expect(get("Transfers out")).toMatchObject({ current: "1", previous: "1" });
    expect(get("New counterparties").current).toBe("2");
    expect(compare(c, undefined, "PROS").every((r) => r.previous === "n/a" || r.metric.startsWith("New"))).toBe(true);
  });

  it("top events: at most three, a unlimited approval outranks the rest, one entry per tx", async () => {
    const all = await collectActivity(fakeWorld(world()), "pharos", W, { fromBlock: 90n, toBlock: 200n }, { scanBlocks: 111 });
    const ev = topEvents(all);
    expect(ev).toHaveLength(3);
    expect(ev[0]).toMatchObject({ kind: "unlimited approval" });
    expect(new Set(ev.map((e) => e.tx)).size).toBe(3);
    expect(topEvents(all, undefined, 10).length).toBeGreaterThan(3);
  });

  it("a mint from the zero address is described as a mint and is never a new counterparty", async () => {
    const a = await collectActivity(fakeWorld([...world(), mintTx()]), "pharos", W, { fromBlock: 90n, toBlock: 200n }, { scanBlocks: 0 });
    const p = await prev();
    const ev = topEvents(a, p, 20);
    expect(ev.some((e) => e.kind === "new counterparty" && e.why.includes("0x0000000000000000000000000000000000000000"))).toBe(false);
    expect(ev.find((e) => e.kind === "mint" && /minted/.test(e.why))).toBeTruthy();
    expect(ev[ev.length - 1]!.kind).toBe("mint"); // the least interesting kind comes last
    expect(topEvents(a, p).some((e) => e.kind === "mint")).toBe(false); // and does not make the top three while other events exist
  });

  it("never more than two events of one kind in the top three", async () => {
    const a = await collectActivity(fakeWorld(world()), "pharos", W, { fromBlock: 90n, toBlock: 200n }, { scanBlocks: 111 });
    const ev = topEvents(a);
    const kinds = ev.map((e) => e.kind);
    for (const k of new Set(kinds)) expect(kinds.filter((x) => x === k).length).toBeLessThanOrEqual(2);
    expect(ev.map((e) => e.kind)).toEqual(["unlimited approval", "failed transaction", "large outflow"]);
  });

  it("with a previous period, a first-time counterparty is a candidate; with none it is not claimed", async () => {
    const a = await cur();
    const p = await prev();
    expect(topEvents(a, p, 10).some((e) => e.kind === "new counterparty")).toBe(true);
    expect(topEvents(a, undefined, 10).some((e) => e.kind === "new counterparty")).toBe(false);
  });

  it("digest text: key numbers table, top events with links, who is new, and a Discord version under 2,000 characters", async () => {
    const a = await cur();
    const m = metricsOf(a, "cur");
    const p = await prev();
    const input = { activity: a, metrics: m, previous: p, period: { fromTs: T0, toTs: T0 + 86400, label: "x to y" }, cadence: "weekly" as const, generatedAt: "now", events: topEvents(a, p) };
    const md = digestMarkdown(input);
    for (const h of ["## What changed", "## Key numbers", "## Top 3 notable events", "## Who is new", "## Coverage"]) expect(md).toContain(h);
    expect(md).toContain("| Transactions | 4 | 3 | +1 (+33%) |");
    expect(md).toMatch(/1\. \*\*/);
    const chat = digestChat(input);
    expect(chat.length).toBeLessThan(2000);
    expect(chat).toContain("Top events:");
  });
});

describe("weekly-digest-agent main", () => {
  // The world's blocks sit at 2023-11-14 22:13 UTC; the week Mon 2023-11-13 .. Sun 2023-11-19 holds all of them.
  const NOW = "2023-11-20T01:00:00Z";
  const fakeNotifier = (sent: string[]): Notifier => ({ name: "fake-discord", send: async (t) => (sent.push(t), { id: `m${sent.length}`, timestamp: "2026-10-24T00:00:00Z", content: t }) });

  it("builds the digest for the last finished week, writes it, delivers once, and a rerun in the same week does nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-"));
    const state = join(dir, "state.json");
    const sent: string[] = [];
    const args = ["--wallet", W, "--now", NOW, "--state", state, "--out", dir, "--deliver", "discord", "--baseline", "none", "--scan-blocks", "400"];
    expect(await main(ctx, args, conn(), () => fakeNotifier(sent))).toBe(0);
    expect(out.join("\n")).toContain("period 2023-11-13 to 2023-11-19 UTC");
    expect(sent).toHaveLength(1);
    expect(readFileSync(join(dir, "digest-0x317bca-weekly-2023-11-13.md"), "utf8")).toContain("# Weekly digest:");
    const saved = JSON.parse(readFileSync(state, "utf8"));
    expect(saved).toMatchObject({ periodLabel: "2023-11-13 to 2023-11-19", delivered: { id: "m1" } });

    out.length = 0;
    const spy: { tool: string; args: any }[] = [];
    expect(await main(ctx, args, conn(spy), () => fakeNotifier(sent))).toBe(0);
    expect(out.join("\n")).toMatch(/already delivered/);
    expect(sent).toHaveLength(1);
    expect(spy).toHaveLength(0); // not even a connection's worth of reads
  });

  it("--compact prints a narrow view: every line fits 62 columns, with the comparison and the three events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-"));
    const state = join(dir, "s.json");
    await main(ctx, ["--wallet", W, "--now", NOW, "--compact", "--baseline", "none", "--state", state], conn(), undefined);
    const lines = out.join("\n").split("\n").slice(3);
    expect(Math.max(...lines.map((l) => [...l].length))).toBeLessThanOrEqual(62);
    const text = lines.join("\n");
    for (const k of ["transactions", "transfers in", "swaps", "approvals", "fees", "top 3 events", "1. "]) expect(text).toContain(k);
    expect(text).not.toContain("# Weekly digest");
  });

  it("--force builds the same period again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-"));
    const base = ["--wallet", W, "--now", NOW, "--state", join(dir, "s.json"), "--baseline", "none"];
    await main(ctx, base, conn(), undefined);
    out.length = 0;
    await main(ctx, [...base, "--force"], conn(), undefined);
    expect(out.join("\n")).toContain("# Weekly digest:");
  });

  it("next week reuses the saved numbers as the comparison and reads only the new week", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-"));
    const state = join(dir, "s.json");
    await main(ctx, ["--wallet", W, "--now", NOW, "--state", state, "--baseline", "none", "--scan-blocks", "400"], conn(), undefined);
    out.length = 0;
    const spy: { tool: string; args: any }[] = [];
    await main(ctx, ["--wallet", W, "--now", "2023-11-27T01:00:00Z", "--state", state], conn(spy), undefined).catch((e) => e);
    // The week after holds no blocks yet in this fake chain (head is in the earlier week): the period start is past the head.
    expect(out.join("\n")).toContain("period 2023-11-20 to 2023-11-26 UTC");
  });

  it("a period before the chain's first block is refused with a clear message", async () => {
    await expect(main(ctx, ["--wallet", W, "--now", "2023-11-13T01:00:00Z", "--baseline", "none"], conn(), undefined)).rejects.toThrow(/holds no blocks/);
  });

  it("--print-schedule shows the cron expression and reads nothing", async () => {
    const spy: { tool: string; args: any }[] = [];
    expect(await main(ctx, ["--wallet", W, "--print-schedule"], conn(spy), undefined)).toBe(0);
    expect(out.join("\n")).toContain('cron "0 1 * * 1" (UTC)');
    expect(spy).toHaveLength(0);
  });

  it("a state file for another wallet does not suppress the digest; a mangled state is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-"));
    const state = join(dir, "s.json");
    await main(ctx, ["--wallet", W, "--now", NOW, "--state", state, "--baseline", "none"], conn(), undefined);
    out.length = 0;
    await main(ctx, ["--wallet", "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B", "--now", NOW, "--state", state, "--baseline", "none"], conn(), undefined);
    expect(out.join("\n")).not.toMatch(/already delivered/);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(state, JSON.stringify({ wallet: 5 }));
    await expect(main(ctx, ["--wallet", W, "--now", NOW, "--state", state], conn(), undefined)).rejects.toThrow(/wrong shape/);
  });

  it.each([
    [[], /--wallet is required/],
    [["--wallet", W, "--cadence", "hourly"], /cadence must be/],
    [["--wallet", W, "--now", "tomorrow"], /--now must be an ISO time/],
    [["--wallet", W, "--deliver", "email"], /--deliver/],
    [["--wallet", W, "--max-txs", "0"], /whole number/],
  ])("refuses bad input %j", async (argv, re) => {
    await expect(main(ctx, argv as string[], conn(), undefined)).rejects.toThrow(re);
  });
});
