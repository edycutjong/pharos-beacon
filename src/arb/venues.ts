import { encodeAbiParameters, getAddress, type Hex } from "viem";
import type { ChainMcp } from "../lib/mcp.js";

// Price sources for the Arbitrage Scanner. Every venue is read through the Chain MCP (eth_call at an optional pinned block) and
// answers the same question: "what does `amountIn` of one side pay out in the other?". Base = the volatile token (WPROS),
// quote = the dollar token (USDC); `mid` is quote per ONE base in human units.

export type Call = ChainMcp["call"];
export type Side = "base-in" | "quote-in";
export interface TokenInfo { symbol: string; address: Hex; decimals: number }
export interface Market { base: TokenInfo; quote: TokenInfo }
export interface Quote { out: bigint; feeBps: number }
export type QuoteResult = Quote | { refused: string };

export interface Venue {
  /** Short stable name used in logs: "uniswap-v3-style 0x912c…f647". */
  id: string;
  kind: "uniswap-v3-style" | "dodo-v2-pmm" | "arb-pool";
  address: Hex;
  /** Marginal price: quote units per 1 base unit (human), before fees and impact. */
  mid: number;
  /** Nominal swap fee in basis points (quotes carry the fee they actually paid). */
  feeBps: number;
  /** Raw values read from the chain (strings), for the scan log. */
  raw: Record<string, string>;
  quote(side: Side, amountIn: bigint): Promise<QuoteResult>;
}

export const Q96 = 2n ** 96n;

/** Two reads that should describe one state disagree: retry the read, never price from it. */
export class InconsistentRead extends Error {
  override name = "InconsistentRead";
}

/** Run a venue read, repeating it when its own consistency check fails (the RPC answered from two different states). */
export async function withRetries<T>(read: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (e) {
      if (!(e instanceof InconsistentRead) || i >= attempts) throw e;
    }
  }
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const tag = (block?: bigint) => (block === undefined ? {} : { block: block.toString() });
const word = (hex: string, i: number) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const u = (hex: string, i: number) => BigInt("0x" + word(hex, i));
const signed24 = (hex: string, i: number) => {
  const v = Number(BigInt("0x" + word(hex, i)) & 0xffffffn);
  return v >= 0x800000 ? v - 0x1000000 : v;
};
const addrOf = (hex: string, i = 0) => getAddress("0x" + word(hex, i).slice(24));

async function ethCall(call: Call, to: Hex, data: Hex, block?: bigint): Promise<string> {
  const r = await call("eth_call", { transaction: { to, data }, ...tag(block) });
  if (typeof r.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(r.result) || r.result.length < 66) {
    throw new Error(`${to} answered ${data.slice(0, 10)} with no data (not the contract the scanner expects?)`);
  }
  return r.result;
}

// ---------------------------------------------------------------- Uniswap-V3-style pool: slot0 + liquidity, math done locally

export interface V3Snapshot { sqrtP: bigint; liquidity: bigint; tick: number; spacing: number; feePpm: number }

/**
 * An exact-input quote that stays inside the CURRENT tick range (liquidity constant, Uniswap-V3 formulas rounded the
 * way the pool rounds). A trade that would leave the range is refused: the liquidity beyond it is not read.
 */
export function quoteV3(s: V3Snapshot, side: Side, amountIn: bigint): QuoteResult {
  if (amountIn <= 0n) return { refused: "amount must be positive" };
  if (s.liquidity <= 0n) return { refused: "no liquidity in range" };
  const afterFee = (amountIn * BigInt(1_000_000 - s.feePpm)) / 1_000_000n;
  const lower = Math.floor(s.tick / s.spacing) * s.spacing;
  const sqrtAt = (t: number) => Math.sqrt(1.0001 ** t);
  let out: bigint;
  let next: bigint;
  if (side === "base-in") {
    // token0 in, price falls: sqrtP' = ceil(L·Q96·sqrtP / (L·Q96 + in·sqrtP))
    const num = s.liquidity * Q96;
    const den = num + afterFee * s.sqrtP;
    next = (num * s.sqrtP + den - 1n) / den;
    out = (s.liquidity * (s.sqrtP - next)) / Q96;
    if (Number(next) / Number(Q96) < sqrtAt(lower)) return { refused: `would cross the tick boundary ${lower} (liquidity beyond it not read)` };
  } else {
    next = s.sqrtP + (afterFee * Q96) / s.liquidity;
    out = (s.liquidity * Q96 * (next - s.sqrtP)) / (next * s.sqrtP);
    if (Number(next) / Number(Q96) > sqrtAt(lower + s.spacing)) return { refused: `would cross the tick boundary ${lower + s.spacing} (liquidity beyond it not read)` };
  }
  return { out, feeBps: s.feePpm / 100 };
}

export async function readUniV3(call: Call, address: Hex, m: Market, block?: bigint): Promise<Venue> {
  const [t0, t1, slot0, liq, spacing, fee, slot0Again] = await Promise.all([
    ethCall(call, address, "0x0dfe1681", block), ethCall(call, address, "0xd21220a7", block), ethCall(call, address, "0x3850c7bd", block),
    ethCall(call, address, "0x1a686502", block), ethCall(call, address, "0xd0c93a7c", block), ethCall(call, address, "0xddca3f43", block),
    ethCall(call, address, "0x3850c7bd", block),
  ]);
  if (slot0 !== slot0Again) throw new InconsistentRead(`${address}: slot0 answered differently twice for ${block === undefined ? "the same moment" : `block ${block}`}`);
  if (addrOf(t0).toLowerCase() !== m.base.address.toLowerCase() || addrOf(t1).toLowerCase() !== m.quote.address.toLowerCase()) {
    throw new Error(`${address}: token0/token1 are ${addrOf(t0)}/${addrOf(t1)}, expected ${m.base.address}/${m.quote.address}`);
  }
  const snap: V3Snapshot = { sqrtP: u(slot0, 0), tick: signed24(slot0, 1), liquidity: u(liq, 0), spacing: Number(u(spacing, 0)), feePpm: Number(u(fee, 0)) };
  const mid = (Number(snap.sqrtP) / Number(Q96)) ** 2 * 10 ** (m.base.decimals - m.quote.decimals);
  return {
    id: `uniswap-v3-style ${short(address)}`, kind: "uniswap-v3-style", address, mid, feeBps: snap.feePpm / 100,
    raw: { sqrtPriceX96: snap.sqrtP.toString(), tick: String(snap.tick), liquidity: snap.liquidity.toString(), tickSpacing: String(snap.spacing), feePpm: String(snap.feePpm) },
    quote: async (side, amountIn) => quoteV3(snap, side, amountIn),
  };
}

// ---------------------------------------------------------------- DODO-V2-style PMM pool (FaroSwap): querySellBase / querySellQuote

export async function readDodo(call: Call, address: Hex, m: Market, block?: bigint): Promise<Venue> {
  const [base, quote, mid, lp] = await Promise.all([
    ethCall(call, address, "0x4a248d2a", block), ethCall(call, address, "0xd4b97046", block),
    ethCall(call, address, "0xee27c689", block), ethCall(call, address, "0xab44a7a3", block),
  ]);
  if (addrOf(base).toLowerCase() !== m.base.address.toLowerCase() || addrOf(quote).toLowerCase() !== m.quote.address.toLowerCase()) {
    throw new Error(`${address}: base/quote are ${addrOf(base)}/${addrOf(quote)}, expected ${m.base.address}/${m.quote.address}`);
  }
  const lpRate = Number(u(lp, 0)) / 1e18; // 0.0024 = 0.24 %
  const trader = "0x000000000000000000000000000000000000dEaD";
  const q = async (sel: "0x79a04876" | "0x66410a21", amountIn: bigint) => {
    const data = (sel + encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [trader, amountIn]).slice(2)) as Hex;
    const r = await ethCall(call, address, data, block);
    return { out: u(r, 0), mtFee: u(r, 1) };
  };
  // The RPC behind the hosted server occasionally answers a historical read from a different state: a pool's mid price must
  // agree with what a tiny trade really pays, otherwise the two reads came from different states and nothing is priced.
  const midPrice = Number(u(mid, 0)) / 10 ** m.quote.decimals;
  const probeIn = 10n ** BigInt(m.base.decimals - 3);
  const probe = await q("0x79a04876", probeIn);
  const implied = Number(probe.out + probe.mtFee) / 10 ** m.quote.decimals / (Number(probeIn) / 10 ** m.base.decimals) / (1 - lpRate);
  if (Math.abs(implied / midPrice - 1) > 0.02) {
    throw new InconsistentRead(`${address}: mid price ${midPrice} but a 0.001 ${m.base.symbol} sale implies ${implied.toFixed(6)} (reads from different states)`);
  }
  return {
    id: `dodo-v2-pmm ${short(address)}`, kind: "dodo-v2-pmm", address,
    mid: midPrice, feeBps: lpRate * 1e4,
    raw: { midPrice: u(mid, 0).toString(), lpFeeRate1e18: u(lp, 0).toString() },
    async quote(side, amountIn) {
      if (amountIn <= 0n) return { refused: "amount must be positive" };
      try {
        const { out, mtFee } = await q(side === "base-in" ? "0x79a04876" : "0x66410a21", amountIn);
        if (out === 0n) return { refused: "the pool pays out nothing for this amount" };
        // querySell* returns the amount after both fees plus the maintainer fee on its own: total fee = lp rate + mt/(out+mt).
        const mtRate = Number(mtFee) / Number(out + mtFee);
        return { out, feeBps: (lpRate + mtRate) * 1e4 };
      } catch (e) {
        return { refused: `pool refused the quote: ${(e as Error).message.slice(0, 120)}` };
      }
    },
  };
}

// ---------------------------------------------------------------- ArbPool (our own Atlantic test pool): exact on-chain quote()

export async function readArbPool(call: Call, address: Hex, m: Market, block?: bigint): Promise<Venue> {
  const [a, b, num, den, fee] = await Promise.all(["0x0fc63d10", "0x5f64b55b", "0xda438bfa", "0x200fe4fb", "0x24a9d853"].map((d) => ethCall(call, address, d as Hex, block)));
  if (addrOf(a!).toLowerCase() !== m.base.address.toLowerCase() || addrOf(b!).toLowerCase() !== m.quote.address.toLowerCase()) {
    throw new Error(`${address}: tokenA/tokenB are ${addrOf(a!)}/${addrOf(b!)}, expected ${m.base.address}/${m.quote.address}`);
  }
  const feeBps = Number(u(fee!, 0));
  const quoteData = (token: Hex, amountIn: bigint) => ("0x8f79306e" + encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, amountIn]).slice(2)) as Hex;
  return {
    id: `arb-pool ${short(address)}`, kind: "arb-pool", address,
    mid: (Number(u(num!, 0)) / Number(u(den!, 0))) * 10 ** (m.base.decimals - m.quote.decimals), feeBps,
    raw: { rateNum: u(num!, 0).toString(), rateDen: u(den!, 0).toString(), feeBps: String(feeBps) },
    async quote(side, amountIn) {
      if (amountIn <= 0n) return { refused: "amount must be positive" };
      try {
        const r = await ethCall(call, address, quoteData(side === "base-in" ? m.base.address : m.quote.address, amountIn), block);
        return u(r, 0) === 0n ? { refused: "the pool pays out nothing for this amount" } : { out: u(r, 0), feeBps };
      } catch (e) {
        return { refused: `pool refused the quote: ${(e as Error).message.slice(0, 120)}` };
      }
    },
  };
}
