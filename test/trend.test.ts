import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChainMcp } from "../src/lib/mcp.js";
import { addObservation, describeSlope, evaluate, fmt, historyTable, loadTrend, observe, parseMetric, readMetric, saveTrend, slopeAt, sparkline, type MetricSpec, type Observation, type Rule } from "../src/trend/watch.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const spec: MetricSpec = { kind: "balance", network: "atlantic", address: WALLET };
const rule: Rule = { direction: "fall", steps: 3 };
const dir = () => mkdtempSync(join(tmpdir(), "trend-"));
const obs = (values: number[], startBlock = 100): Observation[] => values.map((v, i) => ({ block: String(startBlock + i * 10), value: String(v), at: new Date(i * 1000).toISOString() }));

/** A fake Chain MCP whose balance and block number follow a script, one entry per call to get_block_number. */
function chain(script: { block: number; balance: number }[]) {
  let i = -1;
  const call = (async (name: string, args?: { block?: string }) => {
    if (name === "get_block_number") { i++; return { blockNumber: String(script[Math.min(i, script.length - 1)]!.block) }; }
    if (name === "get_balance") {
      const row = script.find((r) => String(r.block) === args?.block);
      if (!row) throw new Error(`no scripted balance at block ${args?.block}`);
      return { balanceWei: String(row.balance) };
    }
    throw new Error(`unexpected ${name}`);
  }) as unknown as ChainMcp["call"];
  return call;
}

describe("evaluate: the rule", () => {
  it("needs at least 3 observations: steps below 2 is refused, 3 observations can trigger a 2-move rule", () => {
    expect(() => evaluate(obs([3, 2, 1]), { direction: "fall", steps: 1 })).toThrow(/at least 3/);
    expect(evaluate(obs([3, 2, 1]), { direction: "fall", steps: 2 }).triggers).toEqual([2]);
    expect(evaluate(obs([3, 2]), { direction: "fall", steps: 2 }).state).toBe("too-few");
  });
  it("triggers on the observation where the 3rd consecutive fall lands, once", () => {
    const e = evaluate(obs([10, 9, 8, 7, 6, 5]), rule);
    expect(e.triggers).toEqual([3]); // 10→9→8→7: the third fall is observation index 3
    expect(e.streak).toBe(5);
    expect(e.state).toBe("triggered");
  });
  it("a single spike never triggers, down or up", () => {
    expect(evaluate(obs([10, 10, 4, 10, 10]), rule)).toMatchObject({ triggers: [], state: "none" });
    expect(evaluate(obs([10, 9, 10, 9, 10, 9]), rule).triggers).toEqual([]);
    expect(evaluate(obs([10, 10, 99, 10]), { direction: "rise", steps: 3 }).triggers).toEqual([]);
  });
  it("a flat step or a rise resets the streak, and the streak can re-trigger afterwards", () => {
    expect(evaluate(obs([10, 9, 8, 8, 7]), rule).triggers).toEqual([]);
    expect(evaluate(obs([10, 9, 8, 7, 8, 7, 6, 5]), rule).triggers).toEqual([3, 7]);
  });
  it("rise is the mirror image", () => {
    expect(evaluate(obs([1, 2, 3, 4]), { direction: "rise", steps: 3 }).triggers).toEqual([3]);
  });
});

describe("addObservation: no duplicates, no going back", () => {
  const base = { metric: spec, observations: obs([5, 4]), acted: [] as string[] };
  it("stores a newer block, de-duplicates the same block and refuses an older one", () => {
    const o3 = { block: "120", value: "3", at: "t" };
    const added = addObservation(base, o3);
    expect(added.status).toBe("added");
    expect(added.state.observations).toHaveLength(3);
    expect(addObservation(added.state, o3).status).toBe("duplicate");
    expect(addObservation(added.state, { block: "110", value: "9", at: "t" }).status).toBe("stale");
    expect(addObservation(added.state, o3).state.observations).toHaveLength(3);
  });
});

describe("persistence and restart", () => {
  it("history survives restarts: each run loads the file, and a repeated block is not stored twice", async () => {
    const file = join(dir(), "h.json");
    const script = [{ block: 10, balance: 100 }, { block: 20, balance: 90 }, { block: 30, balance: 80 }, { block: 40, balance: 70 }];
    const messages: string[] = [];
    const call = chain(script); // one chain: its head block advances with every run
    const run = (pin?: bigint) => observe({ file, spec, rule, call, pinBlock: pin, act: async (m) => { messages.push(m); } });
    const r1 = await run(), r2 = await run(), r3 = await run();
    expect([r1.added, r2.added, r3.added]).toEqual(["added", "added", "added"]);
    expect(messages).toHaveLength(0); // 3 observations: 2 falls so far
    const r4 = await run();
    expect(r4.evaluation.state).toBe("triggered");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/TREND MET.*3 consecutive falls at observation #4 \(block 40.*slope -0\.0000000000000000?\d+ PHRS per observation/s);
    // a restart that reads the same block again changes nothing and does not act again
    const again = await run(40n);
    expect(again.added).toBe("duplicate");
    expect(again.acted).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(loadTrend(file, spec).observations.map((o) => o.block)).toEqual(["10", "20", "30", "40"]);
  });
  it("a failed action is retried by the next run, and a succeeded one is never repeated", async () => {
    const file = join(dir(), "h.json");
    saveTrend(file, { metric: spec, observations: obs([10, 9, 8, 7]), acted: [] });
    const script = [{ block: 500, balance: 6 }];
    await expect(observe({ file, spec, rule, call: chain(script), act: async () => { throw new Error("discord down"); } })).rejects.toThrow(/discord down/);
    expect(loadTrend(file, spec).acted).toEqual([]);
    const sent: number[] = [];
    const r = await observe({ file, spec, rule, call: chain(script), pinBlock: 500n, act: async (_m, i) => { sent.push(i); } });
    expect(sent).toEqual([3]); // the trigger the crashed run left behind; the new observation (5th fall) is not a new trigger
    expect(r.state.acted).toEqual(["130"]);
    await observe({ file, spec, rule, call: chain(script), pinBlock: 500n, act: async (_m, i) => { sent.push(i); } });
    expect(sent).toEqual([3]);
  });
  it("refuses a history of another metric, a corrupt file, and out-of-order blocks", () => {
    const file = join(dir(), "h.json");
    saveTrend(file, { metric: { kind: "basefee", network: "atlantic" }, observations: [], acted: [] });
    expect(() => loadTrend(file, spec)).toThrow(/different metric/);
    writeFileSync(file, "{ not json");
    expect(() => loadTrend(file, spec)).toThrow();
    saveTrend(file, { metric: spec, observations: [{ block: "5", value: "1", at: "t" }, { block: "4", value: "1", at: "t" }], acted: [] });
    expect(() => loadTrend(file, spec)).toThrow(/wrong shape/);
  });
  it("survives kill -9 in the middle of a write loop: the file parses, blocks are in order, nothing is half-written", { timeout: 30_000 }, async () => {
    const file = join(dir(), "h.json");
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "test/helpers/trend-writer-child.ts"), file], { stdio: ["ignore", "pipe", "ignore"] });
    let wrote = 0;
    await new Promise<void>((r) => child.stdout.on("data", (d) => { wrote = Number(String(d).trim().split("\n").at(-1)!.split(" ")[1]); if (wrote >= 25) r(); }));
    child.kill("SIGKILL"); // one process (node --import tsx), not the tsx wrapper: the kill lands on the writer itself
    await new Promise((r) => child.on("close", r));
    const st = loadTrend(file, { kind: "basefee", network: "atlantic" }); // throws if the file is torn or out of order
    const blocks = st.observations.map((o) => Number(o.block));
    expect(blocks.length).toBeGreaterThanOrEqual(25);
    expect(blocks).toEqual(blocks.map((_, i) => i + 1)); // no gap, no duplicate
    expect(readdirSync(join(file, "..")).filter((f) => f.endsWith(".tmp")).length).toBeLessThanOrEqual(1); // at most the one in flight
  });
});

describe("readMetric", () => {
  it("reads the value AT the block it stores", async () => {
    const o = await readMetric(chain([{ block: 77, balance: 5 }]), spec, undefined, () => new Date(0));
    expect(o).toEqual({ block: "77", value: "5", at: "1970-01-01T00:00:00.000Z" });
  });
  it("supply: reads totalSupply() at the pinned block, and refuses a non-uint256 answer", async () => {
    const seen: unknown[] = [];
    const call = (async (_n: string, a: unknown) => { seen.push(a); return { result: `0x${"0".repeat(63)}7` }; }) as unknown as ChainMcp["call"];
    const s = parseMetric({ metric: "supply", network: "pharos", token: "0x2222222222222222222222222222222222222222" });
    expect((await readMetric(call, s, 9n)).value).toBe("7");
    expect(seen[0]).toMatchObject({ block: "9", transaction: { data: "0x18160ddd" } });
    const bad = (async () => ({ result: "0x" })) as unknown as ChainMcp["call"];
    await expect(readMetric(bad, s, 9n)).rejects.toThrow(/not an ERC-20/);
  });
  it("basefee: refuses a block without a base fee", async () => {
    const call = (async () => ({ number: "0x1" })) as unknown as ChainMcp["call"];
    await expect(readMetric(call, { kind: "basefee", network: "atlantic" }, 1n)).rejects.toThrow(/no base fee/);
  });
  it("rejects a bad metric spec", () => {
    expect(() => parseMetric({ metric: "balance", network: "atlantic" })).toThrow(/--address/);
    expect(() => parseMetric({ metric: "price", network: "atlantic" })).toThrow(/unknown metric/);
  });
});

describe("history, sparkline and slope (the extra)", () => {
  it("draws a sparkline from low to high and flat as the lowest bar", () => {
    expect(sparkline([0n, 7n])).toBe("▁█");
    expect(sparkline([5n, 5n, 5n])).toBe("▁▁▁");
  });
  it("prints the slope over the streak window", () => {
    const o = obs([1000, 900, 700, 400], 100); // blocks 100,110,120,130
    const s = slopeAt(o, 3, 3);
    expect(s).toMatchObject({ total: -600n, perObservation: -200n, perBlock: -20n, blocks: 30n });
    expect(describeSlope({ kind: "basefee", network: "atlantic" }, s)).toContain("per block");
  });
  it("names the network's own coin: PROS on mainnet, PHRS on Atlantic", () => {
    const main: MetricSpec = { kind: "balance", network: "pharos", address: WALLET };
    expect(fmt(main, 10n ** 18n)).toBe("1 PROS");
    expect(fmt(spec, 10n ** 18n)).toBe("1 PHRS");
    expect(describeSlope(main, slopeAt(obs([1000, 900, 700, 400], 100), 3, 3))).toContain("PROS per observation");
  });
  it("marks the exact observation where the trend was met", () => {
    const table = historyTable(spec, obs([10, 10, 5, 10, 9, 8, 7]), rule);
    const marked = table.split("\n").filter((l) => l.includes("TREND MET"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatch(/#7\s+block 160/);
    expect(table).toMatch(/\(triggered, current streak 3\/3\)/);
    expect(table).not.toMatch(/#3.*TREND MET/); // the single dip at #3 did not trigger
  });
  it("is stable for an empty history", () => {
    expect(historyTable(spec, [], rule)).toBe("no observations yet");
  });
});
