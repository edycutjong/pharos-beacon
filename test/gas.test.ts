import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { historyTable, holdUntilFavourable, loadSamples, paidReport, percentilePrice, resolveTarget, takeSample, type Sample } from "../src/gas/optimizer.js";
import type { ChainMcp } from "../src/lib/mcp.js";

const gwei = (n: number) => BigInt(Math.round(n * 1e9));
const sampleAt = (t: number, price: number, block = 1): Sample => ({ at: new Date(t).toISOString(), block: String(block), baseFeeWei: gwei(price).toString(), priorityWei: "0", priceWei: gwei(price).toString() });
const tmp = () => join(mkdtempSync(join(tmpdir(), "gas-")), "gas.json");

/** An injected clock: sleeping advances it, nothing really waits. */
function clock(start = Date.UTC(2026, 9, 18, 12, 0, 0)) {
  let t = start;
  return { now: () => new Date(t), sleep: async (ms: number) => { t += ms; }, get t() { return t; } };
}

describe("takeSample", () => {
  it("prices a gas unit as base fee + priority fee", async () => {
    const call = (async (name: string) => (name === "get_block" ? { number: "0x10", baseFeePerGas: "0x3b9aca00" } : { maxPriorityFeePerGasWei: "500000000" })) as unknown as ChainMcp["call"];
    const s = await takeSample(call, () => new Date(0));
    expect(s).toMatchObject({ block: "16", baseFeeWei: "1000000000", priorityWei: "500000000", priceWei: "1500000000" });
  });
});

describe("percentile and history", () => {
  const samples = [5, 1, 3, 2, 4].map((p, i) => sampleAt(i, p));
  it("uses nearest rank", () => {
    expect(percentilePrice(samples, 25)).toBe(gwei(2));
    expect(percentilePrice(samples, 100)).toBe(gwei(5));
    expect(percentilePrice(samples, 1)).toBe(gwei(1));
  });
  it("applies the window to the newest samples", () => {
    expect(resolveTarget({ kind: "percentile", p: 50, window: 2, minSamples: 2 }, samples)).toBe(gwei(2)); // last two: 2, 4 → rank 1
    expect(resolveTarget({ kind: "percentile", p: 50, window: 3 }, samples.slice(0, 2))).toBeNull(); // 2 < 5 samples: not enough history
    expect(resolveTarget({ kind: "price", wei: 7n }, samples)).toBe(7n);
  });
  it("prints a table with min and max", () => {
    expect(historyTable(samples, 3)).toMatch(/last 3 of 5 samples[\s\S]*min 1 · max 5 gwei over all 5/);
    expect(historyTable([])).toBe("no samples yet");
  });
});

describe("holdUntilFavourable", () => {
  it("sends early when the price is at or below the target", async () => {
    const c = clock();
    const prices = [3, 3, 1];
    let i = 0;
    const d = await holdUntilFavourable({ deadline: new Date(c.t + 600_000), target: { kind: "price", wei: gwei(1) }, intervalMs: 5000, stateFile: tmp(), now: c.now, sleep: c.sleep, sample: async () => sampleAt(c.t, prices[i++]!) });
    expect(d.reason).toBe("gas at or below target");
    expect(d.samplesTaken).toBe(3);
    expect(d.requestPriceWei).toBe(gwei(3)); // the first read is the price at request time
    expect(d.decisionPriceWei).toBe(gwei(1));
    expect(d.heldMs).toBe(10_000);
  });

  it("holds to the deadline while gas stays high, then still returns (the caller sends)", async () => {
    const c = clock();
    const file = tmp();
    const d = await holdUntilFavourable({ deadline: new Date(c.t + 30_000), target: { kind: "price", wei: gwei(1) }, intervalMs: 5000, stateFile: file, now: c.now, sleep: c.sleep, sample: async () => sampleAt(c.t, 2) });
    expect(d.reason).toBe("deadline reached");
    expect(d.heldMs).toBe(30_000); // not a millisecond later
    expect(d.samplesTaken).toBe(6);
    expect(loadSamples(file)).toHaveLength(6);
  });

  it("does not overshoot the deadline when the interval does not divide it", async () => {
    const c = clock();
    const d = await holdUntilFavourable({ deadline: new Date(c.t + 12_000), target: { kind: "price", wei: 1n }, intervalMs: 5000, stateFile: tmp(), now: c.now, sleep: c.sleep, sample: async () => sampleAt(c.t, 2) });
    expect(d.reason).toBe("deadline reached");
    expect(d.heldMs).toBe(12_000);
  });

  it("still reaches the deadline when every read fails", async () => {
    const c = clock();
    const d = await holdUntilFavourable({ deadline: new Date(c.t + 20_000), target: { kind: "price", wei: gwei(1) }, intervalMs: 5000, stateFile: tmp(), now: c.now, sleep: c.sleep, sample: async () => { throw new Error("rpc down"); } });
    expect(d).toMatchObject({ reason: "deadline reached", samplesTaken: 0, decisionPriceWei: null, requestPriceWei: 0n });
    expect(d.sampleErrors).toBe(4);
  });

  it("returns at the deadline even when a read hangs", async () => {
    const d = await holdUntilFavourable({ deadline: new Date(Date.now() + 80), target: { kind: "price", wei: 1n }, intervalMs: 20, stateFile: tmp(), sample: () => new Promise<Sample>(() => {}) });
    expect(d.reason).toBe("deadline reached");
    expect(d.sampleErrors).toBeGreaterThan(0);
  });

  it("a percentile target waits for enough history, then sends when the price is at the low end", async () => {
    const c = clock();
    const prices = [4, 5, 5, 4, 4, 2]; // samples 1–4 are warm-up; at sample 5 the price 4 equals p25 of {4,5,5,4,4}
    let i = 0;
    const d = await holdUntilFavourable({ deadline: new Date(c.t + 600_000), target: { kind: "percentile", p: 25, window: 10 }, intervalMs: 1000, stateFile: tmp(), now: c.now, sleep: c.sleep, sample: async () => sampleAt(c.t, prices[i++]!) });
    expect(d.samplesTaken).toBe(5); // never earlier: samples 1–4 are warm-up
    expect(d.reason).toBe("gas at or below target");
    expect(d.targetWei).toBe(gwei(4));
  });

  it("a high price is held while stored history says it is not cheap", async () => {
    const c2 = clock();
    const file = tmp();
    for (const p of [1, 1, 1, 1, 1]) { await holdUntilFavourable({ deadline: new Date(c2.t + 1), target: { kind: "price", wei: 0n }, intervalMs: 1, stateFile: file, now: c2.now, sleep: c2.sleep, sample: async () => sampleAt(c2.t, p) }); }
    let j = 0;
    const p2 = [9, 9, 1];
    const d2 = await holdUntilFavourable({ deadline: new Date(c2.t + 600_000), target: { kind: "percentile", p: 25, window: 10 }, intervalMs: 1000, stateFile: file, now: c2.now, sleep: c2.sleep, sample: async () => sampleAt(c2.t, p2[j++]!) });
    expect(d2.samplesTaken).toBe(3); // 9 and 9 are held against stored history, 1 passes
    expect(d2.decisionPriceWei).toBe(gwei(1));
  });

  it("a flat chain passes a percentile target once the warm-up is done", async () => {
    const c = clock();
    const d = await holdUntilFavourable({ deadline: new Date(c.t + 600_000), target: { kind: "percentile", p: 25, window: 10 }, intervalMs: 1000, stateFile: tmp(), now: c.now, sleep: c.sleep, sample: async () => sampleAt(c.t, 1) });
    expect(d.reason).toBe("gas at or below target");
    expect(d.samplesTaken).toBe(5);
  });
});

describe("paidReport", () => {
  it("compares gas paid with the request-time price", () => {
    expect(paidReport(21000n, gwei(1), gwei(2))).toEqual({ paidWei: 21000n * gwei(1), atRequestPriceWei: 21000n * gwei(2), savedWei: 21000n * gwei(1), savedPct: "50.00" });
    expect(paidReport(21000n, gwei(3), gwei(2)).savedPct).toBe("-50.00");
    expect(paidReport(21000n, gwei(1), 0n).savedPct).toBe("0.00");
  });
});
