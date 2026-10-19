// The run log without a database: the last payments are read back from the chain. Every settled x402 payment is a USDC
// Transfer log to the payee, so the log is exactly what the chain says was paid. Refused runs move no money and are not in it.
// The Atlantic RPC answers eth_getLogs for at most 1,000 blocks (~29 min) per call, so the scan walks back window by window,
// one at a time (the public RPC refuses parallel log queries: "request too fast per second"), and stops at `limit` payments
// or after `maxWindows` windows (24 ≈ the last 12 hours, ~0.3 s per window).
import { createPublicClient, formatUnits, getAddress, http, pad, type Hex, type RpcLog } from "viem";
import { X402_USDC, atlantic, explorerTx } from "../../src/lib/networks.js";
import { TRANSFER_TOPIC } from "../../src/whale/scan.js";
import { PAID_ROUTES } from "./config.js";

export interface Payment {
  tx: Hex;
  explorer: string;
  block: number;
  time: string | null;
  payer: Hex;
  amount: string;
  usdc: string;
  route: string;
}

export interface LogSource {
  blockNumber(): Promise<bigint>;
  logs(fromBlock: bigint, toBlock: bigint, payTo: Hex): Promise<RpcLog[]>;
  blockTime(block: bigint): Promise<number>;
}

const routeFor = (amount: bigint) => Object.entries(PAID_ROUTES).find(([, r]) => r.amount === amount)?.[0] ?? "other";

export function toPayment(l: RpcLog): Payment {
  const amount = BigInt(l.data);
  const tx = l.transactionHash as Hex;
  return {
    tx,
    explorer: explorerTx("atlantic", tx),
    block: Number(BigInt(l.blockNumber ?? "0x0")),
    time: null,
    payer: getAddress(`0x${l.topics[1]!.slice(26)}`),
    amount: amount.toString(),
    usdc: formatUnits(amount, X402_USDC.decimals),
    route: routeFor(amount),
  };
}

export function rpcLogSource(): LogSource {
  const c = createPublicClient({ chain: atlantic, transport: http(undefined, { retryCount: 5, retryDelay: 600 }) });
  return {
    blockNumber: () => c.getBlockNumber(),
    logs: (fromBlock, toBlock, payTo) =>
      c.request({
        method: "eth_getLogs",
        params: [{ address: X402_USDC.address, topics: [TRANSFER_TOPIC, null, pad(payTo)], fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }],
      }) as Promise<RpcLog[]>,
    blockTime: async (b) => Number((await c.getBlock({ blockNumber: b })).timestamp),
  };
}

export async function recentPayments(src: LogSource, payTo: Hex, o: { limit?: number; maxWindows?: number; parallel?: number; window?: bigint } = {}) {
  const limit = o.limit ?? 10;
  const maxWindows = o.maxWindows ?? 24;
  const parallel = o.parallel ?? 1;
  const window = o.window ?? 1000n;
  const latest = await src.blockNumber();
  const found: Payment[] = [];
  let scanned = 0;
  let to = latest;
  while (found.length < limit && scanned < maxWindows && to >= 0n) {
    const batch: [bigint, bigint][] = [];
    for (let i = 0; i < parallel && scanned + batch.length < maxWindows && to >= 0n; i++) {
      const from = to - window + 1n > 0n ? to - window + 1n : 0n;
      batch.push([from, to]);
      to = from - 1n;
    }
    scanned += batch.length;
    const pages = await Promise.all(batch.map(([f, t]) => src.logs(f, t, payTo)));
    for (const page of pages) found.push(...page.filter((l) => l.data && l.data !== "0x").map(toPayment));
  }
  found.sort((a, b) => b.block - a.block);
  const top = found.slice(0, limit);
  const times = new Map<number, number>();
  for (const b of new Set(top.map((p) => p.block))) times.set(b, await src.blockTime(BigInt(b)));
  for (const p of top) p.time = times.has(p.block) ? new Date(times.get(p.block)! * 1000).toISOString() : null;
  return { payTo, latestBlock: Number(latest), scannedBlocks: scanned * Number(window), payments: top };
}
