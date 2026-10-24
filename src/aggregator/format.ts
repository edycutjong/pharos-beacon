import { pct, usd } from "../yield/model.js";
import type { Report } from "./run.js";

/** A report as plain JSON (bigints as strings), for the proof file. */
export const toJson = (r: unknown): unknown => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const amount = (raw: bigint, dec: number) => (Number(raw) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: 6 });

export function renderReport(r: Report, dec = 6): string[] {
  const L: string[] = [];
  const labels = r.windows.map((w) => w.label);
  const chain = r.network === "pharos" ? "Pharos mainnet (chain 1672)" : "Pharos Atlantic testnet (chain 688689)";
  L.push(`${chain}, block ${r.block} (${r.secondsPerBlock.toFixed(3)} s/block) · wallet ${r.wallet}`);
  const req = r.request;
  const ask = req.kind === "deposit" ? `deposit ${amount(req.assets, dec)} USDC` : req.kind === "withdraw" ? `withdraw ${req.assets === "all" ? "everything" : `${amount(req.assets, dec)} USDC`}` : req.kind;
  L.push(`Request: ${ask} · horizon ${r.holdDays} d · rates are share-price growth over ${labels.join(" / ")}, annualised (APR, simple), median of the windows, "conservative" = median − ${r.haircut} × spread · gas ${r.gas.priceWei} wei × ${r.gas.nativeUsd.toFixed(6)} USD per native token (${r.gas.nativeBasis})`);
  L.push("");

  // ---- protocols: who answered
  L.push("Protocols behind the one interface:");
  const protocols = [...new Set(r.venues.map((v) => v.protocol))];
  for (const p of protocols) {
    const vs = r.venues.filter((v) => v.protocol === p);
    const downs = r.down.filter((d) => d.venue.protocol === p);
    const name = vs[0]!.protocolName;
    const state = downs.length === 0 ? "UP" : downs.length === vs.length ? (downs.every((d) => d.simulated) ? "DOWN (simulated outage drill)" : "DOWN") : "PARTLY UP";
    L.push(`  ${pad(name, 14)} ${state} · ${vs.length - downs.length} of ${vs.length} venue${vs.length === 1 ? "" : "s"} answered`);
    for (const d of downs) L.push(`      ${d.simulated ? "SIMULATED " : ""}unavailable: ${d.venue.name}: ${d.reason}`);
  }
  L.push("");

  // ---- rates
  L.push("Rates and entry / exit, read from the contracts:");
  const w = Math.max(...r.views.map((x) => x.venue.name.length), 10) + 2;
  L.push(`  ${pad("venue", w)}${labels.map((l) => padL(l, 9)).join("")}${padL("median", 9)}${padL("conservative", 14)}  notes`);
  const ranked = [...r.views].sort((a, b) => (b.rate.pessimistic ?? -Infinity) - (a.rate.pessimistic ?? -Infinity));
  for (const x of ranked) {
    const cols = labels.map((l) => padL(pct(x.rate.windows.find((q) => q.label === l)?.apr ?? null), 9));
    const flags = [x.rate.jumpy ? `JUMPY (spread ${pct(x.rate.spread)})` : "", x.rate.thin ? "thin history" : "", x.reading.tvl !== null ? `TVL ${amount(x.reading.tvl, dec)}` : "", x.holding ? `YOU HOLD ${amount(x.holding.assets, dec)}` : ""].filter(Boolean).join(" · ");
    L.push(`  ${pad(x.venue.name, w)}${cols.join("")}${padL(pct(x.rate.ref), 9)}${padL(pct(x.rate.pessimistic), 14)}  ${flags}`);
  }
  for (const d of r.down) L.push(`  ${pad(d.venue.name, w)} ${d.simulated ? "SIMULATED OUTAGE" : "UNAVAILABLE"}: ${d.reason}`);
  for (const x of r.views) {
    const e = x.reading.entry;
    const t = x.reading.exit;
    L.push(`  ${x.venue.name}: entry ${e.blockers.length ? `BLOCKED (${e.blockers.join("; ")})` : `open, fee ${e.feeBps ?? "n/a"} bps`} · exit ${x.holding ? (t.blockers.length ? `BLOCKED (${t.blockers.join("; ")})` : `open, fee ${t.feeBps ?? "n/a"} bps`) : "n/a (no position)"}`);
  }
  if (r.skipped.length) L.push(`  (left out: ${r.skipped.join("; ")})`);
  L.push("");

  // ---- positions
  const held = r.views.filter((x) => x.holding);
  L.push(held.length ? "Positions of the wallet:" : "Positions of the wallet: none in the venues that answered.");
  for (const x of held) L.push(`  ${x.venue.name} (${x.venue.protocolName}): ${amount(x.holding!.assets, dec)} USDC · ${amount(x.holding!.shares, x.reading.basis.shareDecimals)} shares`);
  if (r.down.length) L.push(`  (positions in ${[...new Set(r.down.map((d) => d.venue.protocolName))].join(", ")} are UNKNOWN: ${r.down.length === 1 ? "that venue" : "those venues"} did not answer)`);

  // ---- route
  if (r.route) {
    L.push("");
    L.push(`ROUTE (${r.route.request}):`);
    for (const e of r.route.explanation) L.push(`  ${e}`);
    if (r.route.allocations.length) L.push(`  → ${r.route.allocations.map((a) => `${usd(a.usd)} ${r.route!.request === "deposit" ? "to" : "from"} ${r.views.find((v) => v.venue.id === a.venueId)!.venue.name}`).join(" + ")}`);
  }
  if (r.funded) L.push(r.funded.assumed ? `Funding: the wallet holds ${amount(r.funded.balance, dec)} USDC, less than the deposit; the plan is prepared on --assume-funded and reverts until it is funded.` : `Funding: the wallet holds ${amount(r.funded.balance, dec)} USDC, enough for the deposit.`);
  if (r.plan) {
    L.push("");
    L.push(`Prepared for the wallet owner's signature (nothing signed, no key read), plan ${short(r.plan.planId)}, wallet-side calldata check passed:`);
    for (const t of r.plan.transactions) L.push(`  ${t.step}. ${t.description} · to ${short(t.request.to)} · gas ${t.gas.units} (${t.gas.basis})`);
  }
  if (r.planNote) L.push(r.planNote + ".");
  return L;
}
