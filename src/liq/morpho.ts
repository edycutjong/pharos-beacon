import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import type { ChainMcp } from "../lib/mcp.js";

// Morpho Blue positions, read through the Chain MCP. A position is liquidatable when
//   borrowed > collateral × oraclePrice / 1e36 × LLTV / 1e18      (Morpho Blue's own `_isHealthy`)
// so the health factor is  maxBorrow / borrowed  (1.0 = liquidatable, 1.30 = 30 % of headroom).
// All maths is integer (bigint), rounded the way Morpho rounds, so the number matches what the contract would decide.

export type Call = ChainMcp["call"];
export const WAD = 10n ** 18n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;

export const MORPHO_BLUE = getAddress("0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb");

const abi = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function price() view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
]);

export interface MarketParams { loanToken: Hex; collateralToken: Hex; oracle: Hex; irm: Hex; lltv: bigint }
export interface MarketState { totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; lastUpdate: bigint; fee: bigint }
export interface PositionState { supplyShares: bigint; borrowShares: bigint; collateral: bigint }
export interface TokenMeta { symbol: string; decimals: number }

// ---------------------------------------------------------------- pure maths

const mulDivUp = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d;
const mulDivDown = (a: bigint, b: bigint, d: bigint) => (a * b) / d;

/** Morpho's wTaylorCompounded: e^(rate·elapsed) − 1 to three terms. `rate` is per second in WAD. */
export function taylorCompounded(rate: bigint, elapsed: bigint): bigint {
  const x = rate * elapsed;
  const secondTerm = mulDivDown(x, x, 2n * WAD);
  const third = mulDivDown(secondTerm, x, 3n * WAD);
  return x + secondTerm + third;
}

/** The market as Morpho would see it if someone touched it at `elapsed` seconds after `lastUpdate`, at borrow rate `ratePerSec` (WAD). */
export function accrue(m: MarketState, ratePerSec: bigint, elapsed: bigint): MarketState {
  if (elapsed <= 0n || m.totalBorrowAssets === 0n) return m;
  const interest = mulDivDown(m.totalBorrowAssets, taylorCompounded(ratePerSec, elapsed), WAD);
  return { ...m, totalBorrowAssets: m.totalBorrowAssets + interest, totalSupplyAssets: m.totalSupplyAssets + interest };
}

/** Debt in loan-token units: shares → assets, rounded up like Morpho (virtual 1 asset / 1e6 shares). */
export const borrowAssets = (shares: bigint, m: MarketState): bigint => mulDivUp(shares, m.totalBorrowAssets + 1n, m.totalBorrowShares + 1_000_000n);

/** The most a position may borrow: collateral × price × LLTV, each step rounded down. */
export const maxBorrow = (collateral: bigint, price: bigint, lltv: bigint): bigint => mulDivDown(mulDivDown(collateral, price, ORACLE_PRICE_SCALE), lltv, WAD);

/** Health factor in WAD (1e18 = 1.0); `null` when there is no debt (nothing to liquidate). */
export function healthFactor(collateral: bigint, price: bigint, lltv: bigint, debt: bigint): bigint | null {
  if (debt === 0n) return null;
  return mulDivDown(maxBorrow(collateral, price, lltv), WAD, debt);
}

export const hfNumber = (hf: bigint | null): number => (hf === null ? Infinity : Number(hf) / 1e18);

/** Fraction (0..1) the collateral price must fall for this health factor to reach 1.0; 0 when already at or below 1. */
export const dropToLiquidation = (hf: number): number => (!Number.isFinite(hf) ? 1 : hf <= 1 ? 0 : 1 - 1 / hf);

/**
 * What would bring the health factor back to `target` (a number like 1.3), by either of two actions:
 * repay `repay` loan-token units, or add `addCollateral` collateral-token units (both rounded up so the target is met).
 */
export function remedy(collateral: bigint, price: bigint, lltv: bigint, debt: bigint, target: number): { repay: bigint; addCollateral: bigint } {
  const t = BigInt(Math.round(target * 1e9)) * (WAD / 1_000_000_000n);
  const hf = healthFactor(collateral, price, lltv, debt);
  if (hf === null || hf >= t) return { repay: 0n, addCollateral: 0n };
  // repay r: need maxBorrow ≥ (debt − r)·t  →  r = debt − floor(maxBorrow·WAD / t)   (+1 for rounding)
  const keep = mulDivDown(maxBorrow(collateral, price, lltv), WAD, t);
  const repay = debt > keep ? debt - keep + 1n : 0n;
  // add c collateral: need maxBorrow(coll + c) ≥ debt·t / WAD
  const needBorrow = mulDivUp(debt, t, WAD);
  const needValue = mulDivUp(needBorrow, WAD, lltv);
  let c = mulDivUp(needValue, ORACLE_PRICE_SCALE, price) - collateral;
  if (c < 0n) c = 0n;
  while (healthFactor(collateral + c, price, lltv, debt)! < t) c += 1n; // floors can leave it 1 unit short
  return { repay, addCollateral: c };
}

// ---------------------------------------------------------------- reads (Chain MCP eth_call)

const withBlock = (block?: bigint) => (block === undefined ? {} : { block: block.toString() });

async function read<N extends (typeof abi)[number] & { type: "function" }>(call: Call, to: Hex, name: N["name"], args: readonly unknown[], block?: bigint): Promise<unknown> {
  const data = encodeFunctionData({ abi, functionName: name as never, args: args as never });
  const r = (await call("eth_call", { transaction: { to, data }, ...withBlock(block) })) as { result?: unknown };
  if (typeof r.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(r.result) || r.result.length < 66) {
    throw new Error(`${to} answered ${name} with no data (not the contract the watchdog expects?)`);
  }
  return decodeFunctionResult({ abi, functionName: name as never, data: r.result as Hex });
}

export async function readMarketParams(call: Call, id: Hex, block?: bigint): Promise<MarketParams> {
  const [loanToken, collateralToken, oracle, irm, lltv] = (await read(call, MORPHO_BLUE, "idToMarketParams", [id], block)) as [Hex, Hex, Hex, Hex, bigint];
  if (lltv === 0n) throw new Error(`market ${id} does not exist on Morpho Blue ${MORPHO_BLUE}`);
  return { loanToken, collateralToken, oracle, irm, lltv };
}

export async function readMarketState(call: Call, id: Hex, block?: bigint): Promise<MarketState> {
  const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = (await read(call, MORPHO_BLUE, "market", [id], block)) as bigint[] as [bigint, bigint, bigint, bigint, bigint, bigint];
  return { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee };
}

export async function readPosition(call: Call, id: Hex, user: Hex, block?: bigint): Promise<PositionState> {
  const [supplyShares, borrowShares, collateral] = (await read(call, MORPHO_BLUE, "position", [id, user], block)) as [bigint, bigint, bigint];
  return { supplyShares, borrowShares, collateral };
}

export async function readOraclePrice(call: Call, oracle: Hex, block?: bigint): Promise<bigint> {
  return (await read(call, oracle, "price", [], block)) as bigint;
}

export async function readToken(call: Call, token: Hex, block?: bigint): Promise<TokenMeta> {
  const [symbol, decimals] = await Promise.all([read(call, token, "symbol", [], block), read(call, token, "decimals", [], block)]);
  return { symbol: symbol as string, decimals: Number(decimals) };
}

/** Per-second borrow rate (WAD) from the market's IRM, or `undefined` when the IRM does not answer (the debt is then not accrued). */
export async function readBorrowRate(call: Call, p: MarketParams, m: MarketState, block?: bigint): Promise<bigint | undefined> {
  try {
    return (await read(call, p.irm, "borrowRateView", [p, m], block)) as bigint;
  } catch {
    return undefined;
  }
}

/** Everything about a market a health check needs, read once per scan at one block (or the head). */
export interface MarketSnapshot {
  id: Hex;
  params: MarketParams;
  /** Totals after accruing interest up to `timestamp`; `accrued` says whether that step could be done. */
  state: MarketState;
  accrued: boolean;
  price: bigint;
  loan: TokenMeta;
  collateral: TokenMeta;
  timestamp: bigint;
}

export async function snapshotMarket(call: Call, id: Hex, timestamp: bigint, block?: bigint): Promise<MarketSnapshot> {
  const params = await readMarketParams(call, id, block);
  const [raw, price, loan, collateral] = await Promise.all([readMarketState(call, id, block), readOraclePrice(call, params.oracle, block), readToken(call, params.loanToken, block), readToken(call, params.collateralToken, block)]);
  const rate = await readBorrowRate(call, params, raw, block);
  const state = rate === undefined ? raw : accrue(raw, rate, timestamp - raw.lastUpdate);
  return { id, params, state, accrued: rate !== undefined, price, loan, collateral, timestamp };
}

export interface PositionHealth {
  user: Hex;
  collateral: bigint;
  debt: bigint;
  /** WAD; null = no debt. */
  hf: bigint | null;
  hfNumber: number;
  /** Fraction the collateral price may still fall before liquidation (0..1). */
  dropToLiquidation: number;
  /** Oracle price (1e36 scale) at which this position becomes liquidatable. */
  liquidationPrice: bigint | null;
}

/** Health of one position under `snap`, optionally with the collateral price cut by `shock` (0.05 = −5 %): a scenario, not a read. */
export function evaluate(user: Hex, pos: PositionState, snap: MarketSnapshot, shock = 0): PositionHealth {
  const price = shock > 0 ? (snap.price * BigInt(Math.round((1 - shock) * 1e9))) / 1_000_000_000n : snap.price;
  const debt = borrowAssets(pos.borrowShares, snap.state);
  const hf = healthFactor(pos.collateral, price, snap.params.lltv, debt);
  const n = hfNumber(hf);
  // price at which maxBorrow == debt:  collateral·p/1e36·lltv/1e18 = debt
  const liquidationPrice = debt === 0n || pos.collateral === 0n ? null : mulDivUp(mulDivUp(debt, WAD, snap.params.lltv), ORACLE_PRICE_SCALE, pos.collateral);
  return { user, collateral: pos.collateral, debt, hf, hfNumber: n, dropToLiquidation: dropToLiquidation(n), liquidationPrice };
}
