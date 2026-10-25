import { existsSync, readFileSync } from "node:fs";
import { getAddress, toEventSelector, type Hex } from "viem";
import type { RpcLog } from "viem";
import { getLogsRange, type ChainMcp } from "../lib/mcp.js";
import { writeJsonAtomic } from "../lib/state.js";
import { MORPHO_BLUE } from "./morpho.js";

// Market-wide discovery. Morpho Blue keeps no list of borrowers, so they are found from its `Borrow` events
// (topic1 = market id, topic2 = onBehalf = the account whose debt it is). A position is then read live, so a borrower who has
// since repaid shows zero debt and drops out; one whose last borrow is older than the scanned range is NOT found (stated limit).

export const BORROW_TOPIC = toEventSelector("Borrow(bytes32,address,address,address,uint256,uint256)");

/** What a scan found: borrowers per market id, and the block range that was searched. */
export interface BorrowerIndex {
  morpho: Hex;
  from: string;
  to: string;
  markets: Record<string, Hex[]>;
}

export const emptyIndex = (from: bigint, to: bigint): BorrowerIndex => ({ morpho: MORPHO_BLUE, from: from.toString(), to: to.toString(), markets: {} });

export function addBorrowers(index: BorrowerIndex, logs: Pick<RpcLog, "topics">[]): void {
  for (const l of logs) {
    const t = l.topics;
    if (!t || t[0]?.toLowerCase() !== BORROW_TOPIC || !t[1] || !t[2]) continue;
    const id = t[1].toLowerCase();
    const user = getAddress("0x" + t[2].slice(26));
    const list = (index.markets[id] ??= []);
    if (!list.includes(user)) list.push(user);
  }
}

export function loadIndex(file: string): BorrowerIndex | undefined {
  if (!existsSync(file)) return undefined;
  const v = JSON.parse(readFileSync(file, "utf8")) as BorrowerIndex;
  if (v.morpho?.toLowerCase() !== MORPHO_BLUE.toLowerCase() || !v.markets) throw new Error(`${file} is not a borrower index for Morpho Blue ${MORPHO_BLUE}`);
  return v;
}

/** Scan [from, to] for borrowers, reusing what `cacheFile` already covers and saving progress after every chunk. */
export async function discoverBorrowers(
  call: ChainMcp["call"],
  opts: { from: bigint; to: bigint; cacheFile?: string; chunk?: bigint; onProgress?: (done: bigint, total: bigint) => void; signal?: AbortSignal },
): Promise<{ index: BorrowerIndex; scannedBlocks: bigint; reused: boolean }> {
  const chunk = opts.chunk ?? 100_000n;
  const cached = opts.cacheFile ? loadIndex(opts.cacheFile) : undefined;
  // The covered range [index.from, index.to] always stays contiguous: new blocks extend it at the top, older ones at the bottom.
  const index = cached ?? emptyIndex(opts.to + 1n, opts.to);
  const after: [bigint, bigint] = [BigInt(index.to) + 1n, opts.to];
  const before: [bigint, bigint] = [opts.from, BigInt(index.from) - 1n];
  const total = (after[1] >= after[0] ? after[1] - after[0] + 1n : 0n) + (before[1] >= before[0] ? before[1] - before[0] + 1n : 0n);
  let scanned = 0n;
  const step = async (a: bigint, b: bigint, top: boolean) => {
    if (opts.signal?.aborted) throw new Error("interrupted");
    addBorrowers(index, await getLogsRange(call, { address: MORPHO_BLUE, topics: [BORROW_TOPIC], fromBlock: a, toBlock: b }));
    if (top) index.to = b.toString();
    else index.from = a.toString();
    scanned += b - a + 1n;
    if (opts.cacheFile) writeJsonAtomic(opts.cacheFile, index);
    opts.onProgress?.(scanned, total);
  };
  for (let a = after[0]; a <= after[1]; a += chunk) await step(a, a + chunk - 1n < after[1] ? a + chunk - 1n : after[1], true);
  for (let b = before[1]; b >= before[0]; b -= chunk) await step(b - chunk + 1n > before[0] ? b - chunk + 1n : before[0], b, false);
  return { index, scannedBlocks: scanned, reused: cached !== undefined };
}
