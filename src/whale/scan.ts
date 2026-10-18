import { decodeFunctionResult, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, pad, parseUnits, type Hex, type RpcLog } from "viem";
import { getLogsRange, type ChainMcp } from "../lib/mcp.js";
import { TOKENS } from "../lib/networks.js";
import { tokenInfo } from "../watch/token.js";

// Whale watching: significant ERC-20 Transfer events into or out of a configurable set of addresses, read through the Chain MCP
// (get_logs for the moves, get_code to tell a wallet from a contract, eth_call balanceOf before/after for the context).

export type Call = ChainMcp["call"];
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
export const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

export interface WatchedAddress {
  address: Hex;
  label: string;
}
export interface TokenRule {
  address: Hex;
  /** Human units ("10000" = 10,000 USDC); one move at or above it is significant. */
  threshold: string;
}
export interface Watchlist {
  network: "pharos" | "atlantic";
  /** Where the list came from, copied into the report and the proof. */
  source: string;
  addresses: WatchedAddress[];
  tokens: TokenRule[];
  /** Our own labels for counterparts. */
  labels: Record<string, string>;
}

const asAddress = (v: unknown, what: string): Hex => {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error(`${what} must be a 0x address (got ${JSON.stringify(v)})`);
  return getAddress(v);
};

export function parseWatchlist(raw: unknown): Watchlist {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new Error("the watchlist must be a JSON object");
  const network = r.network === "atlantic" ? "atlantic" : r.network === "pharos" || r.network === undefined ? "pharos" : null;
  if (!network) throw new Error('"network" must be "pharos" or "atlantic"');
  if (!Array.isArray(r.addresses) || r.addresses.length < 5) throw new Error('"addresses" must list at least 5 addresses to watch');
  const seen = new Set<string>();
  const addresses = r.addresses.map((a, i) => {
    const e = a as { address?: unknown; label?: unknown };
    const address = asAddress(e?.address, `addresses[${i}].address`);
    if (seen.has(address)) throw new Error(`addresses[${i}] repeats ${address}`);
    seen.add(address);
    if (typeof e.label !== "string" || !e.label.trim()) throw new Error(`addresses[${i}] needs a label`);
    return { address, label: e.label.trim() };
  });
  if (!Array.isArray(r.tokens) || r.tokens.length === 0) throw new Error('"tokens" must list at least one {address, threshold}');
  const tokens = r.tokens.map((t, i) => {
    const e = t as { address?: unknown; threshold?: unknown };
    if (typeof e?.threshold !== "string" || !/^\d+(\.\d+)?$/.test(e.threshold) || Number(e.threshold) <= 0) throw new Error(`tokens[${i}].threshold must be a positive number as text, e.g. "10000"`);
    return { address: asAddress(e.address, `tokens[${i}].address`), threshold: e.threshold };
  });
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries((r.labels ?? {}) as Record<string, unknown>)) {
    if (typeof v !== "string" || !v.trim()) throw new Error(`labels[${k}] must be text`);
    labels[asAddress(k, "a label key").toLowerCase()] = v.trim();
  }
  return { network, source: typeof r.source === "string" ? r.source : "", addresses, tokens, labels };
}

export interface TokenMeta extends TokenRule {
  symbol: string;
  decimals: number;
  thresholdRaw: bigint;
}

export async function loadTokens(call: Call, rules: TokenRule[]): Promise<TokenMeta[]> {
  const out: TokenMeta[] = [];
  for (const t of rules) {
    const info = await tokenInfo(call, t.address);
    if (!info) throw new Error(`${t.address} is not an ERC-20 (decimals()/symbol() failed), so its threshold cannot be applied`);
    out.push({ ...t, ...info, thresholdRaw: parseUnits(t.threshold, info.decimals) });
  }
  return out;
}

export interface Move {
  token: TokenMeta;
  from: Hex;
  to: Hex;
  amountRaw: bigint;
  block: bigint;
  logIndex: number;
  tx: Hex;
}

const topicAddr = (a: Hex) => pad(a.toLowerCase() as Hex, { size: 32 });

/** Every Transfer of `token` in the pinned range with a watched address as sender or recipient, in chain order, de-duplicated. */
export async function scanMoves(call: Call, token: TokenMeta, watched: Hex[], fromBlock: bigint, toBlock: bigint): Promise<Move[]> {
  const ids = watched.map(topicAddr);
  const [sent, received] = [
    await getLogsRange(call, { address: token.address, topics: [TRANSFER_TOPIC, ids], fromBlock, toBlock }),
    await getLogsRange(call, { address: token.address, topics: [TRANSFER_TOPIC, null, ids], fromBlock, toBlock }),
  ];
  const seen = new Set<string>();
  const moves: Move[] = [];
  for (const log of [...sent, ...received] as RpcLog[]) {
    if (log.topics.length !== 3) continue; // an ERC-721 Transfer has four topics: not a token amount
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    moves.push({
      token,
      from: getAddress(`0x${log.topics[1]!.slice(26)}`),
      to: getAddress(`0x${log.topics[2]!.slice(26)}`),
      amountRaw: BigInt(log.data),
      block: BigInt(log.blockNumber!),
      logIndex: Number(BigInt(log.logIndex!)),
      tx: log.transactionHash as Hex,
    });
  }
  return moves.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
}

export const isSignificant = (m: Move) => m.amountRaw >= m.token.thresholdRaw;

export async function balanceAt(call: Call, token: Hex, holder: Hex, block: bigint): Promise<bigint> {
  const { result } = (await call("eth_call", { transaction: { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] }) }, block: block.toString() })) as { result: Hex };
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result }) as bigint;
}

export type Kind = "wallet" | "contract";
/** Wallet or contract, from get_code, cached per address. */
export function kindResolver(call: Call): (a: Hex) => Promise<Kind> {
  const cache = new Map<string, Kind>();
  return async (a) => {
    const k = a.toLowerCase();
    if (!cache.has(k)) {
      const { code } = (await call("get_code", { address: a })) as { code: Hex };
      cache.set(k, code === "0x" || code === "0x0" ? "wallet" : "contract");
    }
    return cache.get(k)!;
  };
}

export interface Namer {
  /** The label, or "unlabelled wallet|contract" when we know nothing but the kind. */
  name(a: Hex): Promise<{ text: string; known: boolean }>;
}

export function makeNamer(wl: Watchlist, network: "pharos" | "atlantic", tokens: TokenMeta[], kindOf: (a: Hex) => Promise<Kind>): Namer {
  const known = new Map<string, string>();
  for (const [sym, t] of Object.entries(TOKENS[network])) known.set(t.address.toLowerCase(), `${sym} token contract (Pharos token registry)`);
  for (const t of tokens) if (!known.has(t.address.toLowerCase())) known.set(t.address.toLowerCase(), `${t.symbol} token contract`);
  for (const [k, v] of Object.entries(wl.labels)) known.set(k, v);
  for (const w of wl.addresses) known.set(w.address.toLowerCase(), w.label);
  known.set(ZERO.toLowerCase(), "null address (mint or burn)");
  return {
    async name(a) {
      const hit = known.get(a.toLowerCase());
      return hit ? { text: hit, known: true } : { text: `unlabelled ${await kindOf(a)}`, known: false };
    },
  };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = (part: bigint, whole: bigint) => {
  const tenths = Number((part * 1000n) / whole);
  return tenths < 1 ? "<0.1%" : `${tenths / 10}%`;
};
const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function fmtAmount(raw: bigint, decimals: number, symbol: string): string {
  const [int, frac = ""] = formatUnits(raw, decimals).split(".");
  const f = frac.slice(0, 4).replace(/0+$/, "");
  return `${group(int!)}${f ? `.${f}` : ""}${symbol ? ` ${symbol}` : ""}`;
}

export interface Report {
  move: Move;
  /** The watched address the move is about (the sender when both are watched). */
  subject: Hex;
  direction: "OUT" | "IN" | "BETWEEN";
  fromName: string;
  toName: string;
  fromKnown: boolean;
  toKnown: boolean;
  multiple: number;
  beforeRaw: bigint;
  afterRaw: bigint;
  timestamp?: string;
  why: string[];
}

export async function explain(call: Call, m: Move, wl: Watchlist, namer: Namer, kindOf: (a: Hex) => Promise<Kind>, rank: { largest: bigint }): Promise<Report> {
  const watched = new Set(wl.addresses.map((a) => a.address));
  const fromW = watched.has(m.from);
  const toW = watched.has(m.to);
  const subject = fromW ? m.from : m.to;
  const direction = fromW && toW ? "BETWEEN" : fromW ? "OUT" : "IN";
  const [f, t] = [await namer.name(m.from), await namer.name(m.to)];
  const afterRaw = await balanceAt(call, m.token.address, subject, m.block);
  const beforeRaw = await balanceAt(call, m.token.address, subject, m.block - 1n);
  const block = (await call("get_block", { block: m.block.toString() })) as { timestamp?: string } | null;
  const timestamp = block?.timestamp ? new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() : undefined;
  const multiple = Number((m.amountRaw * 100n) / m.token.thresholdRaw) / 100;
  const why: string[] = [`${multiple}× the ${group(m.token.threshold)} ${m.token.symbol} threshold`];
  const sym = m.token.symbol;
  if (beforeRaw === 0n && afterRaw === 0n) why.push(`pass-through: the address held 0 ${sym} before and after block ${m.block}, so it received and passed this on within the block`);
  else if (direction === "OUT" && afterRaw === 0n) why.push(`EXIT: it left this address with 0 ${sym}`);
  else if (direction === "IN" && beforeRaw === 0n) why.push(`NEW POSITION: the address held 0 ${sym} before this`);
  else if (direction === "OUT" && beforeRaw > 0n) why.push(`${pct(m.amountRaw, beforeRaw)} of its ${sym} balance before the move`);
  else if (direction === "IN" && beforeRaw > 0n) why.push(`it adds ${pct(m.amountRaw, beforeRaw)} to its ${sym} balance`);
  if (m.amountRaw === rank.largest) why.push(`the largest ${m.token.symbol} move in this window`);
  const other = direction === "OUT" ? m.to : direction === "IN" ? m.from : undefined;
  if (other && other !== ZERO && !wl.labels[other.toLowerCase()] && !watched.has(other) && (await kindOf(other)) === "contract")
    why.push(`${direction === "OUT" ? "sent to" : "received from"} a contract, which usually means a deposit, swap or bridge (a heuristic, not a fact)`);
  if (other === ZERO) why.push(m.from === ZERO ? "a mint into the watched address" : "a burn from the watched address");
  return { move: m, subject, direction, fromName: f.text, toName: t.text, fromKnown: f.known, toKnown: t.known, multiple, beforeRaw, afterRaw, ...(timestamp ? { timestamp } : {}), why };
}

export function reportText(r: Report, explorer: (tx: string) => string, index?: number): string {
  const m = r.move;
  const amt = fmtAmount(m.amountRaw, m.token.decimals, m.token.symbol);
  return [
    `${index ? `[${index}] ` : ""}${r.direction} ${amt} · block ${m.block}${r.timestamp ? ` · ${r.timestamp}` : ""}`,
    `    ${short(m.from)} (${r.fromName}) → ${short(m.to)} (${r.toName})`,
    `    why it matters: ${r.why.join("; ")}`,
    `    balance of ${short(r.subject)}: ${fmtAmount(r.beforeRaw, m.token.decimals, m.token.symbol)} → ${fmtAmount(r.afterRaw, m.token.decimals, m.token.symbol)}`,
    `    ${explorer(m.tx)}`,
  ].join("\n");
}

export interface Row {
  label: string;
  address: Hex;
  token: string;
  decimals: number;
  transfers: number;
  significant: number;
  inRaw: bigint;
  outRaw: bigint;
  largestRaw: bigint;
}

/** One row per (watched address, token): everything seen, how much of it was significant, and the net flow of the significant moves. */
export function summarise(wl: Watchlist, tokens: TokenMeta[], moves: Move[]): Row[] {
  const rows: Row[] = [];
  for (const w of wl.addresses) {
    for (const t of tokens) {
      const mine = moves.filter((m) => m.token.address === t.address && (m.from === w.address || m.to === w.address));
      const sig = mine.filter(isSignificant);
      rows.push({
        label: w.label,
        address: w.address,
        token: t.symbol,
        decimals: t.decimals,
        transfers: mine.length,
        significant: sig.length,
        inRaw: sig.filter((m) => m.to === w.address).reduce((s, m) => s + m.amountRaw, 0n),
        outRaw: sig.filter((m) => m.from === w.address).reduce((s, m) => s + m.amountRaw, 0n),
        largestRaw: sig.reduce((s, m) => (m.amountRaw > s ? m.amountRaw : s), 0n),
      });
    }
  }
  return rows;
}

export function summaryTable(rows: Row[]): string {
  const head = ["watched address", "token", "transfers", "significant", "in (sig.)", "out (sig.)", "largest"];
  const body = rows.map((r) => [
    `${r.label} ${short(r.address)}`,
    r.token,
    String(r.transfers),
    String(r.significant),
    fmtAmount(r.inRaw, r.decimals, ""),
    fmtAmount(r.outRaw, r.decimals, ""),
    fmtAmount(r.largestRaw, r.decimals, ""),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i < 2 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  ");
  return [line(head), line(w.map((n) => "-".repeat(n))), ...body.map(line)].join("\n");
}

/** A short Discord message for one report (Discord caps a message at 2,000 characters). */
export function discordText(r: Report, explorer: (tx: string) => string): string {
  const m = r.move;
  return [`🐋 **${r.direction} ${fmtAmount(m.amountRaw, m.token.decimals, m.token.symbol)}** · block ${m.block}`, `${r.fromName} → ${r.toName}`, r.why.join("; "), explorer(m.tx)].join("\n");
}
