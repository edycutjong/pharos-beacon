import { encodeErrorResult } from "viem";
import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ChainToolError, ClientClosedError, type ChainMcp } from "../src/lib/mcp.js";
import { BroadcastError, BroadcastUnclearError, UnresolvedTxError, type SignedTx, type TestnetSigner } from "../src/lib/signer.js";
import { errorsAbi } from "../src/saga/defi.js";
import { chainPort } from "../src/saga/port.js";

// Polling waits 2.5 s between receipts; the tests do not.
vi.mock("../src/lib/net.js", async (orig) => ({ ...(await orig<typeof import("../src/lib/net.js")>()), wait: vi.fn(async () => undefined) }));

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const TO = "0x1111111111111111111111111111111111111111" as Hex;
const prepared = () => ({ chainId: 688689, to: TO, value: 0n, nonce: 7, gas: 21_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 10n });

function setup(answers: Record<string, unknown> = {}, signerOver: Partial<TestnetSigner> = {}) {
  const calls: { tool: string; args: any }[] = [];
  const mcp = {
    call: vi.fn(async (tool: string, args: any) => {
      calls.push({ tool, args });
      const a = answers[tool];
      if (a instanceof Error) throw a;
      return typeof a === "function" ? (a as any)(args) : a;
    }),
  } as unknown as ChainMcp;
  const signer = {
    prepare: vi.fn(async () => prepared()),
    sign: vi.fn(async (tx: ReturnType<typeof prepared>) => ({ hash: H(1), raw: "0xraw" as Hex, tx }) as SignedTx),
    broadcast: vi.fn(async () => undefined),
    ...signerOver,
  } as unknown as TestnetSigner;
  return { port: chainPort(mcp, signer), mcp, signer, calls };
}

describe("chainPort.sign", () => {
  it("prepares, signs and reports the fields the engine needs", async () => {
    const { port, signer } = setup();
    const out = await port.sign({ to: TO, value: 5n, data: "0x12" }, { nonce: 7, gas: 50_000n });
    expect(signer.prepare).toHaveBeenCalledWith({ to: TO, value: 5n, data: "0x12", nonce: 7, gas: 50_000n });
    expect(out).toEqual({ hash: H(1), raw: "0xraw", nonce: 7, maxFeePerGas: 100n, maxPriorityFeePerGas: 10n, gas: 21_000n });
  });

  it("leaves nonce and gas out of the intent when the engine gives none", async () => {
    const { port, signer } = setup();
    await port.sign({ to: TO, value: 0n, data: "0x" }, {});
    expect(signer.prepare).toHaveBeenCalledWith({ to: TO, value: 0n, data: "0x" });
  });

  it("never pays less than the bumped fee", async () => {
    const { port } = setup();
    const out = await port.sign({ to: TO, value: 0n, data: "0x" }, { minMaxFee: 500n });
    expect(out.maxFeePerGas).toBe(500n);
    expect(out.maxPriorityFeePerGas).toBe(10n);
  });

  it("an injected fee override zeroes the tip", async () => {
    const { port } = setup();
    const out = await port.sign({ to: TO, value: 0n, data: "0x" }, { maxFeeOverride: 1n });
    expect(out.maxFeePerGas).toBe(1n);
    expect(out.maxPriorityFeePerGas).toBe(0n);
  });

  it("caps the tip at the max fee", async () => {
    const { port, signer } = setup({}, { prepare: vi.fn(async () => ({ ...prepared(), maxFeePerGas: 5n, maxPriorityFeePerGas: 9n })) as any });
    const out = await port.sign({ to: TO, value: 0n, data: "0x" }, {});
    expect(out.maxPriorityFeePerGas).toBe(5n);
    expect(signer.sign).toHaveBeenCalled();
  });

  it("turns an unresolved earlier tx into a timeout error", async () => {
    const signed = { hash: H(9), raw: "0x", tx: prepared() } as SignedTx;
    const { port } = setup({}, { prepare: vi.fn(async () => { throw new UnresolvedTxError(signed); }) as any });
    await expect(port.sign({ to: TO, value: 0n, data: "0x" }, {})).rejects.toThrow(/^timeout: transaction 0x0+9 /);
  });

  it("decodes a custom revert error with its arguments", async () => {
    const data = encodeErrorResult({ abi: errorsAbi, errorName: "CapExceeded", args: [10n, 12n] });
    const { port } = setup({}, { prepare: vi.fn(async () => { throw new ChainToolError("estimate_gas", "execution reverted", 3, data); }) as any });
    const err = await port.sign({ to: TO, value: 0n, data: "0x" }, {}).catch((e) => e);
    expect(err.message).toBe("reverted: CapExceeded(10, 12)");
    expect(err.code).toBe(3);
  });

  it("names a revert with no arguments, and keeps the reason when there is no data", async () => {
    const data = encodeErrorResult({ abi: errorsAbi, errorName: "VaultClosed" });
    const a = setup({}, { prepare: vi.fn(async () => { throw new ChainToolError("estimate_gas", "x", 3, data); }) as any });
    await expect(a.port.sign({ to: TO, value: 0n, data: "0x" }, {})).rejects.toThrow("reverted: VaultClosed()");
    const b = setup({}, { prepare: vi.fn(async () => { throw new ChainToolError("estimate_gas", "execution reverted", 3); }) as any });
    await expect(b.port.sign({ to: TO, value: 0n, data: "0x" }, {})).rejects.toThrow("reverted: execution reverted");
  });

  it("reports an undecodable selector instead of guessing", async () => {
    const { port } = setup({}, { prepare: vi.fn(async () => { throw new ChainToolError("estimate_gas", "r", 3, "0xdeadbeef00"); }) as any });
    await expect(port.sign({ to: TO, value: 0n, data: "0x" }, {})).rejects.toThrow("reverted: unknown error 0xdeadbeef");
  });

  it("passes other errors through, wrapping non-Errors", async () => {
    const boom = new Error("rpc down");
    const a = setup({}, { prepare: vi.fn(async () => { throw boom; }) as any });
    await expect(a.port.sign({ to: TO, value: 0n, data: "0x" }, {})).rejects.toBe(boom);
    const b = setup({}, { prepare: vi.fn(async () => { throw "plain string"; }) as any });
    await expect(b.port.sign({ to: TO, value: 0n, data: "0x" }, {})).rejects.toThrow("plain string");
  });
});

describe("chainPort.broadcast", () => {
  it("rebroadcasts the signed tx it remembers", async () => {
    const { port, signer } = setup();
    const s = await port.sign({ to: TO, value: 0n, data: "0x" }, {});
    await port.broadcast(s);
    expect((signer.broadcast as any).mock.calls[0][0].tx.nonce).toBe(7);
  });

  it("rebuilds an unknown signed tx from the journal fields", async () => {
    const { port, signer } = setup();
    await port.broadcast({ hash: H(5), raw: "0xabc", nonce: 3, gas: 1n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
    const sent = (signer.broadcast as any).mock.calls[0][0] as SignedTx;
    expect(sent).toMatchObject({ hash: H(5), raw: "0xabc", tx: { nonce: 3, gas: 1n, maxFeePerGas: 2n, to: "0x0000000000000000000000000000000000000000" } });
  });

  const f = { hash: H(5), raw: "0xabc" as Hex, nonce: 3, gas: 1n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  const sgn = { hash: H(5), raw: "0xabc", tx: prepared() } as SignedTx;

  it("an unclear broadcast is a transient timeout", async () => {
    const { port } = setup({}, { broadcast: vi.fn(async () => { throw new BroadcastUnclearError(sgn, new Error("socket hang up")); }) as any });
    await expect(port.broadcast(f)).rejects.toThrow(/^timeout: could not tell whether/);
  });

  it("a refused broadcast surfaces the node's reason", async () => {
    const { port } = setup({}, { broadcast: vi.fn(async () => { throw new BroadcastError(sgn, new Error("insufficient funds")); }) as any });
    await expect(port.broadcast(f)).rejects.toThrow("insufficient funds");
  });

  it("falls back to the error itself when a refusal has no cause, and rethrows others", async () => {
    const be = new BroadcastError(sgn, undefined);
    (be as any).cause = undefined;
    const a = setup({}, { broadcast: vi.fn(async () => { throw be; }) as any });
    await expect(a.port.broadcast(f)).rejects.toThrow(/the node refused/);
    const other = new TypeError("weird");
    const b = setup({}, { broadcast: vi.fn(async () => { throw other; }) as any });
    await expect(b.port.broadcast(f)).rejects.toBe(other);
  });
});

describe("chainPort reads", () => {
  const rcpt = { status: "0x1", blockNumber: "0x10", gasUsed: "0x5208", effectiveGasPrice: "0x64", logs: [{ address: TO, topics: [H(1)], data: "0x", extra: 1 }] };

  it("receipt maps the MCP shape to the engine's", async () => {
    const { port, calls } = setup({ get_transaction_receipt: rcpt });
    expect(await port.receipt(H(1))).toEqual({
      status: "success", blockNumber: 16n, gasUsed: 21_000n, effectiveGasPrice: 100n,
      logs: [{ address: TO, topics: [H(1)], data: "0x" }],
    });
    expect(calls[0]).toEqual({ tool: "get_transaction_receipt", args: { hash: H(1) } });
  });

  it("marks a non-1 status reverted and tolerates missing price and logs", async () => {
    const { port } = setup({ get_transaction_receipt: { status: "0x0", blockNumber: "0x1", gasUsed: "0x1" } });
    expect(await port.receipt(H(1))).toEqual({ status: "reverted", blockNumber: 1n, gasUsed: 1n, logs: [] });
  });

  it("receipt is null while unmined", async () => {
    const { port } = setup({ get_transaction_receipt: null });
    expect(await port.receipt(H(1))).toBeNull();
  });

  it("known is whether the node returns the transaction", async () => {
    expect(await setup({ get_transaction: { hash: H(1) } }).port.known(H(1))).toBe(true);
    expect(await setup({ get_transaction: null }).port.known(H(1))).toBe(false);
  });

  it("call returns the eth_call result and decodes reverts", async () => {
    const ok = setup({ eth_call: (a: any) => ({ result: `0x${a.transaction.data.slice(2)}` }) });
    expect(await ok.port.call(TO, "0xabcd")).toBe("0xabcd");
    expect(ok.calls[0]!.args).toEqual({ transaction: { to: TO, data: "0xabcd" } });
    const bad = setup({ eth_call: new ChainToolError("eth_call", "execution reverted", 3, encodeErrorResult({ abi: errorsAbi, errorName: "NotOwner" })) });
    await expect(bad.port.call(TO, "0x")).rejects.toThrow("reverted: NotOwner()");
  });

  it("now and sleep are the real clock", async () => {
    const { port } = setup();
    expect(port.now()).toBeInstanceOf(Date);
    await expect(port.sleep(1)).resolves.toBeUndefined();
  });
});

describe("chainPort.waitReceipt", () => {
  it("returns the receipt as soon as it appears, tolerating a failed poll", async () => {
    let n = 0;
    const { port } = setup({
      get_transaction_receipt: () => {
        if (++n === 1) throw new Error("flaky");
        if (n === 2) return null;
        return { status: "0x1", blockNumber: "0x1", gasUsed: "0x1" };
      },
    });
    expect((await port.waitReceipt(H(1), 60_000))?.status).toBe("success");
    expect(n).toBe(3);
  });

  it("gives up with null when the deadline is near", async () => {
    const { port, calls } = setup({ get_transaction_receipt: null });
    expect(await port.waitReceipt(H(1), 1_000)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("stops at once when the client was closed", async () => {
    const { port } = setup({ get_transaction_receipt: new ClientClosedError() });
    await expect(port.waitReceipt(H(1), 60_000)).rejects.toBeInstanceOf(ClientClosedError);
  });
});
