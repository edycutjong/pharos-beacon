import { describe, expect, it, vi } from "vitest";
import { parseEther, parseGwei, type Hex } from "viem";
import { evaluate, formatVerdict } from "../src/guardian/evaluate.js";
import { guard, type Signer } from "../src/guardian/guard.js";
import type { Policy } from "../src/guardian/policy.js";
import type { Reader } from "../src/guardian/reader.js";

const SELF = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975" as Hex;
const TO = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B" as Hex;
const TOKEN = "0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8" as Hex;
const TX = `0x${"b".repeat(64)}` as Hex;

function fakeReader(over: Partial<Reader> = {}): Reader {
  return {
    blockNumber: async () => 1000n,
    nativeBalance: async () => parseEther("15"),
    erc20Balance: async () => 2_500_000n,
    erc20Decimals: async () => 6,
    gasPrice: async () => parseGwei("10"),
    code: async (a) => (a === TOKEN ? "0x6080" : "0x"),
    nonces: async () => ({ latest: 6n, pending: 6n }),
    logCount: async () => 12,
    receipt: async () => ({ status: "success", blockNumber: 1002n }),
    ...over,
  };
}

const policy: Policy = {
  name: "t",
  network: "atlantic",
  conditions: [
    { kind: "native_balance", address: "$SELF", op: "gte", value: "1" },
    { kind: "erc20_balance", token: TOKEN, address: "$SELF", op: "gte", value: "2.5" },
    { kind: "gas_price", op: "lte", gwei: "50" },
    { kind: "is_contract", address: TO, expect: false },
    { kind: "is_contract", address: TOKEN, expect: true },
    { kind: "nonce_settled", address: "$SELF" },
    { kind: "log_activity", address: TOKEN, blocks: 100, op: "gte", count: 10 },
  ],
  action: { type: "native_transfer", to: TO, amount: "0.001" },
};

function fakeSigner(): Signer & { sent: [Hex, bigint][] } {
  const sent: [Hex, bigint][] = [];
  return { address: SELF, sent, sendNative: async (to, value) => (sent.push([to, value]), TX) };
}

describe("evaluate", () => {
  it("allows when every condition passes, all pinned to one block", async () => {
    const logCount = vi.fn(async () => 12);
    const v = await evaluate(policy, fakeReader({ logCount }), SELF);
    expect(v.allow).toBe(true);
    expect(v.block).toBe("1000");
    expect(v.checks.map((c) => c.pass)).toEqual(Array(7).fill(true));
    expect(logCount).toHaveBeenCalledWith(TOKEN, undefined, 901n, 1000n);
    expect(v.checks[1].observed).toBe("2.5");
  });

  it("denies when one threshold misses and says which", async () => {
    const v = await evaluate(policy, fakeReader({ gasPrice: async () => parseGwei("51") }), SELF);
    expect(v.allow).toBe(false);
    expect(v.checks.filter((c) => !c.pass).map((c) => c.kind)).toEqual(["gas_price"]);
    expect(formatVerdict(v)).toMatch(/FAIL {2}gas price: 51 gwei \(need <= 50 gwei\)[\s\S]*DENY \(6\/7/);
  });

  it("fails closed when a read throws", async () => {
    const v = await evaluate(policy, fakeReader({ nonces: async () => { throw new Error("429 rate limited"); } }), SELF);
    expect(v.allow).toBe(false);
    expect(v.checks[5]).toMatchObject({ pass: false, observed: "read failed", error: "429 rate limited" });
  });

  it("denies a stuck nonce", async () => {
    const v = await evaluate(policy, fakeReader({ nonces: async () => ({ latest: 6n, pending: 7n }) }), SELF);
    expect(v.allow).toBe(false);
  });

  it("fails $SELF conditions without a wallet instead of guessing an address", async () => {
    const v = await evaluate(policy, fakeReader());
    expect(v.allow).toBe(false);
    expect(v.checks[0].error).toMatch(/\$SELF/);
  });
});

describe("guard", () => {
  it("does not send on DENY", async () => {
    const s = fakeSigner();
    const o = await guard(policy, fakeReader({ nativeBalance: async () => parseEther("0.5") }), s, { execute: true });
    expect(o.status).toBe("denied");
    expect(s.sent).toEqual([]);
  });

  it("is a dry run without --execute", async () => {
    const s = fakeSigner();
    expect((await guard(policy, fakeReader(), s)).status).toBe("dry-run");
    expect(s.sent).toEqual([]);
  });

  it("aborts when a condition flips between check and send", async () => {
    const s = fakeSigner();
    let n = 0;
    const gasPrice = async () => (n++ === 0 ? parseGwei("10") : parseGwei("99"));
    const o = await guard(policy, fakeReader({ gasPrice }), s, { execute: true });
    expect(o.status).toBe("aborted");
    expect(s.sent).toEqual([]);
  });

  it("sends once after a passing re-check and confirms the receipt via the reader", async () => {
    const s = fakeSigner();
    let polls = 0;
    const receipt = async () => (++polls < 3 ? null : { status: "success" as const, blockNumber: 1002n });
    const o = await guard(policy, fakeReader({ receipt }), s, { execute: true, sleep: async () => {} });
    expect(o).toMatchObject({ status: "executed", tx: TX, receipt: { status: "success", blockNumber: "1002" } });
    expect(s.sent).toEqual([[TO, parseEther("0.001")]]);
    expect(polls).toBe(3);
  });

  it("throws (never resends) when the receipt never shows up", async () => {
    const s = fakeSigner();
    await expect(guard(policy, fakeReader({ receipt: async () => null }), s, { execute: true, receiptPolls: 2, sleep: async () => {} })).rejects.toThrow(
      /no receipt/,
    );
    expect(s.sent).toHaveLength(1);
  });

  it("refuses --execute without a signer", async () => {
    const p: Policy = { ...policy, conditions: [{ kind: "gas_price", op: "lte", gwei: "50" }] };
    await expect(guard(p, fakeReader(), undefined, { execute: true })).rejects.toThrow(/signing wallet/);
  });
});

describe("guard receipt handling", () => {
  it("reports a reverted transfer as reverted, not executed", async () => {
    const s = fakeSigner();
    const o = await guard(policy, fakeReader({ receipt: async () => ({ status: "reverted", blockNumber: 1002n }) }), s, { execute: true });
    expect(o.status).toBe("reverted");
  });

  it("surfaces the last receipt read error after polling out", async () => {
    const s = fakeSigner();
    const receipt = async () => { throw new Error("MCP 429"); };
    await expect(guard(policy, fakeReader({ receipt }), s, { execute: true, receiptPolls: 2, sleep: async () => {} })).rejects.toThrow(/last error: MCP 429/);
  });
});
