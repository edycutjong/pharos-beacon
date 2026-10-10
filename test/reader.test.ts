import { describe, expect, it } from "vitest";
import { mcpReader } from "../src/guardian/reader.js";

const A = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B";
const T = "0xc879c018db60520f4355c26ed1a6d572cdac1815";

function recorder(responses: Record<string, unknown>) {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const call = async (name: string, args?: Record<string, unknown>) => {
    calls.push([name, args]);
    if (!(name in responses)) throw new Error(`unexpected tool ${name}`);
    return responses[name];
  };
  return { calls, reader: mcpReader(call) };
}

describe("mcpReader (Chain MCP tool mapping)", () => {
  it("pins balance and code reads to the given block", async () => {
    const { calls, reader } = recorder({ get_balance: { balanceWei: "1500000000000000000" }, get_code: { code: "0x" } });
    expect(await reader.nativeBalance(A, 42n)).toBe(1_500_000_000_000_000_000n);
    expect(await reader.code(A, 42n)).toBe("0x");
    expect(calls).toEqual([["get_balance", { address: A, block: "42" }], ["get_code", { address: A, block: "42" }]]);
  });

  it("encodes balanceOf through eth_call and decodes the uint256", async () => {
    const { calls, reader } = recorder({ eth_call: { result: "0x" + (123456n).toString(16).padStart(64, "0") } });
    expect(await reader.erc20Balance(T, A, 7n)).toBe(123456n);
    const [name, args] = calls[0];
    expect(name).toBe("eth_call");
    expect(args).toMatchObject({ transaction: { to: T }, block: "7" });
    expect((args!.transaction as { data: string }).data.startsWith("0x70a08231")).toBe(true);
  });

  it("throws when eth_call returns empty data (no contract)", async () => {
    const { reader } = recorder({ eth_call: { result: "0x" } });
    await expect(reader.erc20Decimals(T, 1n)).rejects.toThrow(/no data/);
  });

  it("filters get_logs by topic over the requested window", async () => {
    const { calls, reader } = recorder({ get_logs: [{}, {}, {}] });
    expect(await reader.logCount(T, "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", 100n, 199n)).toBe(3);
    expect(calls[0][1]).toEqual({ address: T, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], fromBlock: "100", toBlock: "199" });
  });

  it("reads latest and pending nonces", async () => {
    const { reader } = recorder({ get_transaction_count: { nonce: "6" } });
    expect(await reader.nonces(A)).toEqual({ latest: 6n, pending: 6n });
  });

  it("maps receipt status and treats null as not mined", async () => {
    expect(await recorder({ get_transaction_receipt: { status: "0x1", blockNumber: "0x10" } }).reader.receipt(`0x${"a".repeat(64)}`)).toEqual({
      status: "success",
      blockNumber: 16n,
    });
    expect(await recorder({ get_transaction_receipt: { status: "0x0", blockNumber: "0x10" } }).reader.receipt(`0x${"a".repeat(64)}`)).toMatchObject({ status: "reverted" });
    expect(await recorder({ get_transaction_receipt: null }).reader.receipt(`0x${"a".repeat(64)}`)).toBeNull();
  });
});
