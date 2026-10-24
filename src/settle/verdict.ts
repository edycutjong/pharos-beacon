import type { Hex, RpcBlock, RpcTransaction, RpcTransactionReceipt } from "viem";
import type { ChainMcp } from "../lib/mcp.js";

// Settlement verdict: the decision half of the skill. Everything it decides on comes from the Chain MCP in the same run
// (the transaction, its receipt, the head block, two block timestamps), nothing is cached: the same hash answers WAIT
// now and SETTLED a few blocks later.

export type Call = ChainMcp["call"];
export type Verdict = "SETTLED" | "WAIT" | "FAILED" | "MISMATCH" | "NOT_FOUND";

/** keccak256("Transfer(address,address,uint256)"): an ERC-20 (or ERC-721) transfer in a receipt. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WEI = 10n ** 18n;

/** Confirmations required by value: the first tier whose `below` (whole coins) is above the value; the last tier has no limit. */
export interface Tier {
  below: number | null;
  confirmations: number;
}
export const DEFAULT_TIERS: Tier[] = [
  { below: 1, confirmations: 3 },
  { below: 100, confirmations: 12 },
  { below: null, confirmations: 32 },
];

/** "1=3,100=12,*=32" → tiers. Thresholds ascend, the last one is `*`, confirmations are whole numbers ≥ 1. */
export function parseTiers(text: string): Tier[] {
  const tiers: Tier[] = [];
  for (const part of text.split(",")) {
    const m = /^\s*(\*|\d+(?:\.\d+)?)\s*=\s*(\d+)\s*$/.exec(part);
    if (!m) throw new Error(`tier "${part.trim()}" is not <coins>=<confirmations> (or *=<confirmations>)`);
    const confirmations = Number(m[2]);
    if (confirmations < 1) throw new Error("a tier needs at least 1 confirmation");
    tiers.push({ below: m[1] === "*" ? null : Number(m[1]), confirmations });
  }
  tiers.forEach((t, i) => {
    if ((t.below === null) !== (i === tiers.length - 1)) throw new Error("tiers end with exactly one *=<confirmations>");
    if (i > 0 && t.below !== null && t.below <= (tiers[i - 1]!.below ?? 0)) throw new Error("tier thresholds must ascend");
  });
  return tiers;
}

export interface Expect {
  to?: Hex;
  /** Whole coins: the transaction must carry at least this much native value. */
  minValue?: string;
}

export interface Facts {
  hash: Hex;
  from?: Hex;
  to: Hex | null;
  valueWei: bigint;
  status?: "success" | "reverted";
  block?: bigint;
  head: bigint;
  gasUsed?: bigint;
  tokenTransfers: number;
  blockSeconds?: number;
}

export interface Report {
  verdict: Verdict;
  /** The rule that decided, in words a person can check. */
  rule: string;
  facts: Facts;
  confirmations?: number;
  required?: number;
  /** Which value tier chose `required`. */
  tier?: string;
  waitBlocks?: number;
  waitSeconds?: number;
}

export function parseCoins(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a coin amount (digits with up to 18 decimals)`);
  return BigInt(m[1]!) * WEI + BigInt((m[2] ?? "").padEnd(18, "0"));
}
export const coins = (wei: bigint): string => {
  const frac = (wei % WEI).toString().padStart(18, "0").replace(/0+$/, "");
  return `${wei / WEI}${frac ? "." + frac : ""}`;
};

/** Required confirmations for a value; a token transfer without native value is treated as the middle tier, because its worth is unknown. */
export function requiredFor(valueWei: bigint, tokenTransfers: number, tiers: Tier[]): { required: number; tier: string } {
  const idx = tiers.findIndex((t) => t.below === null || valueWei < BigInt(Math.round(t.below * 1e6)) * (WEI / 1_000_000n));
  let i = idx < 0 ? tiers.length - 1 : idx;
  let why = `${coins(valueWei)} native value`;
  if (valueWei === 0n && tokenTransfers > 0 && tiers.length > 1) {
    i = Math.max(i, 1);
    why = `${tokenTransfers} token transfer(s) and no native value, so the worth is unknown`;
  }
  const t = tiers[i]!;
  return { required: t.confirmations, tier: `${why} → tier ${i + 1} of ${tiers.length} (${t.below === null ? "no upper limit" : `below ${t.below}`})` };
}

/**
 * Judge one transaction. Reads, in this order: get_transaction → get_transaction_receipt → get_block_number →
 * get_block (receipt block) → get_block (head, head−20) for the observed block time. A missing transaction ends it early.
 */
export async function judge(call: Call, hash: Hex, opts: { tiers?: Tier[]; expect?: Expect; override?: number } = {}): Promise<Report> {
  const tiers = opts.tiers ?? DEFAULT_TIERS;
  const tx = (await call("get_transaction", { hash })) as RpcTransaction | null;
  const head = BigInt((await call("get_block_number")).blockNumber);
  if (!tx) {
    return { verdict: "NOT_FOUND", rule: "the node returns no transaction for this hash: it was never broadcast to this network, or was dropped", facts: { hash, to: null, valueWei: 0n, head, tokenTransfers: 0 } };
  }
  const receipt = (await call("get_transaction_receipt", { hash })) as RpcTransactionReceipt | null;
  const valueWei = BigInt(tx.value ?? "0x0");
  const base: Facts = { hash, from: tx.from, to: tx.to ?? null, valueWei, head, tokenTransfers: 0 };
  if (!receipt) {
    return { verdict: "WAIT", rule: "known to the node but not mined yet: there is no receipt", facts: base };
  }
  const block = BigInt(receipt.blockNumber);
  const tokenTransfers = receipt.logs.filter((l) => l.topics[0] === TRANSFER_TOPIC).length;
  const facts: Facts = { ...base, block, status: receipt.status === "0x1" ? "success" : "reverted", gasUsed: BigInt(receipt.gasUsed), tokenTransfers };
  if (receipt.status !== "0x1") {
    return { verdict: "FAILED", rule: "the receipt status is 0x0: the transaction was mined and reverted, so nothing it was meant to do happened (gas was still spent)", facts, confirmations: Number(head - block + 1n) };
  }
  const confirmations = Number(head - block + 1n);
  const e = opts.expect ?? {};
  if (e.to && (tx.to ?? "").toLowerCase() !== e.to.toLowerCase()) {
    return { verdict: "MISMATCH", rule: `expected recipient ${e.to} but the transaction went to ${tx.to ?? "a contract creation"}`, facts, confirmations };
  }
  if (e.minValue !== undefined && valueWei < parseCoins(e.minValue)) {
    return { verdict: "MISMATCH", rule: `expected at least ${e.minValue} native value but the transaction carried ${coins(valueWei)}`, facts, confirmations };
  }
  const req = opts.override !== undefined ? { required: opts.override, tier: `--confirmations ${opts.override} given by the caller` } : requiredFor(valueWei, tokenTransfers, tiers);
  const blockSeconds = await observedBlockSeconds(call, head);
  facts.blockSeconds = blockSeconds;
  if (confirmations >= req.required) {
    return { verdict: "SETTLED", rule: `mined with status 0x1 and ${confirmations} confirmations, at least the ${req.required} this tier needs`, facts, confirmations, ...req };
  }
  const waitBlocks = req.required - confirmations;
  return {
    verdict: "WAIT",
    rule: `mined with status 0x1 but ${confirmations} confirmation(s) is below the ${req.required} this tier needs`,
    facts, confirmations, ...req, waitBlocks,
    ...(blockSeconds !== undefined ? { waitSeconds: Math.round(waitBlocks * blockSeconds * 10) / 10 } : {}),
  };
}

/** Seconds per block over the last 20 blocks, from two block timestamps; undefined when the chain is younger than that or the answer is unusable. */
export async function observedBlockSeconds(call: Call, head: bigint): Promise<number | undefined> {
  const span = head >= 20n ? 20n : head;
  if (span === 0n) return undefined;
  const [a, b] = (await Promise.all([call("get_block", { block: head.toString() }), call("get_block", { block: (head - span).toString() })])) as (RpcBlock | null)[];
  if (!a?.timestamp || !b?.timestamp) return undefined;
  const secs = (Number(BigInt(a.timestamp) - BigInt(b.timestamp)) / Number(span));
  return secs > 0 ? Math.round(secs * 100) / 100 : undefined;
}

/** The newest transaction hash in the last `scan` blocks (demo convenience: "check the latest transaction"). */
export async function latestTransaction(call: Call, scan = 60): Promise<{ hash: Hex; block: bigint } | undefined> {
  const head = BigInt((await call("get_block_number")).blockNumber);
  for (let n = head; n > 0n && n > head - BigInt(scan); n--) {
    const b = (await call("get_block", { block: n.toString() })) as (Omit<RpcBlock, "transactions"> & { transactions?: (string | { hash: Hex })[] }) | null;
    const first = b?.transactions?.[0];
    if (first) return { hash: (typeof first === "string" ? first : first.hash) as Hex, block: n };
  }
  return undefined;
}

export function render(r: Report, network: string): string {
  const f = r.facts;
  const lines = [
    `VERDICT ${r.verdict}`,
    `rule    ${r.rule}`,
    `tx      ${f.hash}`,
  ];
  if (f.from) lines.push(`from    ${f.from}  →  to ${f.to ?? "(contract creation)"}`);
  if (f.valueWei > 0n || f.from) lines.push(`value   ${coins(f.valueWei)} native${f.tokenTransfers ? `, ${f.tokenTransfers} token transfer(s) in the receipt` : ""}`);
  if (f.block !== undefined) lines.push(`mined   block ${f.block}, head ${f.head}, status ${f.status}${f.gasUsed !== undefined ? `, gas used ${f.gasUsed}` : ""}`);
  else lines.push(`head    block ${f.head}`);
  if (r.confirmations !== undefined && r.required !== undefined) lines.push(`depth   ${r.confirmations} confirmations of ${r.required} required (${r.tier})`);
  if (r.waitBlocks !== undefined) lines.push(`wait    ${r.waitBlocks} more block(s)${r.waitSeconds !== undefined ? `, about ${r.waitSeconds} s at the observed ${f.blockSeconds} s per block` : ""}`);
  lines.push(`network ${network}`);
  return lines.join("\n");
}
