import { keccak256, parseGwei, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChainToolError, type ChainMcp } from "../src/lib/mcp.js";
import { BroadcastError, testnetSigner } from "../src/lib/signer.js";

const TO = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B" as Hex;
const ENV = "BEACON_TEST_SIGNER_KEY";

/** A Chain MCP stand-in: answers by tool name, records every call. */
function fakeMcp(answers: Record<string, unknown | ((args: any) => unknown)>, over: Partial<ChainMcp> = {}) {
  const calls: [string, any][] = [];
  const mcp = {
    network: "atlantic",
    chainId: 688689,
    server: { name: "pharos-mcp-server", version: "0.1.0" },
    endpoint: "local stdio PharosNetwork/pharos-mcp@9a3750c",
    broadcast: true,
    call: async (name: string, args: any) => {
      calls.push([name, args]);
      if (!(name in answers)) throw new Error(`unexpected tool ${name}`);
      const a = answers[name];
      const v = typeof a === "function" ? (a as (x: any) => unknown)(args) : a;
      if (v instanceof Error) throw v;
      return v;
    },
    listTools: async () => [],
    close: async () => {},
    ...over,
  } as unknown as ChainMcp;
  return { mcp, calls };
}

const CHAIN_STATE = {
  get_transaction_count: { nonce: "5" },
  estimate_gas: { gas: "21000" },
  get_block: { baseFeePerGas: "0x3b9aca00" }, // 1 gwei
  get_gas_price: { gasPriceWei: "10000000000", maxPriorityFeePerGasWei: "0" }, // 10 gwei "gas price" on Atlantic
};

let key: Hex;
beforeEach(() => {
  key = generatePrivateKey();
  process.env[ENV] = key;
});
afterEach(() => {
  delete process.env[ENV];
});

describe("testnetSigner safety", () => {
  it("refuses a mainnet client and a client that reports another chain", () => {
    expect(() => testnetSigner(fakeMcp({}, { network: "pharos", chainId: 1672 } as Partial<ChainMcp>).mcp, { envVar: ENV })).toThrow(/Atlantic testnet only/);
    expect(() => testnetSigner(fakeMcp({}, { chainId: 1672 } as Partial<ChainMcp>).mcp, { envVar: ENV })).toThrow(/Atlantic testnet only/);
  });

  it("needs its key variable and never puts the key in the error", () => {
    delete process.env[ENV];
    expect(() => testnetSigner(fakeMcp({}).mcp, { envVar: ENV })).toThrow(new RegExp(`${ENV} not set`));
  });

  it("refuses to sign for any chain but Atlantic, even when handed a prepared tx", async () => {
    const s = testnetSigner(fakeMcp(CHAIN_STATE).mcp, { envVar: ENV });
    const tx = await s.prepare({ to: TO });
    await expect(s.sign({ ...tx, chainId: 1672 })).rejects.toThrow(/refusing to sign for chain 1672/);
  });

  it("will not broadcast through a client opened without broadcast: true", async () => {
    const { mcp, calls } = fakeMcp(CHAIN_STATE, { broadcast: false } as Partial<ChainMcp>);
    const s = testnetSigner(mcp, { envVar: ENV });
    await expect(s.send({ to: TO })).rejects.toThrow(/broadcast: true/);
    expect(calls.map(([n]) => n)).not.toContain("send_raw_transaction");
  });
});

describe("prepare", () => {
  it("reads nonce, gas and fees through the Chain MCP, with EIP-1559 fees from the base fee, not eth_gasPrice", async () => {
    const { mcp, calls } = fakeMcp(CHAIN_STATE);
    const s = testnetSigner(mcp, { envVar: ENV });
    const tx = await s.prepare({ to: TO, value: 10n ** 15n });
    expect(tx).toEqual({ chainId: 688689, to: TO, value: 10n ** 15n, nonce: 5, gas: 21000n, maxFeePerGas: parseGwei("2"), maxPriorityFeePerGas: 0n });
    const args = Object.fromEntries(calls);
    expect(args.get_transaction_count).toEqual({ address: s.address, block: "pending" });
    expect(args.estimate_gas).toEqual({ transaction: { from: s.address, to: TO, value: "0x38d7ea4c68000" } });
    expect(args.get_block).toEqual({ block: "latest" });
  });

  it("keeps every field the caller set and asks the chain for nothing it does not need", async () => {
    const { mcp, calls } = fakeMcp({});
    const s = testnetSigner(mcp, { envVar: ENV });
    const tx = await s.prepare({ to: TO, data: "0xa9059cbb", nonce: 9, gas: 60_000n, maxFeePerGas: 7n, maxPriorityFeePerGas: 2n });
    expect(tx).toEqual({ chainId: 688689, to: TO, value: 0n, data: "0xa9059cbb", nonce: 9, gas: 60_000n, maxFeePerGas: 7n, maxPriorityFeePerGas: 2n });
    expect(calls).toEqual([]);
  });

  it("passes calldata to estimate_gas and fails clearly on a chain without a base fee", async () => {
    const { mcp, calls } = fakeMcp({ ...CHAIN_STATE, get_block: { baseFeePerGas: null } });
    const s = testnetSigner(mcp, { envVar: ENV });
    await expect(s.prepare({ to: TO, data: "0x01" })).rejects.toThrow(/no base fee/);
    expect(calls.find(([n]) => n === "estimate_gas")?.[1].transaction.data).toBe("0x01");
  });
});

describe("sign and broadcast", () => {
  it("signs locally: the hash is final before sending, the raw tx decodes to the prepared fields and recovers to the signer", async () => {
    const s = testnetSigner(fakeMcp(CHAIN_STATE).mcp, { envVar: ENV });
    const signed = await s.sign(await s.prepare({ to: TO, value: 1n }));
    expect(signed.hash).toBe(keccak256(signed.raw));
    expect(parseTransaction(signed.raw)).toMatchObject({ type: "eip1559", chainId: 688689, to: TO.toLowerCase(), value: 1n, nonce: 5, gas: 21000n });
    expect(await recoverTransactionAddress({ serializedTransaction: signed.raw as `0x02${string}` })).toBe(privateKeyToAccount(key).address);
  });

  it("broadcasts the raw tx through send_raw_transaction and checks the hash the node reports", async () => {
    let raw: Hex | undefined;
    const { mcp } = fakeMcp({ ...CHAIN_STATE, send_raw_transaction: (a: { rawTransaction: Hex }) => ((raw = a.rawTransaction), { txHash: keccak256(a.rawTransaction) }) });
    const s = testnetSigner(mcp, { envVar: ENV });
    const signed = await s.send({ to: TO });
    expect(raw).toBe(signed.raw);
  });

  it("treats a failed broadcast as sent when the node knows the hash (a timeout, or 'already known' on a resend)", async () => {
    const { mcp } = fakeMcp({ ...CHAIN_STATE, send_raw_transaction: new ChainToolError("send_raw_transaction", "already known"), get_transaction: { hash: "0x" } });
    const s = testnetSigner(mcp, { envVar: ENV });
    const signed = await s.sign(await s.prepare({ to: TO }));
    expect(await s.broadcast(signed)).toBe(signed.hash);
  });

  it("reports a broadcast the node does not know as BroadcastError with the hash and nonce, so a retry can reuse the nonce", async () => {
    const { mcp } = fakeMcp({ ...CHAIN_STATE, send_raw_transaction: new ChainToolError("send_raw_transaction", "insufficient funds"), get_transaction: null });
    const s = testnetSigner(mcp, { envVar: ENV });
    const signed = await s.sign(await s.prepare({ to: TO }));
    const err = await s.broadcast(signed).catch((e) => e);
    expect(err).toBeInstanceOf(BroadcastError);
    expect(err).toMatchObject({ hash: signed.hash, nonce: 5 });
    expect(err.message).toMatch(/insufficient funds/);
  });

  it("refuses a node that reports a different hash", async () => {
    const { mcp } = fakeMcp({ ...CHAIN_STATE, send_raw_transaction: { txHash: `0x${"0".repeat(64)}` } });
    await expect(testnetSigner(mcp, { envVar: ENV }).send({ to: TO })).rejects.toThrow(/reported hash/);
  });
});

describe("waitForReceipt", () => {
  const HASH = `0x${"a".repeat(64)}` as Hex;

  it("polls through the Chain MCP until the receipt exists, then maps status, block and gas", async () => {
    let polls = 0;
    const receipt = { status: "0x1", blockNumber: "0x10", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00" };
    const { mcp } = fakeMcp({ get_transaction_receipt: () => (++polls < 3 ? null : receipt) });
    const waited: number[] = [];
    const s = testnetSigner(mcp, { envVar: ENV, sleep: async (ms) => void waited.push(ms) });
    expect(await s.waitForReceipt(HASH)).toEqual({ status: "success", blockNumber: 16n, gasUsed: 21000n, effectiveGasPrice: 1_000_000_000n });
    expect(waited).toEqual([2_500, 2_500]);
  });

  it("reports a reverted receipt as reverted", async () => {
    const { mcp } = fakeMcp({ get_transaction_receipt: { status: "0x0", blockNumber: "0x1", gasUsed: "0x1" } });
    expect(await testnetSigner(mcp, { envVar: ENV }).waitForReceipt(HASH)).toEqual({ status: "reverted", blockNumber: 1n, gasUsed: 1n });
  });

  it("gives up after `polls` with the last read error, and never sleeps after the last poll", async () => {
    const { mcp } = fakeMcp({ get_transaction_receipt: new Error("MCP 429") });
    const waited: number[] = [];
    const s = testnetSigner(mcp, { envVar: ENV, sleep: async (ms) => void waited.push(ms) });
    await expect(s.waitForReceipt(HASH, { polls: 3, pollMs: 10 })).rejects.toThrow(/no receipt after 3 polls \(last error: MCP 429\)/);
    expect(waited).toEqual([10, 10]);
  });
});
