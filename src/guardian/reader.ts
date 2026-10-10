import { encodeFunctionData, decodeFunctionResult, erc20Abi, type Hex } from "viem";

/** Every onchain read the Guardian makes. One implementation: the Pharos Chain MCP. */
export interface Reader {
  blockNumber(): Promise<bigint>;
  nativeBalance(address: Hex, block: bigint): Promise<bigint>;
  erc20Balance(token: Hex, address: Hex, block: bigint): Promise<bigint>;
  erc20Decimals(token: Hex, block: bigint): Promise<number>;
  gasPrice(): Promise<bigint>;
  code(address: Hex, block: bigint): Promise<Hex>;
  nonces(address: Hex): Promise<{ latest: bigint; pending: bigint }>;
  logCount(address: Hex, topic0: Hex | undefined, fromBlock: bigint, toBlock: bigint): Promise<number>;
  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null>;
}

/** Calls one Chain MCP tool and returns its parsed JSON. `callTool(client, …)` from lib/mcp fits. */
export type ToolCall = (name: string, args?: Record<string, unknown>) => Promise<any>;

// Pin reads to a block so every condition in one evaluation sees the same chain state.
const at = (block: bigint) => block.toString();

export function mcpReader(call: ToolCall): Reader {
  async function ethCall(to: Hex, data: Hex, block: bigint): Promise<Hex> {
    const { result } = await call("eth_call", { transaction: { to, data }, block: at(block) });
    if (typeof result !== "string" || result === "0x") throw new Error(`eth_call to ${to} returned no data (not a contract?)`);
    return result as Hex;
  }

  return {
    async blockNumber() {
      return BigInt((await call("get_block_number")).blockNumber);
    },
    async nativeBalance(address, block) {
      return BigInt((await call("get_balance", { address, block: at(block) })).balanceWei);
    },
    async erc20Balance(token, address, block) {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [address] });
      return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: await ethCall(token, data, block) });
    },
    async erc20Decimals(token, block) {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "decimals" });
      return decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data: await ethCall(token, data, block) });
    },
    async gasPrice() {
      return BigInt((await call("get_gas_price")).gasPriceWei);
    },
    async code(address, block) {
      return (await call("get_code", { address, block: at(block) })).code as Hex;
    },
    async nonces(address) {
      const [latest, pending] = await Promise.all([
        call("get_transaction_count", { address, block: "latest" }),
        call("get_transaction_count", { address, block: "pending" }),
      ]);
      return { latest: BigInt(latest.nonce), pending: BigInt(pending.nonce) };
    },
    async logCount(address, topic0, fromBlock, toBlock) {
      const logs = await call("get_logs", {
        address,
        ...(topic0 ? { topics: [topic0] } : {}),
        fromBlock: at(fromBlock),
        toBlock: at(toBlock),
      });
      if (!Array.isArray(logs)) throw new Error("get_logs did not return an array");
      return logs.length;
    },
    async receipt(hash) {
      const r = await call("get_transaction_receipt", { hash });
      if (!r) return null;
      return { status: r.status === "0x1" ? "success" : "reverted", blockNumber: BigInt(r.blockNumber) };
    },
  };
}
