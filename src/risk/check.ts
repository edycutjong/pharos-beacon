import { getAddress, isAddress, pad, type Hex, type RpcLog } from "viem";
import { getLogsRange, type ChainMcp } from "../lib/mcp.js";
import { TOKENS } from "../lib/networks.js";

// Wallet risk check: reads an address's on-chain history through the Chain MCP and turns six signals into one low / medium / high
// verdict with a plain-language reason for each. Everything is derived from chain reads plus two lists WE keep (flagged addresses and
// trusted spenders); nothing is fetched from a third-party reputation service.

export type Call = ChainMcp["call"];
export type Level = "ok" | "info" | "medium" | "high";
export type Verdict = "low" | "medium" | "high";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925" as Hex;
const UNLIMITED = 1n << 255n; // an approval at or above 2^255 is "unlimited" for every practical purpose

export interface RiskConfig {
  /** Addresses we have flagged, each with why and where the flag comes from. */
  flagged: { address: Hex; reason: string; source: string }[];
  /** Spenders we recognise, so an approval to them is not "unknown". */
  trustedSpenders: { address: Hex; label: string }[];
  /** ERC-20s to scan for transfers and approvals, besides the Pharos token registry. */
  extraTokens: Hex[];
  /** A wallet or contract younger than this many days is a red flag. */
  youngDays: number;
}

export function parseRiskConfig(raw: unknown): RiskConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const addr = (v: unknown, what: string) => {
    if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error(`${what} must be a 0x address (got ${JSON.stringify(v)})`);
    return getAddress(v);
  };
  const list = (v: unknown, name: string): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`"${name}" must be a list`);
    return v;
  };
  const text = (v: unknown, what: string) => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${what} must be text`);
    return v.trim();
  };
  const youngDays = r.youngDays === undefined ? 7 : Number(r.youngDays);
  if (!Number.isFinite(youngDays) || youngDays <= 0) throw new Error('"youngDays" must be a positive number');
  return {
    flagged: list(r.flagged, "flagged").map((e, i) => {
      const x = e as Record<string, unknown>;
      return { address: addr(x?.address, `flagged[${i}].address`), reason: text(x?.reason, `flagged[${i}].reason`), source: text(x?.source, `flagged[${i}].source`) };
    }),
    trustedSpenders: list(r.trustedSpenders, "trustedSpenders").map((e, i) => {
      const x = e as Record<string, unknown>;
      return { address: addr(x?.address, `trustedSpenders[${i}].address`), label: text(x?.label, `trustedSpenders[${i}].label`) };
    }),
    extraTokens: list(r.extraTokens, "extraTokens").map((a, i) => addr(a, `extraTokens[${i}]`)),
    youngDays,
  };
}

export interface Signal {
  id: "kind" | "age" | "funding" | "flagged" | "approvals" | "counterparties";
  level: Level;
  /** One short line: what was checked. */
  title: string;
  /** Plain language: what we found and why it matters. */
  detail: string;
}

export interface RiskReport {
  address: Hex;
  network: "pharos" | "atlantic";
  /** The head the check was pinned to. */
  block: bigint;
  lookbackBlocks: bigint;
  verdict: Verdict;
  signals: Signal[];
  /** The reasons that moved the verdict (every medium and high signal), in plain language. */
  reasons: string[];
}

const rank: Record<Level, number> = { ok: 0, info: 0, medium: 1, high: 2 };

/** high if any signal is high or three are medium; medium if one or two are medium; else low. */
export function verdictOf(signals: Signal[]): Verdict {
  if (signals.some((s) => s.level === "high")) return "high";
  const mediums = signals.filter((s) => s.level === "medium").length;
  return mediums >= 3 ? "high" : mediums >= 1 ? "medium" : "low";
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const num = (hex: string | undefined) => BigInt(hex ?? "0");

/** First block at which `has(block)` is true, for a predicate that never goes back to false (nonce > 0, code present). */
export async function firstBlock(has: (b: bigint) => Promise<boolean>, head: bigint): Promise<bigint | null> {
  if (!(await has(head))) return null;
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await has(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

const days = (seconds: number) => seconds / 86_400;
const ago = (seconds: number) => (seconds < 3600 ? `${Math.max(1, Math.round(seconds / 60))} minutes` : seconds < 172_800 ? `${(seconds / 3600).toFixed(1)} hours` : `${days(seconds).toFixed(0)} days`);

export interface CheckOptions {
  network: "pharos" | "atlantic";
  config: RiskConfig;
  /** Blocks of token history to read for the counterparty and approval signals (default 30,000). */
  lookbackBlocks?: bigint;
}

export async function checkAddress(call: Call, address: Hex, o: CheckOptions): Promise<RiskReport> {
  const target = getAddress(address);
  const head = num(((await call("get_block_number")) as { blockNumber: string }).blockNumber);
  const lookback = o.lookbackBlocks ?? 30_000n;
  const signals: Signal[] = [];
  const flagged = new Map(o.config.flagged.map((f) => [f.address.toLowerCase(), f]));
  const trusted = new Map(o.config.trustedSpenders.map((t) => [t.address.toLowerCase(), t.label]));
  for (const t of Object.values(TOKENS[o.network])) trusted.set(t.address.toLowerCase(), "a token in the Pharos token registry");

  const code = ((await call("get_code", { address: target, block: head.toString() })) as { code: Hex }).code;
  const isContract = code !== "0x" && code !== "0x0";
  const nonce = num(((await call("get_transaction_count", { address: target, block: head.toString() })) as { nonce: string }).nonce);
  const balance = num(((await call("get_balance", { address: target, block: head.toString() })) as { balanceWei: string }).balanceWei);

  // 1. wallet or contract
  signals.push({
    id: "kind",
    level: "info",
    title: "wallet or contract (get_code)",
    detail: isContract
      ? `It is a contract (${(code.length - 2) / 2} bytes of code). A contract can do whatever its code says, and the Chain MCP cannot tell us whether its source is verified, so read the source before you trust it.`
      : "It is a plain wallet (no code).",
  });

  // 2. age: the first block with code (contract) or with a sent transaction (wallet), found by binary search on archive reads
  const firstSeen = await firstBlock(
    async (b) =>
      isContract
        ? ((await call("get_code", { address: target, block: b.toString() })) as { code: Hex }).code !== "0x"
        : num(((await call("get_transaction_count", { address: target, block: b.toString() })) as { nonce: string }).nonce) > 0n,
    head,
  );
  const stamp = async (b: bigint) => Number(num(((await call("get_block", { block: b.toString() })) as { timestamp: string }).timestamp));
  let ageSeconds: number | undefined;
  if (firstSeen === null) {
    signals.push({
      id: "age",
      level: nonce === 0n && balance === 0n ? "medium" : "info",
      title: isContract ? "contract age (first block with code)" : "wallet age (first block with a sent transaction)",
      detail: nonce === 0n && balance === 0n
        ? "This address has no history at all: no code, no sent transactions and no balance. There is nothing to judge it by."
        : "This wallet has never sent a transaction, so its age cannot be measured from its own activity.",
    });
  } else {
    ageSeconds = (await stamp(head)) - (await stamp(firstSeen));
    const young = days(ageSeconds) < o.config.youngDays;
    signals.push({
      id: "age",
      level: young ? "medium" : "ok",
      title: isContract ? "contract age (first block with code)" : "wallet age (first block with a sent transaction)",
      detail: `${isContract ? "Its code first appears" : "It first sent a transaction"} in block ${firstSeen}, ${ago(ageSeconds)} before block ${head}.${young ? ` That is under ${o.config.youngDays} days: a new address has no track record.` : " It has been around a while."}`,
    });
  }

  // 3. funding: nonce and balance
  const funding: Signal =
    isContract
      ? { id: "funding", level: "ok", title: "nonce and balance", detail: `A contract's nonce (${nonce}) counts the contracts it created; balance ${balance} wei.` }
      : nonce === 0n && balance > 0n
        ? { id: "funding", level: "medium", title: "nonce and balance (freshly funded?)", detail: `It holds ${balance} wei but has never sent a transaction (nonce 0): funds arrived and nothing has left, which is how a freshly funded address looks.` }
        : nonce === 0n
          ? { id: "funding", level: "ok", title: "nonce and balance (freshly funded?)", detail: "It has no balance and has never sent anything." }
          : { id: "funding", level: "ok", title: "nonce and balance (freshly funded?)", detail: `It has sent ${nonce} transaction${nonce === 1n ? "" : "s"} (nonce ${nonce}) and holds ${balance} wei, so it has been used.` };
  signals.push(funding);

  // 4-6. token history: transfers and approvals in the lookback range
  const tokens = [...new Set([...Object.values(TOKENS[o.network]).map((t) => t.address.toLowerCase()), ...o.config.extraTokens.map((a) => a.toLowerCase())])] as Hex[];
  const from = head - lookback > 0n ? head - lookback : 0n;
  const id = pad(target.toLowerCase() as Hex, { size: 32 });
  const q = (topics: (Hex | Hex[] | null)[]) => getLogsRange(call, { address: tokens, topics, fromBlock: from, toBlock: head });
  const sent = await q([TRANSFER_TOPIC, id]);
  const received = await q([TRANSFER_TOPIC, null, id]);
  const approvals = await q([APPROVAL_TOPIC, id]);
  const window = `blocks ${from}–${head}`;

  const counterparts = new Map<string, { address: Hex; txs: Set<string> }>();
  const note = (log: RpcLog, topicIndex: 1 | 2) => {
    if (log.topics.length !== 3) return;
    const a = getAddress(`0x${log.topics[topicIndex]!.slice(26)}`);
    if (a === target) return;
    const e = counterparts.get(a.toLowerCase()) ?? { address: a, txs: new Set<string>() };
    e.txs.add(log.transactionHash!);
    counterparts.set(a.toLowerCase(), e);
  };
  sent.forEach((l) => note(l, 2));
  received.forEach((l) => note(l, 1));

  // 4. flagged: the address itself, or anyone it moved tokens with
  const selfFlag = flagged.get(target.toLowerCase());
  const hits = [...counterparts.values()].filter((c) => flagged.has(c.address.toLowerCase()));
  if (selfFlag) {
    signals.push({ id: "flagged", level: "high", title: "on our flagged list", detail: `This address is on our flagged list: ${selfFlag.reason} (source: ${selfFlag.source}).` });
  } else if (hits.length) {
    const h = hits[0]!;
    const f = flagged.get(h.address.toLowerCase())!;
    signals.push({
      id: "flagged",
      level: "high",
      title: "interaction with a flagged address",
      detail: `It moved tokens with ${short(h.address)}, which is on our flagged list (${f.reason}; source: ${f.source}). Transaction${h.txs.size === 1 ? "" : "s"}: ${[...h.txs].join(", ")}.${hits.length > 1 ? ` ${hits.length - 1} more flagged counterpart${hits.length === 2 ? "" : "s"} too.` : ""}`,
    });
  } else {
    signals.push({ id: "flagged", level: "ok", title: "interaction with flagged addresses", detail: `None of its ${counterparts.size} token counterpart${counterparts.size === 1 ? "" : "s"} in ${window} is on our flagged list (${o.config.flagged.length} address${o.config.flagged.length === 1 ? "" : "es"}). Native-coin transfers leave no log and are not covered.` });
  }

  // 5. approvals: the latest approval per (token, spender), non-zero, to a spender we do not recognise
  const latest = new Map<string, { token: Hex; spender: Hex; value: bigint; tx: string }>();
  for (const l of approvals) {
    if (l.topics.length !== 3) continue;
    const spender = getAddress(`0x${l.topics[2]!.slice(26)}`);
    latest.set(`${l.address.toLowerCase()}:${spender.toLowerCase()}`, { token: getAddress(l.address), spender, value: BigInt(l.data), tx: l.transactionHash! });
  }
  const live = [...latest.values()].filter((a) => a.value > 0n);
  const unknown = live.filter((a) => !trusted.has(a.spender.toLowerCase()));
  const flaggedSpender = live.find((a) => flagged.has(a.spender.toLowerCase()));
  const unlimitedUnknown = unknown.filter((a) => a.value >= UNLIMITED);
  if (flaggedSpender) {
    signals.push({ id: "approvals", level: "high", title: "approvals to unknown spenders", detail: `It has an open approval to ${short(flaggedSpender.spender)}, which is on our flagged list. That address can move the approved tokens at any time (tx ${flaggedSpender.tx}).` });
  } else if (unlimitedUnknown.length) {
    const u = unlimitedUnknown[0]!;
    signals.push({ id: "approvals", level: "medium", title: "approvals to unknown spenders", detail: `It gave ${short(u.spender)} an unlimited allowance (2^255 or more) on token ${short(u.token)} (tx ${u.tx}). We do not recognise that spender, and an unlimited approval lets it take the token's whole balance later.${unlimitedUnknown.length > 1 ? ` ${unlimitedUnknown.length - 1} more like it.` : ""}` });
  } else if (unknown.length) {
    const u = unknown[0]!;
    signals.push({ id: "approvals", level: "medium", title: "approvals to unknown spenders", detail: `It has an open approval to ${short(u.spender)} that we do not recognise (tx ${u.tx}).${unknown.length > 1 ? ` ${unknown.length - 1} more.` : ""}` });
  } else {
    signals.push({ id: "approvals", level: "ok", title: "approvals to unknown spenders", detail: `${live.length} open token approval${live.length === 1 ? "" : "s"} in ${window}, none to a spender we do not recognise.` });
  }

  // 6. activity context (informational): how many different counterparts, so "no history" is visible
  signals.push({
    id: "counterparties",
    level: "info",
    title: "token activity in the lookback range",
    detail: `${sent.length + received.length} token transfer${sent.length + received.length === 1 ? "" : "s"} with ${counterparts.size} counterpart${counterparts.size === 1 ? "" : "s"} in ${window} (${lookback} blocks).`,
  });

  const verdict = verdictOf(signals);
  const reasons = signals.filter((s) => rank[s.level] > 0).map((s) => s.detail);
  return { address: target, network: o.network, block: head, lookbackBlocks: lookback, verdict, signals, reasons };
}

const MARK: Record<Level, string> = { ok: "ok    ", info: "info  ", medium: "MEDIUM", high: "HIGH  " };

export function reportText(r: RiskReport): string {
  const lines = [`risk check of ${r.address} on ${r.network} at block ${r.block}`];
  for (const s of r.signals) lines.push(`  [${MARK[s.level]}] ${s.title}`, `           ${s.detail}`);
  lines.push(`RISK: ${r.verdict.toUpperCase()}${r.reasons.length ? ` — ${r.signals.filter((s) => rank[s.level] > 0).length} red flag${r.signals.filter((s) => rank[s.level] > 0).length === 1 ? "" : "s"}` : " — no red flags"}`);
  r.signals.filter((s) => rank[s.level] > 0).forEach((s, i) => lines.push(`  ${i + 1}. ${s.detail}`));
  return lines.join("\n");
}
