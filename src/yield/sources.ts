import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { MORPHO_BLUE, accrue, readBorrowRate, readMarketParams, readMarketState, readToken, type MarketParams, type MarketState } from "../liq/morpho.js";
import { MORPHO_MARKETS, VAULTS, agreeing, headerAt, type Call } from "../portfolio/read.js";
import { aprBetween, type PricePoint, type Window, type WindowRate } from "./model.js";

// Where the yield comes from, and how each source is READ. Everything goes through the Chain MCP (eth_call), twice per
// read (see `agreeing`). Nothing here signs or sends anything. A source that cannot be read says why instead of guessing.

export type Kind = "erc4626" | "centrifuge" | "morpho" | "testvault";

export interface Source {
  key: string;
  name: string;
  kind: Kind;
  /** The vault (ERC-4626 and Centrifuge) or Morpho Blue itself. */
  contract: Hex;
  /** The token a wallet holds (the vault itself, except for Centrifuge where it is a separate share token). */
  share?: Hex;
  marketId?: Hex;
}

export const USDC_MAINNET = getAddress("0xc879c018db60520f4355c26ed1a6d572cdac1815");

/** The vault-type mainnet sources (the same three the Portfolio Assistant reads, verified live in P110). */
export const MAINNET_VAULT_SOURCES: Source[] = VAULTS.map((v) => ({
  key: v.key,
  name: v.key === "roxUSDC" ? "RockawayX USDC vault" : v.name,
  kind: v.key === "roxUSDC" ? "erc4626" : "centrifuge",
  contract: v.vault,
  share: v.share,
}));

const sig = (s: string) => parseAbi([`function ${s}`] as never) as never;

/** One read of a view function. `block` pins it. Throws with the revert reason when the call reverts. */
export async function rd(call: Call, to: Hex, signature: string, args: readonly unknown[], block?: bigint, from?: Hex): Promise<unknown> {
  const abi = sig(signature);
  const data = encodeFunctionData({ abi, args } as never);
  const r = (await call("eth_call", { transaction: { ...(from ? { from } : {}), to, data }, ...(block === undefined ? {} : { block: block.toString() }) })) as { result?: unknown };
  if (typeof r.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(r.result) || r.result.length < 66) throw new Error(`${to} answered ${signature.split("(")[0]} with no data`);
  return decodeFunctionResult({ abi, data: r.result as Hex } as never);
}
const big = async (call: Call, to: Hex, signature: string, args: readonly unknown[], block?: bigint) => (await rd(call, to, signature, args, block)) as bigint;

async function tryRd<T>(fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; why: string }> {
  try {
    return { ok: true, v: await fn() };
  } catch (e) {
    return { ok: false, why: ((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 140) };
  }
}

/** One figure with where it came from, so the output and the proof can be traced. */
export interface Ev {
  what: string;
  value: string;
  contract: Hex | "native";
  call: string;
  block: bigint;
}

export interface Holding {
  /** Share-token units (Morpho: supply shares). */
  shares: bigint;
  /** What they are worth in USDC raw units. */
  assets: bigint;
}

/** The holder's position in `src` at `block`, or null when the wallet holds nothing there. */
export async function holdingOf(call0: Call, src: Source, wallet: Hex, block: bigint, timestamp: bigint, ev?: Ev[]): Promise<Holding | null> {
  const call = agreeing(call0);
  if (src.kind === "morpho") {
    const pos = (await rd(call, MORPHO_BLUE, "position(bytes32,address) view returns (uint256,uint128,uint128)", [src.marketId, wallet], block)) as readonly bigint[];
    const sharesRaw = pos[0]!;
    if (sharesRaw === 0n) return null;
    const st = await accruedState(call, src.marketId!, block, timestamp);
    const assets = (sharesRaw * (st.totalSupplyAssets + 1n)) / (st.totalSupplyShares + 1_000_000n);
    ev?.push({ what: `${src.name} supply shares of the wallet`, value: sharesRaw.toString(), contract: MORPHO_BLUE, call: "position(id,wallet).supplyShares", block });
    return { shares: sharesRaw, assets };
  }
  const shareToken = src.share ?? src.contract;
  const shares = await big(call, shareToken, "balanceOf(address) view returns (uint256)", [wallet], block);
  if (shares === 0n) return null;
  const assets = await big(call, src.contract, "convertToAssets(uint256) view returns (uint256)", [shares], block);
  ev?.push({ what: `${src.name} shares of the wallet`, value: shares.toString(), contract: shareToken, call: "balanceOf(wallet)", block });
  ev?.push({ what: `${src.name} position worth (USDC raw)`, value: assets.toString(), contract: src.contract, call: "convertToAssets(shares)", block });
  return { shares, assets };
}

async function accruedState(call: Call, id: Hex, block: bigint, timestamp: bigint): Promise<MarketState> {
  const raw = await readMarketState(call, id, block);
  const params = await readMarketParams(call, id, block);
  const rate = await readBorrowRate(call, params, raw, block);
  // Interest that has not been booked yet is part of the price. Without the IRM's answer the price would be stale, so it is refused.
  if (rate === undefined) throw new Error(`the interest rate model ${params.irm} did not answer borrowRateView at block ${block}: the market's price cannot be accrued`);
  return accrue(raw, rate, timestamp - raw.lastUpdate);
}

// ---------------------------------------------------------------- price of a share at a block

export interface Basis {
  assetDecimals: number;
  shareDecimals: number;
}

/**
 * Assets (whole units) per whole share at `block`. The vault is asked for the value of 10^(share decimals + 6) shares, so the
 * answer keeps 12 digits of precision even though USDC has 6: a 7-day growth of 0.05 % is not lost to rounding.
 */
export async function priceAt(call: Call, src: Source, basis: Basis, block: bigint, timestamp: bigint): Promise<PricePoint> {
  if (src.kind === "morpho") {
    const st = await accruedState(call, src.marketId!, block, timestamp);
    // virtual shares as Morpho counts them: price per share = (assets + 1) / (shares + 1e6), in loan-token units per 1e6 shares → per share unit
    return { block, timestamp, price: (Number(st.totalSupplyAssets) + 1) / (Number(st.totalSupplyShares) + 1_000_000) };
  }
  const K = 10n ** BigInt(basis.shareDecimals + 6);
  const assets = await big(call, src.contract, "convertToAssets(uint256) view returns (uint256)", [K], block);
  return { block, timestamp, price: Number(assets) / 10 ** basis.assetDecimals / 1e6 };
}

/**
 * A share price that a neighbour confirms. The hosted node has served a wrong price at one height, twice in a row, 7 % away from the
 * truth (proof/node-flake.txt); asking the same block twice does not catch that. A price is trusted only when the price one block
 * earlier agrees with it to 0.001 %; otherwise the anchor moves two blocks down and it is tried again (4 anchors, then it is refused).
 * The returned point carries the block it was actually read at, and rates use the timestamps of the points, so nothing is distorted.
 */
export async function confirmedPrice(call: Call, src: Source, basis: Basis, at: { block: bigint; timestamp: bigint }): Promise<PricePoint> {
  let why = "";
  for (let k = 0n; k < 4n; k++) {
    const b = at.block - 2n * k;
    const here = k === 0n ? at : await headerAt(call, b);
    const prev = await headerAt(call, b - 1n);
    const p1 = await priceAt(call, src, basis, here.block, here.timestamp);
    const p0 = await priceAt(call, src, basis, prev.block, prev.timestamp);
    if (p0.price > 0 && Math.abs(p1.price / p0.price - 1) <= 1e-5) return p1;
    why = `block ${here.block} gives ${p1.price.toFixed(9)} but block ${prev.block} gives ${p0.price.toFixed(9)}`;
  }
  throw new Error(`the node's prices disagree between adjacent blocks near ${at.block} (${why}); not trusting them`);
}

// ---------------------------------------------------------------- one source, read in full

export interface WindowSample {
  window: Window;
  block: bigint;
  timestamp: bigint;
}

export interface EntryInfo {
  feeBps: number | null;
  maxDeposit: bigint | null;
  blockers: string[];
  /** Plain statement of how the fee was obtained. */
  note: string;
}

export interface ExitInfo {
  feeBps: number | null;
  /** USDC raw units that can leave right now in one call, when readable. */
  depth: bigint | null;
  lockedUntil: bigint | null;
  blockers: string[];
  note: string;
}

export interface Reading {
  source: Source;
  basis: Basis;
  now: PricePoint;
  tvl: bigint | null;
  windows: WindowRate[];
  samples: { label: string; then: PricePoint }[];
  entry: EntryInfo;
  exit: ExitInfo;
  lockSeconds: number;
  evidence: Ev[];
}

const bps = (num: bigint, den: bigint): number => (den === 0n ? 0 : Math.max(0, Math.round((Number(num) / Number(den)) * 1e6) / 100));

export interface ReadCtx {
  call: Call;
  wallet: Hex;
  head: { block: bigint; timestamp: bigint };
  samples: WindowSample[];
  /** The size of the move in USDC raw units (the current position's exit value). */
  amount: bigint;
  /** Shares of the CURRENT position when `src` is it (to preview the exit). */
  heldShares?: bigint;
  assetDecimals: number;
  usdc: Hex;
  /** How the blocker text names `amount` (default " being moved"). */
  amountNote?: string;
}

export async function readSource(src: Source, ctx: ReadCtx): Promise<Reading> {
  const call = agreeing(ctx.call);
  const { block, timestamp } = ctx.head;
  const evidence: Ev[] = [];
  const ev = (what: string, value: string, contract: Hex | "native", c: string, b = block) => evidence.push({ what, value, contract, call: c, block: b });

  // ---- decimals and the loan token
  let shareDecimals = 18;
  if (src.kind === "morpho") {
    const p = await readMarketParams(call, src.marketId!, block);
    if (p.loanToken.toLowerCase() !== ctx.usdc.toLowerCase()) throw new Error(`market ${src.marketId} lends ${p.loanToken}, not USDC`);
    shareDecimals = 6;
  } else {
    shareDecimals = Number(await big(call, src.share ?? src.contract, "decimals() view returns (uint8)", [], block));
    const asset = (await rd(call, src.contract, "asset() view returns (address)", [], block)) as Hex;
    if (asset.toLowerCase() !== ctx.usdc.toLowerCase()) throw new Error(`${src.name} holds ${asset}, not USDC`);
    ev("vault asset", asset, src.contract, "asset()");
  }
  const basis: Basis = { assetDecimals: ctx.assetDecimals, shareDecimals };

  // ---- price now and in each window
  const now = await confirmedPrice(ctx.call, src, basis, { block, timestamp });
  ev("share price now (USDC per share)", now.price.toFixed(9), src.kind === "morpho" ? MORPHO_BLUE : src.contract, src.kind === "morpho" ? "market(id) accrued with borrowRateView" : `convertToAssets(10^${shareDecimals + 6})`, now.block);
  const windows: WindowRate[] = [];
  const samples: Reading["samples"] = [];
  for (const s of ctx.samples) {
    const r = await tryRd(() => confirmedPrice(ctx.call, src, basis, { block: s.block, timestamp: s.timestamp }));
    if (!r.ok) {
      windows.push({ label: s.window.label, seconds: s.window.seconds, apr: null, reason: `not readable at block ${s.block}: ${r.why}` });
      continue;
    }
    samples.push({ label: s.window.label, then: r.v });
    ev(`share price ${s.window.label} ago (USDC per share)`, r.v.price.toFixed(9), src.kind === "morpho" ? MORPHO_BLUE : src.contract, "same call, pinned", r.v.block);
    windows.push({ label: s.window.label, seconds: s.window.seconds, apr: aprBetween(r.v, now) });
  }

  // ---- size, entry and exit
  let tvl: bigint | null = null;
  const entry: EntryInfo = { feeBps: null, maxDeposit: null, blockers: [], note: "" };
  const exit: ExitInfo = { feeBps: null, depth: null, lockedUntil: null, blockers: [], note: "" };
  let lockSeconds = 0;
  const held = ctx.heldShares;

  if (src.kind === "morpho") {
    const st = await accruedState(call, src.marketId!, block, timestamp);
    tvl = st.totalSupplyAssets;
    const liquidity = st.totalSupplyAssets - st.totalBorrowAssets;
    ev("market supply (USDC raw)", st.totalSupplyAssets.toString(), MORPHO_BLUE, "market(id).totalSupplyAssets (accrued)");
    ev("market borrow (USDC raw)", st.totalBorrowAssets.toString(), MORPHO_BLUE, "market(id).totalBorrowAssets (accrued)");
    entry.feeBps = 0;
    entry.note = "Morpho Blue supply charges no entry fee (supply() has no fee parameter)";
    exit.feeBps = 0;
    exit.depth = liquidity;
    exit.note = `Morpho Blue withdraw charges no exit fee; what can leave is the market's idle liquidity (supply − borrow) = ${liquidity}`;
    if (held !== undefined && liquidity < ctx.amount) exit.blockers.push(`only ${liquidity} USDC raw of idle liquidity, less than the ${ctx.amount} being withdrawn (the market is lent out)`);
    if (liquidity === 0n) entry.note += "; the market has no idle liquidity, so a later exit would wait for repayments";
  } else {
    tvl = await big(call, src.contract, "totalAssets() view returns (uint256)", [], block);
    ev("totalAssets (USDC raw)", tvl.toString(), src.contract, "totalAssets()");
    const maxDep = await tryRd(() => big(call, src.contract, "maxDeposit(address) view returns (uint256)", [ctx.wallet], block));
    entry.maxDeposit = maxDep.ok ? maxDep.v : null;
    if (!maxDep.ok) entry.blockers.push(`maxDeposit(wallet) cannot be read (${maxDep.why}), so whether this vault takes the deposit is unknown`);
    if (maxDep.ok) ev("maxDeposit(wallet) (USDC raw)", maxDep.v.toString(), src.contract, "maxDeposit(wallet)");
    const amount = ctx.amount;
    // entry fee = what previewDeposit gives against what a fee-free conversion would give
    const pd = await tryRd(() => big(call, src.contract, "previewDeposit(uint256) view returns (uint256)", [amount], block));
    if (pd.ok) {
      const cs = await big(call, src.contract, "convertToShares(uint256) view returns (uint256)", [amount], block);
      entry.feeBps = bps(cs > pd.v ? cs - pd.v : 0n, cs);
      entry.note = `entry fee = 1 − previewDeposit(${amount}) / convertToShares(${amount}) = ${entry.feeBps} bps`;
      ev("previewDeposit(amount) (shares raw)", pd.v.toString(), src.contract, `previewDeposit(${amount})`);
      ev("convertToShares(amount) (shares raw)", cs.toString(), src.contract, `convertToShares(${amount})`);
    } else {
      entry.note = `previewDeposit reverts (${pd.why}): the deposit is an asynchronous request, so its fee cannot be read`;
    }
    if (entry.maxDeposit !== null && entry.maxDeposit < amount) entry.blockers.push(`maxDeposit(wallet) = ${entry.maxDeposit} USDC raw, below the ${amount}${ctx.amountNote ?? " being moved"} (${src.kind === "centrifuge" ? "the vault takes deposits only as asynchronous requests from approved investors" : "the vault is full, paused or restricted"})`);
    if (!pd.ok) entry.blockers.push("deposit is an asynchronous request (previewDeposit reverts), so it cannot be one transaction in a one-shot move");
    if (src.kind === "testvault") {
      const lock = await big(call, src.contract, "lockSeconds() view returns (uint256)", [], block);
      lockSeconds = Number(lock);
      ev("lock-in after a deposit (s)", lock.toString(), src.contract, "lockSeconds()");
    }
    // exit: previewRedeem against convertToAssets, maxRedeem, lock
    if (held !== undefined) {
      const pr = await tryRd(() => big(call, src.contract, "previewRedeem(uint256) view returns (uint256)", [held], block));
      const gross = await big(call, src.contract, "convertToAssets(uint256) view returns (uint256)", [held], block);
      const mr = await tryRd(() => big(call, src.contract, "maxRedeem(address) view returns (uint256)", [ctx.wallet], block));
      if (pr.ok) {
        exit.feeBps = bps(gross > pr.v ? gross - pr.v : 0n, gross);
        exit.note = `exit fee = 1 − previewRedeem(shares) / convertToAssets(shares) = ${exit.feeBps} bps`;
        ev("previewRedeem(held shares) (USDC raw)", pr.v.toString(), src.contract, "previewRedeem(shares)");
      } else {
        exit.note = `previewRedeem reverts (${pr.why}): the redeem is an asynchronous request, so its fee and delay cannot be read`;
        exit.blockers.push("redeem is an asynchronous request (previewRedeem reverts): it settles in a later epoch, not in one transaction");
      }
      if (mr.ok) {
        exit.depth = mr.v;
        ev("maxRedeem(wallet) (share raw)", mr.v.toString(), src.contract, "maxRedeem(wallet)");
      }
      if (src.kind === "testvault") {
        const lu = await big(call, src.contract, "lockedUntil(address) view returns (uint256)", [ctx.wallet], block);
        exit.lockedUntil = lu;
        if (lu > timestamp) exit.blockers.push(`locked until ${new Date(Number(lu) * 1000).toISOString()} (lockedUntil(wallet) = ${lu})`);
      }
      // The decisive test of an exit is to run it: a redeem of ALL shares simulated from the wallet (eth_call), because maxRedeem
      // is only what a vault REPORTS (the RockawayX vault reports 0 at every block we asked, yet its redeem is open).
      if (pr.ok && exit.blockers.length === 0) {
        const sim = await tryRd(() => rd(call, src.contract, "redeem(uint256,address,address) returns (uint256)", [held, ctx.wallet, ctx.wallet], block, ctx.wallet));
        if (sim.ok) {
          exit.note += `; a simulated redeem(all shares) from the wallet succeeds and returns ${String(sim.v)} USDC raw${mr.ok && mr.v < held ? ` (maxRedeem(wallet) reports ${mr.v}, which this vault does not enforce)` : ""}`;
          ev("simulated redeem(all shares) (USDC raw)", String(sim.v), src.contract, "eth_call redeem(shares, wallet, wallet) from the wallet");
        } else {
          exit.blockers.push(`a simulated redeem(all shares) from the wallet reverts (${sim.why})${mr.ok && mr.v < held ? `; maxRedeem(wallet) = ${mr.v} shares` : ""}`);
        }
      }
    }
  }
  return { source: src, basis, now, tvl, windows, samples, entry, exit, lockSeconds, evidence };
}

// ---------------------------------------------------------------- finding the USDC markets on Morpho Blue

/** The Morpho Blue markets (found by the liquidation watchdog's Borrow-event scan) that lend USDC and hold at least `minSupply` USDC raw. */
export async function morphoUsdcSources(call0: Call, usdc: Hex, head: bigint, timestamp: bigint, minSupply = 1_000n * 10n ** 6n): Promise<{ sources: Source[]; skipped: string[] }> {
  const call = agreeing(call0);
  const sources: Source[] = [];
  const skipped: string[] = [];
  for (const id of MORPHO_MARKETS) {
    try {
      const p: MarketParams = await readMarketParams(call, id, head);
      if (p.loanToken.toLowerCase() !== usdc.toLowerCase()) {
        skipped.push(`${id.slice(0, 10)}…: lends ${p.loanToken}, not USDC`);
        continue;
      }
      const st = await accruedState(call, id, head, timestamp);
      if (st.totalSupplyAssets < minSupply) {
        skipped.push(`${id.slice(0, 10)}…: only ${st.totalSupplyAssets} USDC raw supplied (below ${minSupply})`);
        continue;
      }
      const coll = await readToken(call, p.collateralToken, head);
      sources.push({ key: `morpho-${id.slice(2, 8)}`, name: `Morpho Blue ${coll.symbol}/USDC supply`, kind: "morpho", contract: MORPHO_BLUE, marketId: id });
    } catch (e) {
      skipped.push(`${id.slice(0, 10)}…: ${((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 100)}`);
    }
  }
  return { sources, skipped };
}

export async function windowSamples(call: Call, head: { block: bigint; timestamp: bigint }, windows: Window[], secondsPerBlock: number): Promise<WindowSample[]> {
  const out: WindowSample[] = [];
  for (const w of windows) {
    const b = head.block - BigInt(Math.max(1, Math.round(w.seconds / secondsPerBlock)));
    if (b < 1n) continue;
    const h = await headerAt(call, b);
    out.push({ window: w, block: h.block, timestamp: h.timestamp });
  }
  return out;
}
