import { fmtDays, pct, rateView, usd, type Evaluation, type RateView } from "./model.js";
import type { Report } from "./run.js";

/** A report as plain JSON (bigints as strings), for the proof file. */
export const toJson = (r: unknown): unknown => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usdc = (raw: bigint, dec: number) => (Number(raw) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: 6 });

function rateRow(name: string, v: RateView, labels: string[], flag: string, w: number): string {
  const cols = labels.map((l) => padL(pct(v.windows.find((x) => x.label === l)?.apr ?? null), 9));
  return `  ${pad(name, w)}${cols.join("")}${padL(pct(v.ref), 9)}${padL(pct(v.pessimistic), 14)}  ${flag}`;
}

export function renderReport(r: Report, dec = 6): string[] {
  const L: string[] = [];
  const labels = r.windows.map((w) => w.label);
  const chain = r.network === "pharos" ? "Pharos mainnet (chain 1672)" : "Pharos Atlantic testnet (chain 688689)";
  L.push(`${chain}, block ${r.block} (${r.secondsPerBlock.toFixed(3)} s/block) · wallet ${r.wallet}`);
  L.push(`Holds: ${r.held.source.name} worth ${usdc(r.held.holding.assets, dec)} USDC${r.held.others.length ? ` (also: ${r.held.others.map((o) => `${o.source.name} ${usdc(o.assets, dec)}`).join(", ")}; the largest is evaluated)` : ""}`);
  L.push(`Rules: hold at least ${fmtDays(r.params.holdDays)} after a move · net gain at least ${usd(r.params.minNetUsd)} · destination credited its median rate minus ${r.params.haircut} × the spread of its windows (the held position: plus) · windows ${labels.join(" / ")} · gas ${r.gas.priceWei} wei × native price ${r.gas.nativeUsd.toFixed(6)} USD (${r.gas.nativeBasis})`);
  L.push("");
  L.push("Yield sources, measured as share-price growth over each window, annualised (APR, simple):");
  const w = Math.max(...r.readings.map((x) => x.source.name.length), 10) + 2;
  L.push(`  ${pad("source", w)}${labels.map((l) => padL(l, 9)).join("")}${padL("median", 9)}${padL("conservative", 14)}  notes`);
  const viewOf = (key: string): RateView => (key === r.held.source.key ? r.heldView.rate : r.targets.find((t) => t.key === key)!.rate);
  const ranked = [...r.readings].sort((a, b) => (viewOf(b.source.key).pessimistic ?? -Infinity) - (viewOf(a.source.key).pessimistic ?? -Infinity));
  for (const x of ranked) {
    const v = viewOf(x.source.key);
    const flags = [x.source.key === r.held.source.key ? "HELD" : "", v.jumpy ? `JUMPY (spread ${pct(v.spread)}: ranked down)` : "", v.thin ? "thin history" : "", x.tvl !== null ? `TVL ${usdc(x.tvl, dec)}` : ""].filter(Boolean).join(" · ");
    L.push(rateRow(x.source.name, v, labels, flags, w));
  }
  for (const u of r.unreadable) L.push(`  ${pad(u.source.name, w)} UNREADABLE: ${u.reason}`);
  for (const h of r.holdingErrors) L.push(`  ${pad(h.source.name, w)} BALANCE UNREADABLE: ${h.reason}`);
  for (const x of r.readings) for (const win of x.windows) if (win.apr === null && win.reason) L.push(`  (${x.source.name}, ${win.label}: ${win.reason})`);
  if (r.skipped.length) L.push(`  (left out: ${r.skipped.join("; ")})`);
  L.push("");
  const dest = r.readings.filter((x) => x.source.key !== r.held.source.key);
  L.push("Entry / exit, read from the contracts:");
  const h = r.readings.find((x) => x.source.key === r.held.source.key)!;
  L.push(`  exit ${r.held.source.name}: ${h.exit.note}${h.exit.blockers.length ? ` → BLOCKED: ${h.exit.blockers.join("; ")}` : " → open"}`);
  for (const x of dest) L.push(`  entry ${x.source.name}: ${x.entry.note}${x.lockSeconds ? `; lock-in ${fmtDays(x.lockSeconds / 86_400)}` : ""}${x.entry.blockers.length ? ` → BLOCKED: ${x.entry.blockers.join("; ")}` : " → no blocker found (read-only check: the deposit itself is only simulated once the wallet has approved it)"}`);
  L.push("");
  L.push(`Moving ${usd(r.heldView.usd)} out of ${r.heldView.name} (credited at its optimistic ${pct(r.heldView.rate.optimistic)}; destinations at their conservative rate):`);
  for (const e of r.recommendation.evaluations) L.push(...renderEvaluation(e, r));
  L.push("");
  L.push(`RECOMMENDATION: ${r.recommendation.decision === "MOVE" ? "MOVE" : "STAY PUT"}: ${r.recommendation.reason}`);
  if (r.plan) {
    L.push(`Prepared for the wallet owner's signature (nothing signed, no key read), plan ${short(r.plan.planId)}:`);
    for (const t of r.plan.transactions) L.push(`  ${t.step}. ${t.description} · to ${short(t.request.to)} · gas ${t.gas.units} (${t.gas.basis})`);
  } else if (r.planNote) L.push(r.planNote + ".");
  return L;
}

function renderEvaluation(e: Evaluation, r: Report): string[] {
  const t = r.targets.find((x) => x.key === e.key)!;
  const head = `  → ${e.name}: `;
  if (e.netUsd === null) return [`${head}cannot be valued${e.entryBlockers.length ? ` (${e.entryBlockers.join("; ")})` : ""}`];
  const L = [
    `${head}${pct(e.rateGap)} better${e.rateGap! <= 0 ? " (not better)" : ""} · over ${fmtDays(e.horizonDays)}: gross ${usd(e.grossUsd!)} − costs ${usd(e.costUsd!)} (gas ${usd(e.gasUsd)} [${t.gasUnits} units: ${t.gasBasis}], exit fee ${usd(e.exitFeeUsd!)}, entry fee ${usd(e.entryFeeUsd!)}) = net ${usd(e.netUsd)} at conservative rates, ${usd(e.netAtMedianUsd!)} at median rates · break-even ${e.breakEvenDays === null ? "never" : fmtDays(e.breakEvenDays)} · ${e.verdict === "move" ? "WORTH IT" : "not worth it"}`,
  ];
  for (const b of e.entryBlockers) L.push(`      blocker (entry): ${b}`);
  for (const b of e.notes) L.push(`      note: ${b}`);
  return L;
}
