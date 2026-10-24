import { explorerTx } from "../lib/networks.js";
import { counterparties, dayUtc, fmtLeg, fmtWei, stampUtc, totalsOf, type Activity, type Item, type Leg, type TokenTotal } from "./engine.js";

// The plain-language report for one wallet and one period, as Markdown or CSV. Everything it says comes from the Activity the engine
// read; nothing is estimated. Highlights compare with a baseline period (the same length, right before) when one is given.

const lower = (s: string) => s.toLowerCase();
const short = (a: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "(contract creation)");
const link = (a: Activity, tx: string) => `[${tx.slice(0, 10)}…](${explorerTx(a.network, tx)})`;
const sum = (rows: TokenTotal[]) => rows.map((r) => `${fmtLeg({ token: r.token as `0x${string}`, symbol: r.symbol, decimals: r.decimals, amountRaw: r.raw })} (${r.count})`).join(", ") || "none";
const legs = (ls: Leg[]) => ls.map(fmtLeg).join(" + ") || "—";
/** An allowance, with "unlimited" instead of a 78-digit number when the approval has no cap. */
const allowance = (it: Item) => (it.unlimited ? `${it.out[0]!.symbol} (unlimited)` : legs(it.out));
const addrLink = (a: Activity, addr: string | null) => (addr ? `\`${short(addr)}\`` : "(contract creation)");
const whenOf = (it: Item) => stampUtc(it.timestamp).replace("T", " ").replace("Z", " UTC");

export interface Highlight {
  kind: "first-time-counterparty" | "largest-outflow" | "unlimited-approval";
  tx: string;
  text: string;
}

/** Items that would be read first: first-time counterparties, the largest outflow per token, every unlimited approval. */
export function highlights(a: Activity, baseline?: Activity): Highlight[] {
  const out: Highlight[] = [];
  const known = baseline ? counterparties(baseline.items) : undefined;
  const firstSeen = new Map<string, Item>();
  for (const it of a.items) if (it.counterparty && !firstSeen.has(lower(it.counterparty))) firstSeen.set(lower(it.counterparty), it);
  if (known) {
    for (const [addr, it] of firstSeen) {
      if (known.has(addr) || it.category === "contract-call" && it.counterparty === null) continue;
      const what = it.category === "approval" ? `approved ${legs(it.out)} to it` : it.category === "swap" ? `swapped ${legs(it.out)} for ${legs(it.in)} through it` : it.category === "contract-call" ? `called it (${it.method})` : it.category === "transfer-in" ? `received ${legs(it.in)} from it` : `sent it ${legs(it.out)}`;
      out.push({ kind: "first-time-counterparty", tx: it.tx, text: `First time dealing with \`${it.counterparty}\` (not seen in the previous period): ${what}.` });
    }
  }
  const best = new Map<string, { it: Item; leg: Leg }>();
  for (const it of a.items) {
    if (it.category !== "transfer-out" || it.status !== "success") continue;
    for (const l of it.out) {
      const k = String(l.token).toLowerCase();
      if (l.nft === undefined && (!best.has(k) || l.amountRaw > best.get(k)!.leg.amountRaw)) best.set(k, { it, leg: l });
    }
  }
  // Raw units of different tokens are not comparable, so the tokens are ordered by how often they went out.
  const sent = new Map<string, number>();
  for (const it of a.items) if (it.category === "transfer-out") for (const l of it.out) sent.set(String(l.token).toLowerCase(), (sent.get(String(l.token).toLowerCase()) ?? 0) + 1);
  const outs = [...best.entries()].sort((x, y) => (sent.get(y[0]) ?? 0) - (sent.get(x[0]) ?? 0)).map(([, v]) => v);
  for (const { it, leg } of outs.slice(0, 3)) out.push({ kind: "largest-outflow", tx: it.tx, text: `Largest ${leg.symbol} sent out: ${fmtLeg(leg)} to \`${it.counterparty}\`.` });
  for (const it of a.items) if (it.category === "approval" && it.unlimited) out.push({ kind: "unlimited-approval", tx: it.tx, text: `Unlimited approval: \`${it.counterparty}\` can move ${it.out[0]!.symbol} without a cap.` });
  return out;
}

function table(head: string[], rows: string[][]): string {
  if (!rows.length) return "_None in this period._\n";
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n") + "\n";
}

export interface ReportInfo {
  generatedAt: string;
  baseline?: Activity;
}

export function markdownReport(a: Activity, info: ReportInfo): string {
  const t = totalsOf(a.items);
  const hl = highlights(a, info.baseline);
  const by = (c: Item["category"]) => a.items.filter((i) => i.category === c);
  const cov = a.coverage;
  const days = a.range.fromTs !== undefined && a.range.toTs !== undefined ? `${stampUtc(a.range.fromTs)} to ${stampUtc(a.range.toTs)}` : "the given blocks";
  const netName = a.network === "pharos" ? "Pharos mainnet" : "Pharos Atlantic testnet";
  const L: string[] = [];
  L.push(`# Wallet activity report: \`${a.wallet}\``, "", `${netName} · ${days} · blocks ${a.range.fromBlock}–${a.range.toBlock} · generated ${info.generatedAt} · read-only through the Pharos Chain MCP`, "");

  L.push("## In plain words", "");
  if (a.items.length === 0) {
    L.push(`In this period the wallet had no activity that this report can see (${cov.logsRead} matching event logs). Read the coverage section before concluding it was idle.`, "");
  } else {
    const parts = [
      `${t.txs} transaction${t.txs === 1 ? "" : "s"} touched this wallet`,
      `it received tokens ${t.counts["transfer-in"]} time${t.counts["transfer-in"] === 1 ? "" : "s"} and sent them ${t.counts["transfer-out"]} time${t.counts["transfer-out"] === 1 ? "" : "s"}`,
      `made ${t.counts.swap} swap${t.counts.swap === 1 ? "" : "s"}`,
      `granted ${t.counts.approval} approval${t.counts.approval === 1 ? "" : "s"}${t.unlimitedApprovals ? ` (${t.unlimitedApprovals} unlimited)` : ""}`,
      `and made ${t.counts["contract-call"]} other contract call${t.counts["contract-call"] === 1 ? "" : "s"}`,
    ];
    L.push(`${parts.join("; ")}. Fees it paid for the transactions it sent: ${fmtWei(t.feesWei, a.nativeSymbol)}${t.failed ? `; ${t.failed} transaction${t.failed === 1 ? "" : "s"} failed (reverted)` : ""}.`, "");
  }

  L.push("## Highlights", "");
  if (!info.baseline) L.push("_First-time counterparties are not checked: no earlier period was read (`--baseline none`)._", "");
  if (hl.length === 0) L.push("_Nothing stands out: no first-time counterparty, no outflow, no unlimited approval._", "");
  else L.push(...hl.map((h) => `- **${h.kind.replace(/-/g, " ")}:** ${h.text} ${link(a, h.tx)}`), "");

  L.push("## Totals by category", "");
  L.push(table(["Category", "Transactions", "Amounts"], [
    ["Transfers in", String(t.counts["transfer-in"]), sum(t.inflow)],
    ["Transfers out", String(t.counts["transfer-out"]), sum(t.outflow)],
    ["Swaps", String(t.counts.swap), `gave ${sum(t.swapsOut)}; got ${sum(t.swapsIn)}`],
    ["Approvals", String(t.counts.approval), t.unlimitedApprovals ? `${t.unlimitedApprovals} unlimited` : "none unlimited"],
    ["Contract interactions", String(t.counts["contract-call"]), "—"],
  ]));
  L.push(`Fees paid: ${fmtWei(t.feesWei, a.nativeSymbol)} across the transactions this wallet sent. Counts are items found; one transaction can hold several.`, "");

  const row = (it: Item, cols: string[]) => [whenOf(it), ...cols, link(a, it.tx), it.status === "reverted" ? "reverted" : "ok"];
  L.push("## Transfers in", "", table(["When", "Amount", "From", "Tx", "Status"], by("transfer-in").map((i) => row(i, [legs(i.in), addrLink(a, i.counterparty)]))));
  L.push("## Transfers out", "", table(["When", "Amount", "To", "Tx", "Status"], by("transfer-out").map((i) => row(i, [legs(i.out), addrLink(a, i.counterparty)]))));
  L.push("## Swaps", "", table(["When", "Gave", "Got", "Via", "Tx", "Status"], by("swap").map((i) => row(i, [legs(i.out), legs(i.in), addrLink(a, i.counterparty)]))));
  L.push("## Approvals", "", table(["When", "Allowance", "Spender", "Tx", "Status"], by("approval").map((i) => row(i, [allowance(i), addrLink(a, i.counterparty)]))));
  L.push("## Contract interactions", "", table(["When", "Call", "Contract", "Tx", "Status"], by("contract-call").map((i) => row(i, [i.method ?? "call", addrLink(a, i.counterparty)]))));

  const notable = notableTxs(a);
  L.push("## Notable transactions", "", notable.length ? notable.map((n) => `- ${n.why}: ${link(a, n.tx)}`).join("\n") + "\n" : "_None._\n");

  L.push("## What this report can and cannot see", "");
  L.push(`- Events: ${cov.logsRead} matching logs over ${cov.logWindows} \`get_logs\` windows (the wallet as the first or second indexed argument of Transfer / Approval / Swap-style events).`);
  L.push(`- Block scan for plain ${a.nativeSymbol} transfers and calls that emit no event: ${cov.blockScan.mode === "off" ? "off (use `--scan-blocks N`)" : `${cov.blockScan.mode}, ${cov.blockScan.scanned} of ${cov.blockScan.of} blocks`}.`);
  L.push(cov.sentExpected === null ? "- Outgoing transactions: the chain's nonce for this range could not be read." : `- Outgoing transactions found: ${cov.sentFound} of ${cov.sentExpected} the chain's nonce counts for this range${cov.sentFound < cov.sentExpected ? ` — ${cov.sentExpected - cov.sentFound} sent without an event the report could match (raise \`--scan-blocks\` to look for them)` : ""}.`);
  if (cov.skipped) L.push(`- ${cov.skipped} transaction(s) were found but not read because of the cap (\`--max-txs\`).`);
  L.push("- Swaps are recognised from Swap events or from the wallet giving one token and getting another in one transaction; native-token movement inside contract calls (internal transfers) is not visible to the Chain MCP.");
  L.push("- No prices: amounts are in token units, never converted to money.", "");
  return L.join("\n");
}

/** Up to five transactions worth opening first, each with the reason in one phrase. */
export function notableTxs(a: Activity): { tx: string; why: string }[] {
  const res: { tx: string; why: string }[] = [];
  const add = (tx: string, why: string) => res.some((r) => r.tx === tx) || res.push({ tx, why });
  for (const it of a.items) if (it.status === "reverted") add(it.tx, `reverted ${it.method ?? it.category}`);
  for (const it of a.items) if (it.unlimited) add(it.tx, `unlimited approval to ${short(it.counterparty)}`);
  // Largest = the biggest share of that token's total outflow in the period (raw units are not comparable across tokens).
  const total = new Map<string, bigint>();
  const outsAll = a.items.filter((i) => i.category === "transfer-out" && i.out[0]!.nft === undefined);
  for (const i of outsAll) total.set(String(i.out[0]!.token).toLowerCase(), (total.get(String(i.out[0]!.token).toLowerCase()) ?? 0n) + i.out[0]!.amountRaw);
  const share = (i: Item) => Number((i.out[0]!.amountRaw * 10_000n) / (total.get(String(i.out[0]!.token).toLowerCase()) || 1n));
  const big = [...outsAll].sort((x, y) => share(y) - share(x));
  for (const it of big.slice(0, 2)) add(it.tx, `large ${it.out[0]!.symbol} transfer out (${fmtLeg(it.out[0]!)})`);
  for (const it of a.items.filter((i) => i.category === "swap").slice(0, 2)) add(it.tx, `swap ${legs(it.out)} for ${legs(it.in)}`);
  return res.slice(0, 5);
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export function csvReport(a: Activity): string {
  const head = ["time_utc", "block", "category", "status", "counterparty", "gave", "got", "method", "fee_native", "tx", "link"];
  const rows = a.items.map((i) =>
    [stampUtc(i.timestamp), String(i.block), i.category, i.status, i.counterparty ?? "", i.category === "transfer-in" ? "" : legs(i.out), i.category === "transfer-in" ? legs(i.in) : i.category === "swap" ? legs(i.in) : "", i.method ?? "", i.feeWei ? fmtWei(i.feeWei, a.nativeSymbol) : "", i.tx, explorerTx(a.network, i.tx)].map(csvCell).join(","),
  );
  return [head.join(","), ...rows].join("\n") + "\n";
}

export { dayUtc };
