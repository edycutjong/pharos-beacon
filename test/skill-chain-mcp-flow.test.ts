import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { main, traced, type TraceEntry } from "../tasks/skill-chain-mcp-flow/index.js";
import { DEFAULT_TIERS, TRANSFER_TOPIC, coins, judge, latestTransaction, observedBlockSeconds, parseCoins, parseTiers, render, requiredFor, type Call } from "../src/settle/verdict.js";

const H = ("0x" + "ab".repeat(32)) as Hex;
const ME = "0x1111111111111111111111111111111111111111";
const YOU = "0x2222222222222222222222222222222222222222";
const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
const ONE = 10n ** 18n;

interface World { tx?: object | null; receipt?: object | null; head?: number; blocks?: Record<string, object | null> }
/** A fake Chain MCP: the transaction, its receipt, the head, and block timestamps at 1 s per block. */
function fake(w: World) {
  const seen: { tool: string; args: any }[] = [];
  const head = w.head ?? 100;
  const call = (async (tool: string, args: any) => {
    seen.push({ tool, args });
    if (tool === "get_transaction") return w.tx === undefined ? { hash: H, from: ME, to: YOU, value: hex(0) } : w.tx;
    if (tool === "get_transaction_receipt") return w.receipt === undefined ? null : w.receipt;
    if (tool === "get_block_number") return { blockNumber: String(head) };
    if (tool === "get_block") {
      if (w.blocks && args.block in w.blocks) return w.blocks[args.block];
      return { timestamp: hex(1_700_000_000 + Number(args.block)), transactions: [] };
    }
    throw new Error(`unexpected tool ${tool}`);
  }) as unknown as Call;
  return { call, seen };
}
const receipt = (block: number, status = "0x1", logs: object[] = []) => ({ blockNumber: hex(block), status, gasUsed: hex(21000), logs });

describe("tiers", () => {
  it("parses, rejects bad tiers", () => {
    expect(parseTiers("1=3,100=12,*=32")).toEqual(DEFAULT_TIERS);
    expect(() => parseTiers("1=3")).toThrow(/exactly one \*/);
    expect(() => parseTiers("*=3,1=2")).toThrow(/exactly one \*/);
    expect(() => parseTiers("5=3,2=4,*=9")).toThrow(/ascend/);
    expect(() => parseTiers("1=0,*=2")).toThrow(/at least 1/);
    expect(() => parseTiers("one=3,*=2")).toThrow(/not <coins>/);
  });
  it("picks the tier by value, and treats a token transfer with no native value as at least the middle tier", () => {
    expect(requiredFor(0n, 0, DEFAULT_TIERS).required).toBe(3);
    expect(requiredFor(ONE - 1n, 0, DEFAULT_TIERS).required).toBe(3);
    expect(requiredFor(ONE, 0, DEFAULT_TIERS).required).toBe(12);
    expect(requiredFor(100n * ONE, 0, DEFAULT_TIERS).required).toBe(32);
    expect(requiredFor(0n, 2, DEFAULT_TIERS)).toMatchObject({ required: 12 });
    expect(requiredFor(0n, 2, DEFAULT_TIERS).tier).toMatch(/worth is unknown/);
    expect(requiredFor(0n, 2, [{ below: null, confirmations: 4 }]).required).toBe(4);
  });
  it("converts coin amounts exactly", () => {
    expect(parseCoins("1.5")).toBe(ONE + ONE / 2n);
    expect(coins(ONE + ONE / 2n)).toBe("1.5");
    expect(coins(0n)).toBe("0");
    expect(() => parseCoins("1,5")).toThrow(/not a coin amount/);
  });
});

describe("judge", () => {
  it("NOT_FOUND when the node has no such transaction, and reads nothing further", async () => {
    const { call, seen } = fake({ tx: null });
    const r = await judge(call, H);
    expect(r.verdict).toBe("NOT_FOUND");
    expect(seen.map((s) => s.tool)).toEqual(["get_transaction", "get_block_number"]);
  });
  it("WAIT when known but not mined", async () => {
    const r = await judge(fake({ receipt: null }).call, H);
    expect(r).toMatchObject({ verdict: "WAIT", rule: expect.stringMatching(/not mined yet/) });
  });
  it("FAILED on a reverted receipt, at any depth", async () => {
    const r = await judge(fake({ receipt: receipt(50, "0x0") }).call, H);
    expect(r).toMatchObject({ verdict: "FAILED", confirmations: 51 });
    expect(r.rule).toMatch(/status is 0x0/);
  });
  it("WAIT with a block count and a time from the observed block time", async () => {
    const r = await judge(fake({ head: 101, receipt: receipt(100) }).call, H);
    expect(r).toMatchObject({ verdict: "WAIT", confirmations: 2, required: 3, waitBlocks: 1, waitSeconds: 1 });
    expect(r.facts.blockSeconds).toBe(1);
  });
  it("SETTLED once the confirmations reach the tier, not before", async () => {
    expect((await judge(fake({ head: 102, receipt: receipt(100) }).call, H)).verdict).toBe("SETTLED");
    expect((await judge(fake({ head: 101, receipt: receipt(100) }).call, H)).verdict).toBe("WAIT");
  });
  it("a larger value needs more confirmations from the same chain state", async () => {
    const tx = { hash: H, from: ME, to: YOU, value: hex(5n * ONE) };
    const r = await judge(fake({ tx, head: 110, receipt: receipt(100) }).call, H);
    expect(r).toMatchObject({ verdict: "WAIT", confirmations: 11, required: 12, waitBlocks: 1 });
    expect((await judge(fake({ tx, head: 111, receipt: receipt(100) }).call, H)).verdict).toBe("SETTLED");
  });
  it("the caller's --confirmations replaces the tier", async () => {
    const r = await judge(fake({ head: 100, receipt: receipt(100) }).call, H, { override: 1 });
    expect(r).toMatchObject({ verdict: "SETTLED", required: 1 });
  });
  it("MISMATCH for a wrong recipient or too little value, even when deep enough", async () => {
    const w = { head: 500, receipt: receipt(100) };
    const a = await judge(fake(w).call, H, { expect: { to: ME } });
    expect(a).toMatchObject({ verdict: "MISMATCH" });
    expect(a.rule).toContain(`expected recipient ${ME}`);
    const b = await judge(fake(w).call, H, { expect: { minValue: "0.5" } });
    expect(b.rule).toMatch(/at least 0.5 native value but the transaction carried 0/);
    expect((await judge(fake(w).call, H, { expect: { to: YOU.toUpperCase().replace("0X", "0x") as Hex } })).verdict).toBe("SETTLED");
  });
  it("a failed transaction is FAILED, not MISMATCH, even with a wrong recipient", async () => {
    expect((await judge(fake({ receipt: receipt(50, "0x0") }).call, H, { expect: { to: ME } })).verdict).toBe("FAILED");
  });
  it("counts ERC-20 transfers in the receipt", async () => {
    const r = await judge(fake({ head: 105, receipt: receipt(100, "0x1", [{ topics: [TRANSFER_TOPIC] }, { topics: ["0x01"] }]) }).call, H);
    expect(r).toMatchObject({ verdict: "WAIT", required: 12 });
    expect(r.facts.tokenTransfers).toBe(1);
  });
  it("contract creation has no recipient", async () => {
    const tx = { hash: H, from: ME, to: null, value: hex(0) };
    const r = await judge(fake({ tx, head: 500, receipt: receipt(100) }).call, H, { expect: { to: ME } });
    expect(r.rule).toContain("a contract creation");
  });
  it("block time is undefined on a young chain or unusable timestamps", async () => {
    expect(await observedBlockSeconds(fake({}).call, 0n)).toBeUndefined();
    expect(await observedBlockSeconds(fake({ blocks: { "100": { timestamp: hex(5) }, "80": null } }).call, 100n)).toBeUndefined();
    expect(await observedBlockSeconds(fake({ blocks: { "100": { timestamp: hex(5) }, "80": { timestamp: hex(5) } } }).call, 100n)).toBeUndefined();
    expect(await observedBlockSeconds(fake({}).call, 5n)).toBe(1);
  });
});

describe("latestTransaction", () => {
  it("returns the newest block's first hash, scanning back over empty blocks", async () => {
    const { call } = fake({ head: 100, blocks: { "98": { transactions: [H] } } });
    expect(await latestTransaction(call)).toEqual({ hash: H, block: 98n });
    const objs = fake({ head: 100, blocks: { "100": { transactions: [{ hash: H }] } } });
    expect(await latestTransaction(objs.call)).toEqual({ hash: H, block: 100n });
    expect(await latestTransaction(fake({ head: 100 }).call, 5)).toBeUndefined();
  });
});

describe("render", () => {
  it("prints the rule and depth", async () => {
    const out = render(await judge(fake({ head: 101, receipt: receipt(100) }).call, H), "pharos (chain 1672)");
    expect(out).toMatch(/^VERDICT WAIT\nrule    mined with status 0x1 but 2 confirmation\(s\)/);
    expect(out).toContain("wait    1 more block(s), about 1 s at the observed 1 s per block");
    expect(render(await judge(fake({ tx: null }).call, H), "x")).toContain("head    block 100");
  });
});

describe("cli", () => {
  const cli = (w: World, argv: string[]) => {
    const f = fake(w);
    const connect = (async () => ({ call: f.call, close: async () => {}, chainId: 1672, endpoint: "fake", network: "pharos", server: undefined })) as never;
    return { f, run: () => main({ onExit: () => {} } as never, argv, connect) };
  };
  it("rejects bad input before connecting", async () => {
    for (const [argv, msg] of [
      [[], /give a transaction hash/],
      [["0x12"], /not a transaction hash/],
      [[H, "--latest"], /not both/],
      [[H, "--expect-to", "nope"], /--expect-to/],
      [[H, "--min-value", "x"], /--min-value/],
      [[H, "--tiers", "3"], /--tiers/],
      [[H, "--confirmations", "0"], /--confirmations/],
      [[H, "--follow", "9999"], /--follow/],
    ] as [string[], RegExp][]) {
      await expect(cli({}, argv).run()).rejects.toThrow(msg);
    }
  });
  it("exit codes: 0 settled, 2 wait, 1 otherwise", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await cli({ head: 200, receipt: receipt(100) }, [H]).run()).toBe(0);
    expect(await cli({ head: 100, receipt: receipt(100) }, [H]).run()).toBe(2);
    expect(await cli({ tx: null }, [H]).run()).toBe(1);
    expect(await cli({ head: 200, receipt: receipt(100, "0x0") }, [H]).run()).toBe(1);
  });
  it("--latest picks the newest transaction and says so", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await cli({ head: 200, receipt: receipt(100), blocks: { "200": { transactions: [H] } } }, ["--latest"]).run();
    expect(log.mock.calls.flat().join("\n")).toContain(`latest transaction: ${H} (block 200)`);
  });
  it("--follow asks again until the depth is reached, then stops", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let head = 100;
    const calls: string[] = [];
    const call = (async (tool: string) => {
      calls.push(tool);
      if (tool === "get_transaction") return { hash: H, from: ME, to: YOU, value: hex(0) };
      if (tool === "get_transaction_receipt") return receipt(100);
      if (tool === "get_block_number") return { blockNumber: String(head++) };
      return { timestamp: hex(1_700_000_000), transactions: [] };
    }) as unknown as Call;
    const connect = (async () => ({ call, close: async () => {}, chainId: 1672, endpoint: "fake", network: "pharos" })) as never;
    const p = main({ onExit: () => {} } as never, [H, "--follow", "60"], connect);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBe(0);
    const text = log.mock.calls.flat().join("\n");
    expect(text).toContain("WAIT  1/3 confirmations at head 100");
    expect(text).toContain("VERDICT SETTLED");
    vi.useRealTimers();
  });
  it("writes a proof with the ordered tool calls", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const name = `test-${Date.now()}`;
    const { run } = cli({ head: 200, receipt: receipt(100) }, [H, "--proof", name]);
    expect(await run()).toBe(0);
    const file = new URL(`../tasks/skill-chain-mcp-flow/proof/${name}.json`, import.meta.url);
    const p = JSON.parse(readFileSync(file, "utf8"));
    expect(p.verdict).toBe("SETTLED");
    expect(p.flow.map((s: TraceEntry) => s.tool)).toEqual(["get_transaction", "get_block_number", "get_transaction_receipt", "get_block", "get_block"]);
    expect(p.flow.map((s: TraceEntry) => s.step)).toEqual([1, 2, 3, 4, 5]);
    (await import("node:fs")).rmSync(file);
  });
});

describe("traced", () => {
  it("records tool, args and order", async () => {
    const trace: TraceEntry[] = [];
    const c = traced((async (t: string) => t) as unknown as Call, trace);
    await c("a" as never, { x: 1 });
    await c("b" as never);
    expect(trace.map((t) => [t.step, t.tool, t.args])).toEqual([[1, "a", { x: 1 }], [2, "b", {}]]);
  });
});
