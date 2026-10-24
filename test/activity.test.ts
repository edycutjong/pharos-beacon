import { describe, expect, it } from "vitest";
import { blockAtOrAfter, collectActivity, MAX_RANGE_BLOCKS, parseWallet, rangeForTimes, totalsOf } from "../src/activity/engine.js";
import { csvReport, highlights, markdownReport, notableTxs } from "../src/activity/report.js";
import { B, C, fakeWorld, OTH, POOL, S, T0, TKN, W, world } from "./helpers/fake-activity.js";

const range = { fromBlock: 90n, toBlock: 200n };
const collect = (scanBlocks = 0, txs = world()) => collectActivity(fakeWorld(txs), "pharos", W, range, { scanBlocks });

describe("collectActivity", () => {
  it("groups log-visible activity into transfers, swaps and approvals", async () => {
    const a = await collect();
    const kinds = a.items.map((i) => `${i.tx.slice(-2)}:${i.category}`);
    expect(kinds).toEqual(["01:transfer-out", "02:transfer-in", "03:approval", "04:swap"]);
    const out = a.items[0]!;
    expect(out.counterparty?.toLowerCase()).toBe(B.toLowerCase());
    expect(out.out[0]).toMatchObject({ symbol: "TKN", decimals: 6, amountRaw: 5_000_000n });
    expect(a.items[1]!.feeWei).toBe(0n); // B sent it, so W paid no fee
    expect(a.items[0]!.feeWei).toBe(21000n * 10n ** 9n);
  });

  it("flags an unlimited approval and names the spender", async () => {
    const ap = (await collect()).items.find((i) => i.category === "approval")!;
    expect(ap.unlimited).toBe(true);
    expect(ap.counterparty?.toLowerCase()).toBe(S.toLowerCase());
  });

  it("treats a tx that gives one token and gets another as one swap, not two transfers", async () => {
    const a = await collect();
    const sw = a.items.filter((i) => i.category === "swap");
    expect(sw).toHaveLength(1);
    expect(sw[0]!.out[0]!.symbol).toBe("TKN");
    expect(sw[0]!.in[0]!.symbol).toBe("OTH");
    expect(sw[0]!.counterparty?.toLowerCase()).toBe(POOL.toLowerCase());
    expect(a.items.filter((i) => i.tx.endsWith("04"))).toHaveLength(1);
  });

  it("without a block scan, misses the event-less txs and says so through the nonce count", async () => {
    const a = await collect(0);
    expect(a.coverage.blockScan.mode).toBe("off");
    expect(a.coverage.sentFound).toBe(3 + 0); // tx1, tx3, tx4 (tx5 and tx6 leave no log)
    expect(a.coverage.sentExpected).toBe(5); // tx1, 3, 4, 5, 6
  });

  it("a full block scan finds the reverted call and the plain PROS transfers, and the counts then agree", async () => {
    const a = await collect(111);
    expect(a.coverage.blockScan).toEqual({ mode: "full", scanned: 111, of: 111 });
    const call = a.items.find((i) => i.category === "contract-call")!;
    expect(call).toMatchObject({ status: "reverted", method: "call 0xdeadbeef" });
    expect(call.counterparty?.toLowerCase()).toBe(C.toLowerCase());
    const nativeOut = a.items.find((i) => i.tx.endsWith("06"))!;
    expect(nativeOut).toMatchObject({ category: "transfer-out", method: "plain transfer" });
    expect(nativeOut.out[0]).toMatchObject({ symbol: "PROS", decimals: 18, amountRaw: 10n ** 18n });
    expect(a.items.find((i) => i.tx.endsWith("07"))).toMatchObject({ category: "transfer-in" });
    expect(a.coverage.sentFound).toBe(a.coverage.sentExpected);
  });

  it("a partial scan is reported as partial", async () => {
    const a = await collectActivity(fakeWorld(world()), "pharos", W, range, { scanBlocks: 20 });
    expect(a.coverage.blockScan).toEqual({ mode: "partial", scanned: 20, of: 111 });
  });

  it("only counts what is inside the range", async () => {
    const a = await collectActivity(fakeWorld(world()), "pharos", W, { fromBlock: 125n, toBlock: 135n });
    expect(a.items.map((i) => i.category)).toEqual(["swap"]);
  });

  it("rejects a range over the cap and an empty one", async () => {
    await expect(collectActivity(fakeWorld(world()), "pharos", W, { fromBlock: 0n, toBlock: BigInt(MAX_RANGE_BLOCKS) })).rejects.toThrow(/over the 400000 cap/);
    await expect(collectActivity(fakeWorld(world()), "pharos", W, { fromBlock: 5n, toBlock: 4n })).rejects.toThrow(/empty/);
  });

  it("caps the transactions it reads and says how many it skipped", async () => {
    const a = await collectActivity(fakeWorld(world()), "pharos", W, range, { maxTxs: 2 });
    expect(a.coverage.skipped).toBe(2);
    expect(new Set(a.items.map((i) => i.tx)).size).toBe(2);
  });

  it("totals: counts per category, fees only for sent txs", async () => {
    const t = totalsOf((await collect(111)).items);
    expect(t.counts).toEqual({ "transfer-in": 2, "transfer-out": 2, swap: 1, approval: 1, "contract-call": 1 });
    expect(t.unlimitedApprovals).toBe(1);
    expect(t.failed).toBe(1);
    expect(t.feesWei).toBe(5n * 21000n * 10n ** 9n);
    expect(t.outflow.find((x) => x.symbol === "TKN")!.raw).toBe(5_000_000n);
  });
});

describe("time → block", () => {
  const call = fakeWorld(world());
  it("finds the first block at or after a timestamp", async () => {
    expect(await blockAtOrAfter(call, T0 + 100, 400n)).toBe(100n);
    expect(await blockAtOrAfter(call, T0 + 100.5, 400n)).toBe(101n);
    expect(await blockAtOrAfter(call, T0 - 50, 400n)).toBe(0n);
    expect(await blockAtOrAfter(call, T0 + 9999, 400n)).toBe(401n);
  });
  it("finds the exact block on a 21-million-block chain with uneven block times in few calls", async () => {
    const stamp = (n: number) => T0 + Math.floor(n * 0.91) + (n % 7 === 0 ? 1 : 0) + (n > 15_000_000 ? Math.floor((n - 15_000_000) * 0.1) : 0);
    let calls = 0;
    const big = (async (_t: string, a: any) => (calls++, { timestamp: `0x${stamp(a.block === "latest" ? 21_000_000 : Number(a.block)).toString(16)}` })) as any;
    const target = stamp(12_345_678) - 0.5;
    const got = Number(await blockAtOrAfter(big, target, 21_000_000n));
    expect(stamp(got)).toBeGreaterThanOrEqual(target);
    expect(got === 0 || stamp(got - 1) < target).toBe(true);
    expect(calls).toBeLessThan(16);
    console.info(`interpolation search: ${calls} get_block calls`);
  });
  it("a period [from, to) becomes an inclusive block range", async () => {
    expect(await rangeForTimes(call, T0 + 100, T0 + 200, 400n)).toMatchObject({ fromBlock: 100n, toBlock: 199n });
  });
  it("clips a period that runs past the head, and refuses one that starts after it", async () => {
    expect((await rangeForTimes(call, T0 + 300, T0 + 900, 400n)).toBlock).toBe(400n);
    await expect(rangeForTimes(call, T0 + 800, T0 + 900, 400n)).rejects.toThrow(/after the latest block/);
    await expect(rangeForTimes(call, T0 + 5, T0 + 5, 400n)).rejects.toThrow(/end after/);
  });
});

describe("parseWallet", () => {
  it("checksums a lower-case address and refuses junk", () => {
    expect(parseWallet(W.toLowerCase())).toBe(W);
    expect(() => parseWallet("0x123")).toThrow(/not an address/);
  });
});

describe("report", () => {
  it("markdown has every category, links to the explorer and the coverage section", async () => {
    const a = await collect(111);
    const md = markdownReport(a, { generatedAt: "2026-10-24T00:00:00Z" });
    for (const h of ["## In plain words", "## Highlights", "## Totals by category", "## Transfers in", "## Transfers out", "## Swaps", "## Approvals", "## Contract interactions", "## Notable transactions", "## What this report can and cannot see"]) expect(md).toContain(h);
    expect(md).toContain("https://www.pharosscan.xyz/tx/0x");
    expect(md).toContain("5 TKN");
    expect(md).toContain("Outgoing transactions found: 5 of 5");
    expect(md).toContain("unlimited");
  });
  it("an empty period says it saw nothing and points at the coverage", async () => {
    const a = await collectActivity(fakeWorld(world()), "pharos", W, { fromBlock: 300n, toBlock: 310n });
    expect(markdownReport(a, { generatedAt: "x" })).toMatch(/no activity that this report can see/);
  });
  it("highlights: first-time counterparties against a baseline, the largest outflow per token, unlimited approvals", async () => {
    const a = await collect(111);
    const base = await collectActivity(fakeWorld(world()), "pharos", W, { fromBlock: 0n, toBlock: 99n });
    const h = highlights(a, base);
    expect(h.some((x) => x.kind === "unlimited-approval")).toBe(true);
    expect(h.filter((x) => x.kind === "first-time-counterparty").length).toBeGreaterThan(0);
    expect(h.filter((x) => x.kind === "largest-outflow").map((x) => x.text).join(" ")).toMatch(/Largest TKN sent out: 5 TKN/);
    // With B seen in the baseline, B is no longer first-time.
    const seenB = { ...base, items: [{ ...a.items[0]! }] };
    expect(highlights(a, seenB).some((x) => x.kind === "first-time-counterparty" && x.text.includes(B))).toBe(false);
    expect(highlights(a).some((x) => x.kind === "first-time-counterparty")).toBe(false); // no baseline: not claimed
  });
  it("notable transactions: reverted and unlimited first, at most five", async () => {
    const n = notableTxs(await collect(111));
    expect(n.length).toBeLessThanOrEqual(5);
    expect(n[0]!.why).toMatch(/reverted/);
    expect(n.some((x) => /unlimited approval/.test(x.why))).toBe(true);
  });
  it("csv has a header, one row per item, quotes cells with commas", async () => {
    const a = await collect(111);
    const rows = csvReport(a).trim().split("\n");
    expect(rows[0]).toBe("time_utc,block,category,status,counterparty,gave,got,method,fee_native,tx,link");
    expect(rows).toHaveLength(1 + a.items.length);
    expect(csvReport(a)).toContain('"5 TKN"'.replace(/"/g, "")); // no comma in this amount: unquoted
    const big = { ...a, items: [{ ...a.items[0]!, out: [{ ...a.items[0]!.out[0]!, amountRaw: 1_234_567_000_000n }] }] };
    expect(csvReport(big)).toContain('"1,234,567 TKN"');
  });
});

describe("the other tokens", () => {
  it("OTH has 18 decimals", async () => {
    const sw = (await collect()).items.find((i) => i.category === "swap")!;
    expect(sw.in[0]).toMatchObject({ token: OTH, decimals: 18, amountRaw: 10n ** 18n });
    expect(sw.out[0]!.token).toBe(TKN);
  });
});
