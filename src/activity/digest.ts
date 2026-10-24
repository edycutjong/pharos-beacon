import { explorerTx } from "../lib/networks.js";
import { counterparties, dayUtc, fmtLeg, fmtWei, totalsOf, type Activity, type Item, type Leg, type TokenTotal } from "./engine.js";

// The Weekly Digest: the activity engine on a period schedule. It turns one period (and the one before it) into key numbers with a
// comparison, the top three notable events, who is new, and a short text for a chat channel. A period is a whole UTC day / week / month
// (or N days) that has already finished, so running the digest twice in the same week describes the same week.

export type Cadence = "daily" | "weekly" | "monthly" | `${number}d`;
export const DAY = 86_400;

export function parseCadence(v: string): Cadence {
  if (v === "daily" || v === "weekly" || v === "monthly") return v;
  const m = /^(\d{1,3})d$/.exec(v);
  if (m && Number(m[1]) >= 1) return v as Cadence;
  throw new Error(`cadence must be daily, weekly, monthly or Nd like 14d (got ${JSON.stringify(v)})`);
}

export interface Period {
  fromTs: number; // inclusive, unix seconds, UTC midnight
  toTs: number; // exclusive
  label: string;
}

const utcMidnight = (ts: number) => Math.floor(ts / DAY) * DAY;
const label = (fromTs: number, toTs: number) => `${dayUtc(fromTs)} to ${dayUtc(toTs - 1)}`;

/** The last period of this cadence that ended at or before `nowTs`, and the `back`-th one before it (back = 1 is the previous). */
export function periodAt(nowTs: number, cadence: Cadence, back = 0): Period {
  if (cadence === "monthly") {
    const d = new Date(nowTs * 1000);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1) / 1000;
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back - 1, 1) / 1000;
    return { fromTs: start, toTs: end, label: label(start, end) };
  }
  const len = cadence === "daily" ? 1 : cadence === "weekly" ? 7 : Number(cadence.slice(0, -1));
  // Weeks end on a Monday 00:00 UTC (the epoch, 1970-01-01, was a Thursday: day 4 → Monday is day 0 of the week at +4 days offset).
  const dayNo = Math.floor(nowTs / DAY);
  const anchor = cadence === "weekly" ? dayNo - ((dayNo + 3) % 7) : dayNo;
  const end = (cadence === "weekly" || cadence === "daily" ? anchor : dayNo) * DAY - back * len * DAY;
  const start = end - len * DAY;
  return { fromTs: start, toTs: end, label: label(start, end) };
}

export const CRON: Record<string, string> = { daily: "0 1 * * *", weekly: "0 1 * * 1", monthly: "0 1 1 * *" };

// ---------- metrics ----------

export interface Metrics {
  period: string;
  fromBlock: string;
  toBlock: string;
  txs: number;
  transfersIn: number;
  transfersOut: number;
  swaps: number;
  approvals: number;
  contractCalls: number;
  failed: number;
  feesWei: string;
  counterparties: string[];
  /** Per token: plain transfers in and out, raw units. */
  tokens: Record<string, { symbol: string; decimals: number | null; inRaw: string; outRaw: string; ins: number; outs: number }>;
}

export function metricsOf(a: Activity, period: string): Metrics {
  const t = totalsOf(a.items);
  const tokens: Metrics["tokens"] = {};
  const put = (rows: TokenTotal[], key: "in" | "out") => {
    for (const r of rows) {
      const cur = (tokens[r.token.toLowerCase()] ??= { symbol: r.symbol, decimals: r.decimals ?? null, inRaw: "0", outRaw: "0", ins: 0, outs: 0 });
      if (key === "in") (cur.inRaw = (BigInt(cur.inRaw) + r.raw).toString(), (cur.ins += r.count));
      else (cur.outRaw = (BigInt(cur.outRaw) + r.raw).toString(), (cur.outs += r.count));
    }
  };
  put(t.inflow, "in");
  put(t.outflow, "out");
  return {
    period, fromBlock: a.range.fromBlock.toString(), toBlock: a.range.toBlock.toString(), txs: t.txs, transfersIn: t.counts["transfer-in"], transfersOut: t.counts["transfer-out"],
    swaps: t.counts.swap, approvals: t.counts.approval, contractCalls: t.counts["contract-call"], failed: t.failed, feesWei: t.feesWei.toString(),
    counterparties: [...counterparties(a.items)].sort(), tokens,
  };
}

const pct = (cur: number, prev: number) => (prev === 0 ? (cur === 0 ? "0%" : "new") : `${cur >= prev ? "+" : "-"}${Math.round((Math.abs(cur - prev) / prev) * 100)}%`);
const delta = (cur: number, prev: number) => `${cur - prev >= 0 ? "+" : ""}${cur - prev}`;

export interface CompareRow { metric: string; current: string; previous: string; change: string }

export function compare(cur: Metrics, prev: Metrics | undefined, symbol: string): CompareRow[] {
  const n = (label: string, c: number, p: number | undefined): CompareRow => ({ metric: label, current: String(c), previous: p === undefined ? "n/a" : String(p), change: p === undefined ? "n/a" : `${delta(c, p)} (${pct(c, p)})` });
  const rows = [
    n("Transactions", cur.txs, prev?.txs), n("Transfers in", cur.transfersIn, prev?.transfersIn), n("Transfers out", cur.transfersOut, prev?.transfersOut), n("Swaps", cur.swaps, prev?.swaps),
    n("Approvals", cur.approvals, prev?.approvals), n("Other contract calls", cur.contractCalls, prev?.contractCalls), n("Failed transactions", cur.failed, prev?.failed),
  ];
  const cf = BigInt(cur.feesWei), pf = prev ? BigInt(prev.feesWei) : undefined;
  rows.push({
    metric: `Fees paid (${symbol})`, current: fmtWei(cf, symbol).replace(` ${symbol}`, ""), previous: pf === undefined ? "n/a" : fmtWei(pf, symbol).replace(` ${symbol}`, ""),
    change: pf === undefined ? "n/a" : pf === 0n ? (cf === 0n ? "0%" : "new") : `${cf >= pf ? "+" : "-"}${Number(((cf > pf ? cf - pf : pf - cf) * 100n) / pf)}%`,
  });
  const newCp = prev ? cur.counterparties.filter((c) => !prev.counterparties.includes(c)).length : undefined;
  rows.push(n("Counterparties", cur.counterparties.length, prev?.counterparties.length));
  if (newCp !== undefined) rows.push({ metric: "New counterparties", current: String(newCp), previous: "—", change: "—" });
  return rows;
}

/** Per-token flow rows: how much came in and went out this period vs the last. */
export function tokenFlow(cur: Metrics, prev: Metrics | undefined): { token: string; symbol: string; inNow: string; outNow: string; inPrev: string; outPrev: string }[] {
  const fmt = (m: Metrics["tokens"][string] | undefined, key: "inRaw" | "outRaw") => (m ? fmtLeg({ token: "native", symbol: m.symbol, decimals: m.decimals ?? undefined, amountRaw: BigInt(m[key]) }) : "—");
  return Object.keys({ ...cur.tokens, ...(prev?.tokens ?? {}) }).map((k) => ({
    token: k, symbol: (cur.tokens[k] ?? prev?.tokens[k])!.symbol, inNow: fmt(cur.tokens[k], "inRaw"), outNow: fmt(cur.tokens[k], "outRaw"), inPrev: prev ? fmt(prev.tokens[k], "inRaw") : "n/a", outPrev: prev ? fmt(prev.tokens[k], "outRaw") : "n/a",
  }));
}

// ---------- the top three notable events ----------

export interface Notable { tx: string; kind: string; score: number; why: string }

const SCORE = { unlimited: 100, failed: 40, newCounterparty: 60, largestOut: 50, largestIn: 35, swap: 30 } as const;

/** The three events to read first. Fixed weights per kind, plus up to 30 points for the share of that token's period volume. Ties go to the earlier block. */
export function topEvents(a: Activity, prev?: Metrics, limit = 3): Notable[] {
  const known = prev ? new Set(prev.counterparties) : undefined;
  const volume = new Map<string, bigint>();
  for (const it of a.items) for (const l of [...it.out, ...it.in]) if (l.nft === undefined) volume.set(String(l.token).toLowerCase(), (volume.get(String(l.token).toLowerCase()) ?? 0n) + l.amountRaw);
  const share = (l: Leg) => {
    const v = volume.get(String(l.token).toLowerCase()) ?? 0n;
    return v === 0n ? 0 : Number((l.amountRaw * 30n) / v);
  };
  const cand: (Notable & { block: bigint })[] = [];
  const put = (it: Item, kind: string, score: number, why: string) => cand.push({ tx: it.tx, kind, score, why, block: it.block });
  const firstSeen = new Set<string>();
  for (const it of a.items) {
    const leg = (it.category === "transfer-out" ? it.out[0] : it.category === "transfer-in" ? it.in[0] : undefined);
    if (it.unlimited) put(it, "unlimited approval", SCORE.unlimited, `Unlimited approval: ${it.counterparty} can move ${it.out.map(fmtLeg).join(", ")}`);
    if (it.status === "reverted") put(it, "failed transaction", SCORE.failed, `A ${it.method ?? it.category} transaction failed (reverted)`);
    const cp = it.counterparty?.toLowerCase();
    if (known && cp && !known.has(cp) && !firstSeen.has(cp)) {
      firstSeen.add(cp);
      put(it, "new counterparty", SCORE.newCounterparty + (leg ? share(leg) : 0), `First time dealing with ${it.counterparty}${leg ? ` (${it.category === "transfer-in" ? "received" : "sent"} ${fmtLeg(leg)})` : ` (${it.method ?? it.category})`}`);
    }
    if (it.category === "transfer-out" && leg && leg.nft === undefined) put(it, "large outflow", SCORE.largestOut + share(leg), `Sent ${fmtLeg(leg)} to ${it.counterparty}`);
    if (it.category === "transfer-in" && leg && leg.nft === undefined) put(it, "large inflow", SCORE.largestIn + share(leg), `Received ${fmtLeg(leg)} from ${it.counterparty}`);
    if (it.category === "swap") put(it, "swap", SCORE.swap + (it.out[0] ? share(it.out[0]) : 0), `Swapped ${it.out.map(fmtLeg).join(" + ")} for ${it.in.map(fmtLeg).join(" + ")}`);
  }
  // One entry per transaction (its best-scoring reading), then the top N.
  const best = new Map<string, Notable & { block: bigint }>();
  for (const c of cand) if (!best.has(c.tx) || best.get(c.tx)!.score < c.score) best.set(c.tx, c);
  return [...best.values()].sort((x, y) => y.score - x.score || (x.block < y.block ? -1 : 1)).slice(0, limit).map(({ block: _b, ...n }) => n);
}

// ---------- the digest text ----------

export interface DigestInput {
  activity: Activity;
  metrics: Metrics;
  previous?: Metrics;
  period: Period;
  cadence: Cadence;
  generatedAt: string;
  events: Notable[];
}

const row = (cells: string[]) => `| ${cells.join(" | ")} |`;

export function digestMarkdown(d: DigestInput): string {
  const a = d.activity;
  const net = a.network === "pharos" ? "Pharos mainnet" : "Pharos Atlantic testnet";
  const sym = a.nativeSymbol;
  const L: string[] = [];
  L.push(`# ${d.cadence[0]!.toUpperCase()}${d.cadence.slice(1)} digest: \`${a.wallet}\``, "", `${net} · ${d.period.label} (UTC) · blocks ${d.metrics.fromBlock}–${d.metrics.toBlock} · generated ${d.generatedAt}`, "");
  const m = d.metrics;
  L.push("## What changed", "");
  if (m.txs === 0) L.push(`No activity this period that the digest can see${d.previous ? `, against ${d.previous.txs} transaction${d.previous.txs === 1 ? "" : "s"} in the one before` : ""}.`, "");
  else {
    const cmp = d.previous ? `, ${m.txs === d.previous.txs ? "the same as" : m.txs > d.previous.txs ? "up from" : "down from"} ${d.previous.txs} the period before` : " (no earlier period to compare with)";
    L.push(`${m.txs} transaction${m.txs === 1 ? "" : "s"} this period${cmp}: ${m.transfersIn} transfer${m.transfersIn === 1 ? "" : "s"} in, ${m.transfersOut} out, ${m.swaps} swap${m.swaps === 1 ? "" : "s"}, ${m.approvals} approval${m.approvals === 1 ? "" : "s"}, ${m.contractCalls} other contract call${m.contractCalls === 1 ? "" : "s"}.`, "");
  }
  L.push("## Key numbers", "", row(["Metric", "This period", "Previous period", "Change"]), "|---|---|---|---|", ...compare(m, d.previous, sym).map((r) => row([r.metric, r.current, r.previous, r.change])), "");
  const flow = tokenFlow(m, d.previous);
  if (flow.length) L.push("### Token flow", "", row(["Token", "In", "Out", "In (previous)", "Out (previous)"]), "|---|---|---|---|---|", ...flow.map((f) => row([f.symbol, f.inNow, f.outNow, f.inPrev, f.outPrev])), "");
  L.push("## Top 3 notable events", "");
  if (d.events.length === 0) L.push("_None: no activity to rank._", "");
  else L.push(...d.events.map((e, i) => `${i + 1}. **${e.kind}:** ${e.why}. [${e.tx.slice(0, 10)}…](${explorerTx(a.network, e.tx)})`), "");
  if (d.previous) {
    const fresh = m.counterparties.filter((c) => !d.previous!.counterparties.includes(c));
    const gone = d.previous.counterparties.filter((c) => !m.counterparties.includes(c));
    L.push("## Who is new", "", fresh.length ? `New this period (${fresh.length}): ${fresh.slice(0, 8).map((c) => `\`${c}\``).join(", ")}${fresh.length > 8 ? `, and ${fresh.length - 8} more` : ""}.` : "No new counterparties.", gone.length ? `Seen last period but not this one: ${gone.length}.` : "", "");
  }
  const c = a.coverage;
  L.push("## Coverage", "", `${c.logsRead} matching event logs over ${c.logWindows} \`get_logs\` windows; ${c.sentExpected === null ? "the chain's nonce for the range could not be read" : `outgoing transactions found ${c.sentFound} of ${c.sentExpected} by the chain's nonce`}; block scan ${c.blockScan.mode}${c.blockScan.mode === "off" ? "" : ` (${c.blockScan.scanned} of ${c.blockScan.of} blocks)`}. Token amounts are units, not money.`, "");
  return L.join("\n");
}

/** A short version for a chat message (Discord allows 2,000 characters). */
export function digestChat(d: DigestInput): string {
  const m = d.metrics;
  const p = d.previous;
  const sym = d.activity.nativeSymbol;
  const lines = [
    `**${d.cadence} digest** · \`${d.activity.wallet.slice(0, 6)}…${d.activity.wallet.slice(-4)}\` · ${d.period.label} UTC`,
    `Transactions: ${m.txs}${p ? ` (was ${p.txs}, ${pct(m.txs, p.txs)})` : ""} · in ${m.transfersIn} · out ${m.transfersOut} · swaps ${m.swaps} · approvals ${m.approvals} · fees ${fmtWei(BigInt(m.feesWei), sym)}`,
    ...(p ? [`New counterparties: ${m.counterparties.filter((c) => !p.counterparties.includes(c)).length}`] : []),
    "Top events:",
    ...(d.events.length ? d.events.map((e, i) => `${i + 1}. ${e.kind}: ${e.why} <${explorerTx(d.activity.network, e.tx)}>`) : ["none"]),
  ];
  let text = lines.join("\n");
  if (text.length > 1900) text = `${text.slice(0, 1890)}…`;
  return text;
}
