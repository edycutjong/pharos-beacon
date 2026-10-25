// What the two paid routes sell. Both are read-only.
//   gas-snapshot: Atlantic gas price, priority fee and the latest block, read from the Atlantic RPC.
//   whale-brief:  the largest USDC transfers on Pharos mainnet in the latest ~1,000 blocks, read through the hosted Pharos Chain MCP
//                 (get_block_number + get_logs on the USDC Transfer event).
import { createPublicClient, formatGwei, formatUnits, getAddress, http, type Hex, type RpcLog } from "viem";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { TOKENS, atlantic } from "../../src/lib/networks.js";
import { TRANSFER_TOPIC } from "../../src/whale/scan.js";

const atlanticRpc = createPublicClient({ chain: atlantic, transport: http(undefined, { retryCount: 3, retryDelay: 800 }) });

export async function gasSnapshot() {
  const [block, gasPrice, priority] = await Promise.all([
    atlanticRpc.getBlock({ blockTag: "latest" }),
    atlanticRpc.getGasPrice(),
    atlanticRpc.estimateMaxPriorityFeePerGas().catch(() => 0n),
  ]);
  return {
    network: "Pharos Atlantic testnet (eip155:688689)",
    source: "Atlantic JSON-RPC (eth_getBlockByNumber, eth_gasPrice, eth_maxPriorityFeePerGas)",
    block: Number(block.number),
    blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    baseFeeGwei: block.baseFeePerGas == null ? null : formatGwei(block.baseFeePerGas),
    gasPriceGwei: formatGwei(gasPrice),
    priorityFeeGwei: formatGwei(priority),
    plainTransferCostPHRS: formatUnits(gasPrice * 21_000n, 18),
  };
}

export interface WhaleMove {
  from: Hex;
  to: Hex;
  usdc: string;
  block: number;
  tx: Hex;
}

/** Largest first; ties by block. Pure, so it is tested without a network. */
export function largestTransfers(logs: RpcLog[], decimals: number, top = 5): WhaleMove[] {
  return logs
    .filter((l) => l.topics.length === 3 && l.topics[0] === TRANSFER_TOPIC && l.data && l.data !== "0x")
    .map((l) => ({
      from: getAddress(`0x${l.topics[1]!.slice(26)}`),
      to: getAddress(`0x${l.topics[2]!.slice(26)}`),
      raw: BigInt(l.data),
      block: Number(BigInt(l.blockNumber ?? "0x0")),
      tx: l.transactionHash as Hex,
    }))
    .sort((a, b) => (a.raw === b.raw ? b.block - a.block : a.raw > b.raw ? -1 : 1))
    .slice(0, top)
    .map(({ raw, ...m }) => ({ ...m, usdc: formatUnits(raw, decimals) }));
}

export async function whaleBrief(open: () => Promise<ChainMcp> = () => chainMcp("pharos", { retries: 1, timeoutMs: 20_000 }), blocks = 1_000) {
  const mcp = await open();
  try {
    const usdc = TOKENS.pharos.USDC;
    const latest = BigInt((await mcp.call("get_block_number")).blockNumber);
    const fromBlock = latest - BigInt(blocks) + 1n;
    // The log query takes 1,000 blocks at a time: one get_logs call per window, newest first.
    const all: RpcLog[] = [];
    for (let to = latest; to >= fromBlock; to -= 1_000n) {
      const from = to - 999n > fromBlock ? to - 999n : fromBlock;
      const logs = await mcp.call("get_logs", { address: usdc.address, topics: [TRANSFER_TOPIC], fromBlock: from.toString(), toBlock: to.toString() });
      if (Array.isArray(logs)) all.push(...(logs as RpcLog[]));
    }
    return {
      network: "Pharos mainnet (chain 1672), read-only",
      source: `Pharos Chain MCP ${mcp.endpoint}: get_block_number, get_logs`,
      token: `USDC ${usdc.address}`,
      blocks: `${fromBlock}–${latest}`,
      transfers: all.length,
      largest: largestTransfers(all, usdc.decimals),
    };
  } finally {
    await mcp.close();
  }
}
