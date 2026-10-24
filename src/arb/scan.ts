import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Market, Venue } from "./venues.js";

// One scan = read two sources, price every candidate round trip (buy the base on one, sell it on the other) at several sizes,
// take costs off the gross spread and decide. The decision is deterministic code over quotes that came from the chain.

export interface ScanConfig {
  /** Amounts of the quote token (raw units) to start each round trip with. */
  sizes: bigint[];
  /** Act only when net profit (raw quote units) is at least this. */
  minProfit: bigint;
  /** Extra allowance for the price moving between the scan and inclusion, in bps of the amount traded. */
  slippageBps: number;
  /** Gas for the whole two-leg round trip (an estimate for read-only mainnet; measured from receipts on Atlantic). */
  gasUnits: bigint;
  gasPriceWei: bigint;
}

export interface Candidate {
  buyOn: string;
  sellOn: string;
  /** Quote amount the round trip starts with (raw). */
  amountIn: bigint;
  baseBought: bigint;
  quoteBack: bigint;
  /** Gross spread at the two mid prices, in bps and in quote raw units. */
  grossBps: number;
  gross: bigint;
  /** Nominal swap fees of both legs. */
  fees: bigint;
  /** Price impact + rounding: what is left of the gross spread after fees and before the net result of the real quotes. */
  impact: bigint;
  slippageBuffer: bigint;
  gas: bigint;
  net: bigint;
  refused?: string;
}

export interface ScanRecord {
  at: string;
  network: string;
  block: string;
  market: { base: string; quote: string };
  sources: { id: string; kind: string; address: string; mid: number; feeBps: number }[];
  config: { sizes: string[]; minProfit: string; slippageBps: number; gasUnits: string; gasPriceGwei: string };
  candidates: Candidate[];
  best: Candidate | null;
  decision: "ACT" | "SKIP";
  reason: string;
}

export const fmtUnits = (v: bigint, decimals: number, places = 6): string => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = a.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).padEnd(places, "0").slice(0, places);
  return `${neg ? "-" : ""}${whole}.${frac}`;
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Gas cost in raw quote units, pricing the native token at `nativeQuotePrice` quote per native (WPROS ≈ PROS 1:1). */
export function gasCost(cfg: Pick<ScanConfig, "gasUnits" | "gasPriceWei">, nativeQuotePrice: number, quoteDecimals: number): bigint {
  const native = Number(cfg.gasUnits * cfg.gasPriceWei) / 1e18;
  return BigInt(Math.ceil(native * nativeQuotePrice * 10 ** quoteDecimals));
}

export async function priceRoute(buy: Venue, sell: Venue, amountIn: bigint, m: Market, cfg: ScanConfig): Promise<Candidate> {
  const base = { buyOn: buy.id, sellOn: sell.id, amountIn, baseBought: 0n, quoteBack: 0n, grossBps: ((sell.mid / buy.mid) - 1) * 1e4, gross: 0n, fees: 0n, impact: 0n, slippageBuffer: 0n, gas: 0n, net: 0n };
  const q1 = await buy.quote("quote-in", amountIn);
  if ("refused" in q1) return { ...base, refused: `${buy.id}: ${q1.refused}` };
  const q2 = await sell.quote("base-in", q1.out);
  if ("refused" in q2) return { ...base, baseBought: q1.out, refused: `${sell.id}: ${q2.refused}` };
  const gross = BigInt(Math.round(Number(amountIn) * (sell.mid / buy.mid - 1)));
  const f2 = q2.feeBps / 1e4;
  const fees = BigInt(Math.round((Number(amountIn) * q1.feeBps) / 1e4 + (Number(q2.out) * f2) / (1 - f2)));
  const before = q2.out - amountIn;
  const impact = gross - fees - before;
  const slippageBuffer = ceilDiv(amountIn * BigInt(Math.round(cfg.slippageBps * 100)), 1_000_000n);
  const gas = gasCost(cfg, sell.mid, m.quote.decimals);
  return { ...base, baseBought: q1.out, quoteBack: q2.out, gross, fees, impact, slippageBuffer, gas, net: before - slippageBuffer - gas };
}

/** Every candidate: both directions, every size. */
export async function scanVenues(venues: [Venue, Venue], m: Market, cfg: ScanConfig): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const [buy, sell] of [[venues[0], venues[1]], [venues[1], venues[0]]] as const) {
    for (const size of cfg.sizes) out.push(await priceRoute(buy, sell, size, m, cfg));
  }
  return out;
}

export function decide(candidates: Candidate[], cfg: ScanConfig, m: Market): { best: Candidate | null; decision: "ACT" | "SKIP"; reason: string } {
  const d = m.quote.decimals;
  const q = (v: bigint) => `${fmtUnits(v, d)} ${m.quote.symbol}`;
  const ok = candidates.filter((c) => !c.refused);
  if (ok.length === 0) return { best: null, decision: "SKIP", reason: `no route could be quoted (${candidates[0]?.refused ?? "no candidates"})` };
  const best = ok.reduce((a, b) => (b.net > a.net ? b : a));
  const costs = best.fees + best.impact + best.slippageBuffer + best.gas;
  const sketch = `best round trip ${best.buyOn} → ${best.sellOn} starting with ${q(best.amountIn)}: gross ${best.grossBps >= 0 ? "+" : ""}${best.grossBps.toFixed(1)} bps (${q(best.gross)}), costs ${q(costs)} (fees ${q(best.fees)} + impact ${q(best.impact)} + slippage buffer ${q(best.slippageBuffer)} + gas ${q(best.gas)}) → net ${q(best.net)}`;
  if (best.net >= cfg.minProfit && best.net > 0n && best.gross > 0n) return { best, decision: "ACT", reason: `${sketch} ≥ the ${q(cfg.minProfit)} threshold` };
  if (best.gross <= 0n) return { best, decision: "SKIP", reason: `no positive gross spread in either direction: ${sketch}` };
  if (best.net > 0n) return { best, decision: "SKIP", reason: `${sketch} < the ${q(cfg.minProfit)} threshold: the spread survives its costs, but the profit is under the threshold` };
  return { best, decision: "SKIP", reason: `${sketch} < the ${q(cfg.minProfit)} threshold: the spread does not survive its costs` };
}

export function makeRecord(o: { network: string; block: bigint; m: Market; venues: Venue[]; cfg: ScanConfig; candidates: Candidate[]; at?: Date }): ScanRecord {
  const { best, decision, reason } = decide(o.candidates, o.cfg, o.m);
  return {
    at: (o.at ?? new Date()).toISOString(), network: o.network, block: o.block.toString(), market: { base: o.m.base.symbol, quote: o.m.quote.symbol },
    sources: o.venues.map((v) => ({ id: v.id, kind: v.kind, address: v.address, mid: v.mid, feeBps: v.feeBps })),
    config: { sizes: o.cfg.sizes.map((s) => fmtUnits(s, o.m.quote.decimals)), minProfit: fmtUnits(o.cfg.minProfit, o.m.quote.decimals), slippageBps: o.cfg.slippageBps, gasUnits: o.cfg.gasUnits.toString(), gasPriceGwei: (Number(o.cfg.gasPriceWei) / 1e9).toString() },
    candidates: o.candidates, best, decision, reason,
  };
}

/** JSON for the scan log: bigints in the units a human reads (quote units with 6 places), the rest as written. */
export function logLine(r: ScanRecord, m: Market): string {
  const f = (v: bigint) => fmtUnits(v, m.quote.decimals);
  const cand = (c: Candidate) => ({
    buyOn: c.buyOn, sellOn: c.sellOn, [`${m.quote.symbol}In`]: f(c.amountIn), [`${m.base.symbol}Bought`]: fmtUnits(c.baseBought, m.base.decimals, 8), [`${m.quote.symbol}Back`]: f(c.quoteBack),
    grossBps: Number(c.grossBps.toFixed(2)), gross: f(c.gross), fees: f(c.fees), impact: f(c.impact), slippageBuffer: f(c.slippageBuffer), gas: f(c.gas), net: f(c.net),
    ...(c.refused ? { refused: c.refused } : {}),
  });
  return JSON.stringify({ ...r, candidates: r.candidates.map(cand), best: r.best ? cand(r.best) : null });
}

export function appendLog(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, line + "\n");
}

export function scanText(r: ScanRecord, m: Market): string {
  const f = (v: bigint) => fmtUnits(v, m.quote.decimals, 6);
  const lines = [`scan at block ${r.block} (${r.network}) — ${r.market.base}/${r.market.quote}`];
  for (const s of r.sources) lines.push(`  source ${s.id.padEnd(34)} mid ${s.mid.toFixed(6)} ${m.quote.symbol} per ${m.base.symbol} · fee ${s.feeBps.toFixed(2)} bps`);
  lines.push(`  ${"route".padEnd(10)} ${"in".padStart(9)} ${"gross bps".padStart(10)} ${"gross".padStart(10)} ${"fees".padStart(10)} ${"impact".padStart(10)} ${"slip".padStart(10)} ${"gas".padStart(10)} ${"NET".padStart(11)}`);
  const idx = (id: string) => (r.sources.findIndex((s) => s.id === id) === 0 ? "A→B" : "B→A");
  for (const c of r.candidates) {
    lines.push(c.refused
      ? `  ${idx(c.buyOn).padEnd(10)} ${f(c.amountIn).padStart(9)}  refused: ${c.refused}`
      : `  ${idx(c.buyOn).padEnd(10)} ${f(c.amountIn).padStart(9)} ${c.grossBps.toFixed(1).padStart(10)} ${f(c.gross).padStart(10)} ${f(c.fees).padStart(10)} ${f(c.impact).padStart(10)} ${f(c.slippageBuffer).padStart(10)} ${f(c.gas).padStart(10)} ${f(c.net).padStart(11)}`);
  }
  lines.push(`  (route A→B = buy ${m.base.symbol} on source A, sell on B)`);
  lines.push(`${r.decision}: ${r.reason}`);
  return lines.join("\n");
}
