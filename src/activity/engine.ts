import { decodeAbiParameters, formatUnits, getAddress, isAddress, type Hex, type RpcLog } from "viem";
import { getLogsRange, type ChainMcp, type Network } from "../lib/mcp.js";
import { tokenInfo } from "../watch/token.js";

// Wallet activity over a block range, read only through the Pharos Chain MCP: the engine behind the Audit-Log Agent and the Weekly
// Digest Agent. It finds a wallet's activity from its event logs (a wallet is an indexed topic of Transfer / Approval / Swap events),
// reads each transaction and receipt for the fee, and optionally scans blocks for what leaves no log (plain PROS transfers and
// calls that emit nothing). Nothing here ever sends.

export type Call = ChainMcp["call"];
export type Category = "transfer-in" | "transfer-out" | "swap" | "approval" | "contract-call";
export const CATEGORIES: Category[] = ["transfer-in", "transfer-out", "swap", "approval", "contract-call"];

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
export const APPROVAL_FOR_ALL_TOPIC = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const SWAP_TOPICS = new Set([
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822", // Uniswap V2 style Swap(sender, amounts, to)
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", // Uniswap V3 style Swap(sender, recipient, ...)
]);
const UNLIMITED = 1n << 255n;
export const MAX_RANGE_BLOCKS = 3_000_000; // ~1 month of mainnet blocks: 3,000 get_logs calls per topic position (~1 hour at 100 calls a minute)
const pad32 = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const topicAddress = (t: Hex) => getAddress(`0x${t.slice(26)}`);
const lower = (a: string) => a.toLowerCase();

/** A readable name for the few selectors people actually meet; anything else stays as the 4-byte selector. */
const SELECTORS: Record<string, string> = {
  "0xa9059cbb": "transfer", "0x23b872dd": "transferFrom", "0x095ea7b3": "approve", "0xd0e30db0": "deposit (wrap)", "0x2e1a7d4d": "withdraw (unwrap)",
  "0x38ed1739": "swapExactTokensForTokens", "0x7ff36ab5": "swapExactETHForTokens", "0x18cbafe5": "swapExactTokensForETH", "0x5ae401dc": "multicall", "0xac9650d8": "multicall",
  "0x414bf389": "exactInputSingle", "0xb858183f": "exactInput", "0xe449022e": "swap (aggregator)", "0x3593564c": "execute (universal router)", "0x1249c58b": "mint", "0x4e71d92d": "claim",
  "0xa0712d68": "mint", "0xe8e33700": "addLiquidity", "0x0dfe1681": "token0", "0x6a627842": "mint (LP)", "0x2f745c59": "tokenOfOwnerByIndex", "0xa22cb465": "setApprovalForAll", "0x42842e0e": "safeTransferFrom",
};
export const selectorName = (input: string | undefined) => (!input || input === "0x" ? "plain transfer" : (SELECTORS[input.slice(0, 10)] ?? `call ${input.slice(0, 10)}`));

export interface Leg {
  token: Hex | "native";
  symbol: string;
  decimals: number | undefined; // undefined: not an ERC-20 we could read (NFT or unreadable): raw units
  amountRaw: bigint;
  nft?: bigint;
}

export interface Item {
  category: Category;
  tx: Hex;
  block: bigint;
  timestamp: number; // unix seconds
  status: "success" | "reverted";
  /** transfer-in/out: the other side. approval: the spender. swap: the pool/router (tx.to). contract-call: the contract called. */
  counterparty: Hex | null;
  /** transfer: one leg. swap: `out` is what the wallet gave, `in` what it got. approval: the allowance. */
  out: Leg[];
  in: Leg[];
  unlimited?: boolean;
  method?: string;
  /** Native fee paid by the wallet for this tx (wei), only when the wallet sent it. */
  feeWei: bigint;
  nativeValueWei?: bigint;
}

export interface Range {
  fromBlock: bigint;
  toBlock: bigint;
  fromTs?: number;
  toTs?: number;
}

export interface Coverage {
  logWindows: number;
  logsRead: number;
  /** Block scan for PROS transfers and event-less calls: "off", or how much of the range was walked. */
  blockScan: { mode: "off" | "full" | "partial"; scanned: number; of: number };
  /** Transactions the wallet sent: counted from the logs / scan vs what the chain's nonce says. */
  sentFound: number;
  sentExpected: number | null;
  /** Nonce-guided search for sent transactions the logs did not show: whether it ran, the nonce reads it took, the blocks it opened. */
  discovery: { used: boolean; nonceCalls: number; blocksRead: number; truncated: boolean };
  /** Tx hashes found but not read because of the cap. */
  skipped: number;
}

export interface Activity {
  wallet: Hex;
  network: Network;
  nativeSymbol: string;
  range: Range;
  items: Item[];
  coverage: Coverage;
}

export function parseWallet(raw: string): Hex {
  if (!isAddress(raw, { strict: false })) throw new Error(`${JSON.stringify(raw)} is not an address`);
  return getAddress(raw);
}

const num = (h: string | null | undefined) => (h == null ? 0n : BigInt(h));

/**
 * The first block whose timestamp is >= ts (or head + 1 when ts is in the future). Interpolation search over get_block: block times are
 * nearly even, so a guess from the two known ends lands within a few blocks and the search needs about 5 calls instead of 25 (the hosted
 * server allows 100 calls a minute). It falls back to bisection whenever a guess does not shrink the bracket enough.
 */
export async function blockAtOrAfter(call: Call, ts: number, head: bigint): Promise<bigint> {
  const stamp = async (n: bigint) => {
    const b = await call("get_block", { block: n.toString() });
    if (!b) throw new Error(`block ${n} is not available`);
    return Number(BigInt(b.timestamp));
  };
  const tHead = await stamp(head);
  if (ts > tHead) return head + 1n;
  let lo = 0n; // invariant: the answer is in [lo, hi]; every block before lo is earlier than ts
  let hi = head; // block hi is at or after ts
  let tLo = await stamp(0n);
  let tHi = tHead;
  if (ts <= tLo) return 0n;
  let bisect = false;
  while (lo < hi) {
    let mid = (lo + hi) / 2n;
    if (!bisect && tHi > tLo) mid = lo + BigInt(Math.floor(((ts - tLo) / (tHi - tLo)) * Number(hi - lo)));
    if (mid >= hi) mid = hi - 1n;
    if (mid < lo) mid = lo;
    const t = await stamp(mid);
    const before = hi - lo;
    if (t >= ts) (hi = mid, (tHi = t));
    else (lo = mid + 1n, (tLo = t));
    bisect = (hi - lo) * 2n > before; // a guess that did not halve the bracket: bisect the next one
  }
  return lo;
}

/** A UTC date range [fromTs, toTs) as an inclusive block range at a pinned head. */
export async function rangeForTimes(call: Call, fromTs: number, toTs: number, head: bigint): Promise<Range> {
  if (toTs <= fromTs) throw new Error("the period must end after it starts");
  const fromBlock = await blockAtOrAfter(call, fromTs, head);
  const next = await blockAtOrAfter(call, toTs, head);
  if (fromBlock > head) throw new Error("the period starts after the latest block");
  const toBlock = next - 1n < head ? next - 1n : head;
  if (toBlock < fromBlock) throw new Error("the period holds no blocks");
  return { fromBlock, toBlock, fromTs, toTs };
}

export interface CollectOptions {
  /** Walk blocks (get_block with transactions) for up to this many blocks, newest range first excluded: 0 = off. */
  scanBlocks?: number;
  /** Look for sent transactions the logs missed by bisecting the nonce (default true). */
  discoverSent?: boolean;
  /** Most nonce reads the discovery may spend (default 300). */
  maxDiscoverCalls?: number;
  /** Read at most this many transactions (default 400). */
  maxTxs?: number;
  /** Called with a progress line every so often (never required). */
  progress?: (line: string) => void;
}

interface RawTx {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  value: bigint;
  input: string;
  block: bigint;
}

const tokenCache = new WeakMap<Call, Map<string, Promise<{ decimals: number; symbol: string } | undefined>>>();
function tokenOf(call: Call, addr: Hex) {
  let m = tokenCache.get(call);
  if (!m) tokenCache.set(call, (m = new Map()));
  const k = lower(addr);
  if (!m.has(k)) m.set(k, tokenInfo(call, addr));
  return m.get(k)!;
}

export async function collectActivity(call: Call, network: Network, wallet: Hex, range: Range, opts: CollectOptions = {}): Promise<Activity> {
  if (range.toBlock < range.fromBlock) throw new Error("empty block range");
  if (range.toBlock - range.fromBlock + 1n > BigInt(MAX_RANGE_BLOCKS)) throw new Error(`range of ${range.toBlock - range.fromBlock + 1n} blocks is over the ${MAX_RANGE_BLOCKS} cap; narrow it or run it in pieces`);
  const info = await call("get_chain_info");
  const nativeSymbol = info.nativeSymbol;
  const me = lower(wallet);
  const w = pad32(wallet);
  const windows = Math.ceil(Number(range.toBlock - range.fromBlock + 1n) / 1000);

  // 1. Logs where the wallet is the 1st indexed argument (Transfer from / Approval owner / Swap sender) or the 2nd (Transfer to, ...).
  const asFirst = await getLogsRange(call, { topics: [null, w], fromBlock: range.fromBlock, toBlock: range.toBlock });
  const asSecond = await getLogsRange(call, { topics: [null, null, w], fromBlock: range.fromBlock, toBlock: range.toBlock });
  const seen = new Set<string>();
  const logs: RpcLog[] = [];
  for (const l of [...asFirst, ...asSecond]) {
    const k = `${l.blockNumber}:${l.logIndex}`;
    if (!seen.has(k)) (seen.add(k), logs.push(l));
  }
  const byTx = new Map<string, RpcLog[]>();
  for (const l of logs) (byTx.get(l.transactionHash!) ?? byTx.set(l.transactionHash!, []).get(l.transactionHash!)!).push(l);

  // 2. Optional block scan for what leaves no log. Capped: a partial scan is reported as partial.
  const raw = new Map<string, RawTx>();
  const total = Number(range.toBlock - range.fromBlock + 1n);
  const scanN = Math.min(opts.scanBlocks ?? 0, total);
  for (let i = 0; i < scanN; i++) {
    const n = range.toBlock - BigInt(i);
    const b = await call("get_block", { block: n.toString(), includeTransactions: true } as Record<string, unknown>);
    for (const t of (b?.transactions ?? []) as unknown as { hash: Hex; from: Hex; to: Hex | null; value: Hex; input: Hex }[]) {
      if (lower(t.from) === me || (t.to && lower(t.to) === me)) raw.set(t.hash, { hash: t.hash, from: t.from, to: t.to, value: num(t.value), input: t.input, block: n });
    }
    if (opts.progress && (i + 1) % 200 === 0) opts.progress(`scanned ${i + 1}/${scanN} blocks`);
  }

  // 3. Read every transaction (and its receipt): the log-found ones plus the scan-found ones.
  const hashes = [...new Set<string>([...byTx.keys(), ...raw.keys()])] as Hex[];
  const cap = opts.maxTxs ?? 400;
  const chosen = hashes.slice(0, cap);
  const stamps = new Map<string, number>();
  const stampOf = async (block: bigint) => {
    const k = block.toString();
    if (!stamps.has(k)) {
      const b = await call("get_block", { block: k });
      stamps.set(k, b ? Number(BigInt(b.timestamp)) : 0);
    }
    return stamps.get(k)!;
  };
  const items: Item[] = [];
  let sentFound = 0;
  const sentAt = new Map<string, Set<string>>(); // block → hashes of transactions the wallet sent there
  const processHash = async (h: Hex): Promise<void> => {
    const [tx, rc] = await Promise.all([call("get_transaction", { hash: h }), call("get_transaction_receipt", { hash: h })]);
    if (!tx || !rc) return;
    const block = num(rc.blockNumber);
    if (block < range.fromBlock || block > range.toBlock) return;
    const ts = await stampOf(block);
    const sentByMe = lower(tx.from) === me;
    if (sentByMe) {
      sentFound++;
      (sentAt.get(block.toString()) ?? sentAt.set(block.toString(), new Set()).get(block.toString())!).add(h);
    }
    const status = rc.status === "0x1" ? "success" : "reverted";
    const feeWei = sentByMe ? num(rc.gasUsed) * num((rc as unknown as { effectiveGasPrice?: Hex }).effectiveGasPrice ?? tx.gasPrice) : 0n;
    const base = { tx: h, block, timestamp: ts, status } as const;
    const txLogs = byTx.get(h) ?? [];
    const made: Item[] = [];

    const outs: Leg[] = [];
    const ins: Leg[] = [];
    let swapPool: Hex | null = null;
    let outCounter: Hex | null = null;
    let inCounter: Hex | null = null;
    for (const l of txLogs) {
      const t0 = l.topics[0]!.toLowerCase();
      if (SWAP_TOPICS.has(t0)) swapPool ??= l.address as Hex;
      if (t0 === TRANSFER_TOPIC && (l.topics.length === 3 || l.topics.length === 4)) {
        const from = topicAddress(l.topics[1]!);
        const to = topicAddress(l.topics[2]!);
        const nft = l.topics.length === 4;
        const token = l.address as Hex;
        const meta = nft ? undefined : await tokenOf(call, token);
        const leg: Leg = nft
          ? { token, symbol: "NFT", decimals: undefined, amountRaw: 1n, nft: BigInt(l.topics[3]!) }
          : { token, symbol: meta?.symbol ?? "token", decimals: meta?.decimals, amountRaw: l.data === "0x" ? 0n : (decodeAbiParameters([{ type: "uint256" }], l.data as Hex)[0] as bigint) };
        if (lower(from) === me) (outs.push(leg), (outCounter ??= to));
        else if (lower(to) === me) (ins.push(leg), (inCounter ??= from));
      } else if (t0 === APPROVAL_TOPIC && lower(topicAddress(l.topics[1]!)) === me) {
        const nft = l.topics.length === 4;
        const token = l.address as Hex;
        const meta = nft ? undefined : await tokenOf(call, token);
        const amt = nft ? 1n : l.data === "0x" ? 0n : (decodeAbiParameters([{ type: "uint256" }], l.data as Hex)[0] as bigint);
        const leg: Leg = nft ? { token, symbol: "NFT", decimals: undefined, amountRaw: 1n, nft: BigInt(l.topics[3]!) } : { token, symbol: meta?.symbol ?? "token", decimals: meta?.decimals, amountRaw: amt };
        made.push({ ...base, category: "approval", counterparty: topicAddress(l.topics[2]!), out: [leg], in: [], feeWei: 0n, method: "approve", unlimited: !nft && amt >= UNLIMITED });
      } else if (t0 === APPROVAL_FOR_ALL_TOPIC && lower(topicAddress(l.topics[1]!)) === me) {
        const on = l.data !== "0x" && BigInt(l.data) !== 0n;
        made.push({ ...base, category: "approval", counterparty: topicAddress(l.topics[2]!), out: [{ token: l.address as Hex, symbol: "NFT collection", decimals: undefined, amountRaw: on ? 1n : 0n }], in: [], feeWei: 0n, method: on ? "setApprovalForAll(true)" : "setApprovalForAll(false)", unlimited: on });
      }
    }

    // The wallet's own native value in this tx.
    const value = num(tx.value);
    const nativeLeg = (): Leg => ({ token: "native", symbol: nativeSymbol, decimals: 18, amountRaw: value });
    if (value > 0n && status === "success") {
      if (sentByMe) {
        // Value sent into a contract together with calldata (a payable call: wrap, mint, buy) is a contract interaction, not a transfer. A swap that
        // pays in the native token keeps its native leg (it has an incoming token), and a plain send to an address with no code stays a transfer.
        const payable = tx.input !== "0x" && !!tx.to && ins.length === 0 && swapPool === null && ((await call("get_code", { address: tx.to as Hex })).code ?? "0x") !== "0x";
        if (!payable) outs.push(nativeLeg());
      } else if (tx.to && lower(tx.to) === me) ins.push(nativeLeg());
    }

    // An ERC-20 Approval log is also emitted when a spender USES an allowance (transferFrom lowers it): that is not a new approval. Drop an
    // approval of a token the wallet also sent in this very transaction; a real approve() tx moves nothing.
    for (let i = made.length - 1; i >= 0; i--) {
      const m = made[i]!;
      if (m.category === "approval" && m.out[0]!.nft === undefined && m.method === "approve" && outs.some((o) => o.token === m.out[0]!.token)) made.splice(i, 1);
    }
    const swap = swapPool !== null || (outs.length > 0 && ins.length > 0 && new Set([...outs, ...ins].map((x) => String(x.token))).size > 1 && outs.some((o) => ins.some((i) => i.token !== o.token)));
    if (swap && (outs.length || ins.length)) {
      made.push({ ...base, category: "swap", counterparty: swapPool ?? ((tx.to as Hex | null) ?? null), out: outs, in: ins, feeWei, method: selectorName(tx.input), nativeValueWei: value });
    } else {
      for (const o of outs) made.push({ ...base, category: "transfer-out", counterparty: o.token === "native" ? ((tx.to as Hex | null) ?? null) : outCounter, out: [o], in: [], feeWei: 0n, method: selectorName(tx.input) });
      for (const i of ins) made.push({ ...base, category: "transfer-in", counterparty: i.token === "native" ? tx.from : inCounter, out: [], in: [i], feeWei: 0n, method: selectorName(tx.input) });
    }
    // A call the wallet sent to a contract that is not already a transfer, swap or approval (or that reverted): a contract interaction.
    if (sentByMe && (made.length === 0 || status === "reverted")) {
      const to = (tx.to as Hex | null) ?? null;
      const isContract = to === null || ((await call("get_code", { address: to })).code ?? "0x") !== "0x";
      if (isContract || status === "reverted") made.push({ ...base, category: "contract-call", counterparty: to, out: [], in: [], feeWei, method: to === null ? "deploy contract" : selectorName(tx.input), nativeValueWei: value });
      else if (made.length === 0) made.push({ ...base, category: "transfer-out", counterparty: to, out: [nativeLeg()], in: [], feeWei: 0n, method: "plain transfer" });
    }
    // The fee belongs to the wallet once per transaction: put it on the first item that carries the tx.
    if (sentByMe && feeWei > 0n && !made.some((m) => m.feeWei > 0n) && made.length > 0) made[0] = { ...made[0]!, feeWei };
    items.push(...made);
  };
  for (const [i, h] of chosen.entries()) {
    await processHash(h);
    if (opts.progress && i % 25 === 24) opts.progress(`read ${i + 1}/${chosen.length} transactions`);
  }


  // Nonce-guided discovery of what the logs missed. The wallet's nonce rises by one for every transaction it sends, so bisecting the nonce over the
  // range finds the exact blocks of the missing ones (about 2 x log2(range) calls each) without walking every block. Ranges whose nonce rise is
  // already explained by transactions we read are skipped, so a wallet whose sends all left events costs two calls.
  const nonceCache = new Map<string, Promise<number>>();
  const nonceAt = (b: bigint) => {
    const k = b.toString();
    if (!nonceCache.has(k)) nonceCache.set(k, call("get_transaction_count", { address: wallet, block: k }).then((r) => Number(r.nonce)));
    return nonceCache.get(k)!;
  };
  let sentExpected: number | null = null;
  let nBefore = 0;
  let nAfter = 0;
  try {
    [nAfter, nBefore] = await Promise.all([nonceAt(range.toBlock), range.fromBlock > 0n ? nonceAt(range.fromBlock - 1n) : Promise.resolve(0)]);
    if (nAfter >= nBefore) sentExpected = nAfter - nBefore;
  } catch {
    sentExpected = null;
  }
  const discovery = { used: false, nonceCalls: 0, blocksRead: 0, truncated: false };
  if (sentExpected !== null && sentFound < sentExpected && (opts.discoverSent ?? true)) {
    discovery.used = true;
    opts.progress?.(`the logs show ${sentFound} of ${sentExpected} sent transactions; bisecting the nonce for the other ${sentExpected - sentFound}`);
    const cap = opts.maxDiscoverCalls ?? 300;
    const knownIn = (lo: bigint, hi: bigint) => {
      let n = 0;
      for (const [b, set] of sentAt) if (BigInt(b) >= lo && BigInt(b) <= hi) n += set.size;
      return n;
    };
    const leaves: bigint[] = [];
    const find = async (lo: bigint, hi: bigint, before: number, after: number): Promise<void> => {
      if (after - before <= knownIn(lo, hi)) return; // everything the nonce counts here is already read
      if (lo === hi) return void leaves.push(lo);
      if (discovery.nonceCalls >= cap) return void (discovery.truncated = true);
      const mid = (lo + hi) / 2n;
      discovery.nonceCalls++;
      const nMid = await nonceAt(mid);
      await find(lo, mid, before, nMid);
      await find(mid + 1n, hi, nMid, after);
    };
    try {
      await find(range.fromBlock, range.toBlock, nBefore, nAfter);
    } catch {
      discovery.truncated = true; // a failed nonce read ends the search; what it found stays
    }
    opts.progress?.(`nonce search: ${discovery.nonceCalls} reads, ${leaves.length} block${leaves.length === 1 ? "" : "s"} to open`);
    for (const b of leaves) {
      const blk = await call("get_block", { block: b.toString(), includeTransactions: true } as Record<string, unknown>);
      discovery.blocksRead++;
      for (const t of (blk?.transactions ?? []) as unknown as { hash: Hex; from: Hex }[]) if (lower(t.from) === me && !sentAt.get(b.toString())?.has(t.hash)) await processHash(t.hash);
    }
  }
  items.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
  return {
    wallet, network, nativeSymbol, range, items,
    coverage: {
      logWindows: windows * 2, logsRead: logs.length,
      blockScan: { mode: scanN === 0 ? "off" : scanN >= total ? "full" : "partial", scanned: scanN, of: total },
      sentFound, sentExpected, discovery, skipped: hashes.length - chosen.length,
    },
  };
}

// ---------- formatting and totals ----------

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function fmtAmount(raw: bigint, decimals: number | undefined, symbol: string): string {
  if (decimals === undefined) return `${group(raw.toString())} ${symbol}`.trim();
  const [int, frac = ""] = formatUnits(raw, decimals).split(".");
  const f = frac.slice(0, 4).replace(/0+$/, "");
  return `${group(int!)}${f ? `.${f}` : ""} ${symbol}`.trim();
}
export const fmtLeg = (l: Leg) => (l.nft !== undefined ? `${l.symbol} #${l.nft}` : fmtAmount(l.amountRaw, l.decimals, l.symbol));
export const fmtWei = (wei: bigint, symbol: string) => {
  const s = formatUnits(wei, 18);
  const [i, f = ""] = s.split(".");
  return `${i}.${f.slice(0, 6).padEnd(6, "0")} ${symbol}`;
};

export interface TokenTotal { symbol: string; decimals: number | undefined; token: string; count: number; raw: bigint }
export interface Totals {
  counts: Record<Category, number>;
  /** Per token: how much came in and went out through plain transfers (swaps are counted under their own category). */
  inflow: TokenTotal[];
  outflow: TokenTotal[];
  swapsOut: TokenTotal[];
  swapsIn: TokenTotal[];
  feesWei: bigint;
  txs: number;
  failed: number;
  unlimitedApprovals: number;
}

function add(into: Map<string, TokenTotal>, l: Leg) {
  const k = String(l.token).toLowerCase();
  const cur = into.get(k) ?? { symbol: l.symbol, decimals: l.decimals, token: String(l.token), count: 0, raw: 0n };
  cur.count++;
  cur.raw += l.amountRaw;
  into.set(k, cur);
}

export function totalsOf(items: Item[]): Totals {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const inflow = new Map<string, TokenTotal>(), outflow = new Map<string, TokenTotal>(), sOut = new Map<string, TokenTotal>(), sIn = new Map<string, TokenTotal>();
  let feesWei = 0n, failed = 0, unlimitedApprovals = 0;
  const txs = new Set<string>(), failedTx = new Set<string>();
  for (const it of items) {
    counts[it.category]++;
    txs.add(it.tx);
    feesWei += it.feeWei;
    if (it.status === "reverted") failedTx.add(it.tx);
    if (it.unlimited) unlimitedApprovals++;
    if (it.category === "transfer-in") it.in.forEach((l) => add(inflow, l));
    else if (it.category === "transfer-out") it.out.forEach((l) => add(outflow, l));
    else if (it.category === "swap") (it.out.forEach((l) => add(sOut, l)), it.in.forEach((l) => add(sIn, l)));
  }
  failed = failedTx.size;
  const arr = (m: Map<string, TokenTotal>) => [...m.values()].sort((a, b) => b.count - a.count);
  return { counts, inflow: arr(inflow), outflow: arr(outflow), swapsOut: arr(sOut), swapsIn: arr(sIn), feesWei, txs: txs.size, failed, unlimitedApprovals };
}

/** Counterparties the wallet dealt with in this activity (the other side of transfers, spenders, pools, called contracts). */
export function counterparties(items: Item[]): Set<string> {
  const s = new Set<string>();
  for (const it of items) if (it.counterparty && !isZero(it.counterparty)) s.add(lower(it.counterparty));
  return s;
}

/** The zero address is where tokens are minted from and burned to, not someone the wallet dealt with. */
export const isZero = (a: string) => /^0x0{40}$/i.test(a);

export const dayUtc = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
export const stampUtc = (ts: number) => new Date(ts * 1000).toISOString().replace(".000Z", "Z");
