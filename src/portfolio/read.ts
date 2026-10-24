import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { readUniV3, withRetries } from "../arb/venues.js";
import { MORPHO_BLUE, borrowAssets, evaluate, readPosition, snapshotMarket } from "../liq/morpho.js";
import type { ChainMcp } from "../lib/mcp.js";
import { TOKENS } from "../lib/networks.js";

// A wallet's portfolio on Pharos mainnet, read through the Chain MCP and pinned to ONE block. Every figure is a `Fact` that carries
// the contract, the call and the block it came from, so an answer can cite it (task requirement 3). A protocol that cannot be read
// becomes an `Unreadable` entry with the reason, never a guess (requirement 4). Nothing here signs or sends anything (requirement 5).

export type Call = ChainMcp["call"];

export interface Source { contract: Hex | "native"; call: string; block: bigint }
export interface Fact {
  id: string;
  /** What the number is, e.g. "USDC in wallet". */
  label: string;
  raw: bigint;
  decimals: number;
  symbol: string;
  source: Source;
}

export type Position =
  | { kind: "token"; protocol: "Wallet"; symbol: string; token: Hex | "native"; amount: Fact; usd: number | null; priceFact?: Fact }
  | { kind: "vault"; protocol: string; name: string; symbol: string; vault: Hex; shares: Fact; assets: Fact; sharePrice: Fact; usd: number }
  | { kind: "morpho"; protocol: "Morpho Blue"; market: Hex; pair: string; supplied: Fact; collateral: Fact; debt: Fact; collateralValue: Fact; hf: number | null; netUsd: number | null; loanSymbol: string; usdPegged: boolean };

export interface Unreadable { protocol: string; what: string; reason: string }

export interface Snapshot {
  wallet: Hex;
  block: bigint;
  timestamp: bigint;
  positions: Position[];
  /** Balances that were read and came back zero (so "you hold none" can cite its read). */
  zeros: Fact[];
  unreadable: Unreadable[];
  /** Morpho Blue markets whose position() was read for this wallet. */
  marketsRead: number;
}

/** Every figure of one session gets a numbered id (F1, F2, …) so an answer can cite it and the source table can list it. */
export class FactBook {
  readonly facts = new Map<string, Fact>();
  private n = 0;
  add(label: string, raw: bigint, decimals: number, symbol: string, source: Source): Fact {
    const f: Fact = { id: `F${++this.n}`, label, raw, decimals, symbol, source };
    this.facts.set(f.id, f);
    return f;
  }
}

// ---------------------------------------------------------------- what we know how to read

/** Vaults whose share price is read with ERC-4626 `convertToAssets`. `share` is the token a wallet holds (same as `vault` when the vault is its own share). */
export const VAULTS = [
  { key: "roxUSDC", protocol: "RockawayX vault", name: "RockawayX USDC", vault: getAddress("0x047cd0a91e9b92ed979189a6c8a120bf280f02e5"), share: getAddress("0x047cd0a91e9b92ed979189a6c8a120bf280f02e5") },
  { key: "JTRSY", protocol: "Centrifuge", name: "Janus Henderson Treasury Fund", vault: getAddress("0x160e0dd4c4f693b05eca83bc2ec6fd51954fc434"), share: getAddress("0xC18e6f730896971a79D748E8deA61067A9Bc6040") },
  { key: "HYB", protocol: "Centrifuge", name: "NYLIM US High Yield Bond Fund", vault: getAddress("0x74189e017d3aefee48f3cc5bf592694b2a016da8"), share: getAddress("0x4827C7ecce4f07ADfe44A97165f06A199e7d2505") },
] as const;

/** The Morpho Blue markets found on Pharos mainnet by the liquidation watchdog's Borrow-event scan (2026-10-24). */
export const MORPHO_MARKETS: Hex[] = [
  "0xc79579a002dbc8c535d3a87198fcbbece1a664ad82a356b0447c5bff9e16fd86",
  "0xd834016ed49b76ffcbeb8402733e2d69b1f77d30b28d6f21c826931214ae5aea",
  "0xab78d4ff6d4f39a7d05a822d787e33d61c68e398fd7aec5a8bca4ab296985c69",
  "0xba0d2638a277fd7696cdefdb96b5bd7405d0f174ba7526ce2c789f41149d91bc",
  "0x95bc6fe971db18703f2747ea9c8000e1525ea1c49b8c12f75c889e916a6b442c",
  "0x4cbedaf680d648926bafbce7d874ce717a1b3232ea7084c7c3593aa42bb429cd",
];

/** SkillEngine's mainnet token list (assets/tokens.json): the wallet tokens we read. */
export const WALLET_TOKENS = Object.entries(TOKENS.pharos).map(([symbol, t]) => ({ symbol, address: getAddress(t.address), decimals: t.decimals }));
export const USDC = WALLET_TOKENS.find((t) => t.symbol === "USDC")!;
export const WPROS = WALLET_TOKENS.find((t) => t.symbol === "WPROS")!;
/** The Uniswap-V3-style WPROS/USDC pool used as the PROS price (verified live in P110). */
export const PROS_POOL = getAddress("0x912c9ade24d44d8922f0866d8dcb079f1363f647");

const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const pin = (block: bigint) => ({ block: block.toString() });

async function ethCall(call: Call, to: Hex, fn: "balanceOf" | "convertToAssets" | "decimals", args: readonly unknown[], block: bigint): Promise<bigint> {
  const data = encodeFunctionData({ abi, functionName: fn as never, args: args as never });
  const r = (await call("eth_call", { transaction: { to, data }, ...pin(block) })) as { result?: unknown };
  if (typeof r.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.result)) throw new Error(`${to} answered ${fn} with no uint256`);
  return decodeFunctionResult({ abi, functionName: fn as never, data: r.result as Hex }) as bigint;
}

export const toNumber = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

export interface Header { block: bigint; timestamp: bigint }

/** The head block and its timestamp, or a pinned block's. */
export async function headerAt(call: Call, block?: bigint): Promise<Header> {
  const b = block ?? BigInt((await call("get_block_number")).blockNumber);
  const blk = await call("get_block", { block: b.toString() });
  if (!blk) throw new Error(`the Chain MCP returned no block ${b}`);
  return { block: b, timestamp: BigInt(blk.timestamp) };
}

/**
 * USDC per 1 WPROS from the pool's slot0, at `block` (a spot price, not a TWAP). The hosted node sometimes answers slot0 differently
 * twice for one pinned block (seen on 2026-10-25); readUniV3 notices, and the read is repeated up to 4 times before it is given up.
 */
export async function readProsPrice(call: Call, block: bigint): Promise<{ price: number; pool: Hex }> {
  const v = await withRetries(() => readUniV3(call, PROS_POOL, { base: { symbol: "WPROS", address: WPROS.address, decimals: 18 }, quote: { symbol: "USDC", address: USDC.address, decimals: 6 } }, block), 4);
  return { price: v.mid, pool: PROS_POOL };
}

// ---------------------------------------------------------------- one wallet at one block

/** Per-source failure isolation: a source that throws is reported as unreadable, the rest of the portfolio still answers. */
async function attempt<T>(unreadable: Unreadable[], protocol: string, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    unreadable.push({ protocol, what, reason: ((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 160) });
    return undefined;
  }
}

export async function readSnapshot(call: Call, wallet: Hex, book: FactBook, at?: bigint): Promise<Snapshot> {
  const { block, timestamp } = await headerAt(call, at);
  const fact = book.add.bind(book);
  const positions: Position[] = [];
  const unreadable: Unreadable[] = [];
  const zeros: Fact[] = [];
  let marketsRead = 0;

  // A call to an address with no code returns "0x" (proof/vault-reads.txt). Before trusting any read, check that the contract exists at
  // THIS block, so the answer says "not deployed yet" instead of a decoding error, and "you hold none" is never said about it.
  const codeChecks = new Map<string, Promise<void>>();
  const needCode = (addr: Hex, what: string): Promise<void> => {
    let p = codeChecks.get(addr);
    if (!p) {
      p = (async () => {
        const r = (await call("get_code", { address: addr, ...pin(block) })) as { code?: string };
        if (typeof r.code !== "string" || r.code === "0x" || r.code.length <= 2) throw new Error(`no contract at ${addr} at block ${block} (${what} not deployed yet, or not a contract)`);
      })();
      codeChecks.set(addr, p);
    }
    return p;
  };

  // PROS price once per snapshot (needed to value native PROS and WPROS).
  const price = await attempt(unreadable, "Wallet", "PROS price (WPROS/USDC pool)", async () => (await needCode(PROS_POOL, "the WPROS/USDC pool"), readProsPrice(call, block)));
  const prosPriceFact = price ? fact("WPROS price in USDC", BigInt(Math.round(price.price * 1e6)), 6, "USDC", { contract: price.pool, call: "slot0()", block }) : undefined;

  // wallet tokens: native PROS + the SkillEngine token list
  const native = await attempt(unreadable, "Wallet", "native PROS balance", async () => BigInt((await call("get_balance", { address: wallet, ...pin(block) })).balanceWei));
  if (native === 0n) zeros.push(fact("PROS in wallet", 0n, 18, "PROS", { contract: "native", call: "get_balance", block }));
  if (native !== undefined && native > 0n) {
    const f = fact("PROS in wallet", native, 18, "PROS", { contract: "native", call: "get_balance", block });
    positions.push({ kind: "token", protocol: "Wallet", symbol: "PROS", token: "native", amount: f, usd: price ? toNumber(native, 18) * price.price : null, priceFact: prosPriceFact });
  }
  for (const t of WALLET_TOKENS) {
    const bal = await attempt(unreadable, "Wallet", `${t.symbol} balance`, async () => (await needCode(t.address, t.symbol), ethCall(call, t.address, "balanceOf", [wallet], block)));
    if (bal === undefined) continue;
    if (bal === 0n) {
      zeros.push(fact(`${t.symbol} in wallet`, 0n, t.decimals, t.symbol, { contract: t.address, call: "balanceOf(wallet)", block }));
      continue;
    }
    const f = fact(`${t.symbol} in wallet`, bal, t.decimals, t.symbol, { contract: t.address, call: "balanceOf(wallet)", block });
    const usd = t.symbol === "USDC" ? toNumber(bal, 6) : t.symbol === "WPROS" && price ? toNumber(bal, 18) * price.price : null;
    positions.push({ kind: "token", protocol: "Wallet", symbol: t.symbol, token: t.address, amount: f, usd, priceFact: t.symbol === "WPROS" ? prosPriceFact : undefined });
  }

  // vault shares → underlying USDC via convertToAssets
  for (const v of VAULTS) {
    const shares = await attempt(unreadable, v.protocol, `${v.key} share balance`, async () => (await needCode(v.share, `${v.key} vault`), ethCall(call, v.share, "balanceOf", [wallet], block)));
    if (shares === undefined) continue;
    if (shares === 0n) {
      zeros.push(fact(`${v.key} shares`, 0n, 18, v.key, { contract: v.share, call: "balanceOf(wallet)", block }));
      continue;
    }
    await attempt(unreadable, v.protocol, `${v.key} share price`, async () => {
      const dec = Number(await ethCall(call, v.share, "decimals", [], block));
      const one = 10n ** BigInt(dec);
      const [assets, unit] = await Promise.all([ethCall(call, v.vault, "convertToAssets", [shares], block), ethCall(call, v.vault, "convertToAssets", [one], block)]);
      const sf = fact(`${v.key} shares`, shares, dec, v.key, { contract: v.share, call: "balanceOf(wallet)", block });
      const af = fact(`${v.key} worth in USDC`, assets, 6, "USDC", { contract: v.vault, call: "convertToAssets(shares)", block });
      const pf = fact(`${v.key} price of 1 share in USDC`, unit, 6, "USDC", { contract: v.vault, call: "convertToAssets(1 share)", block });
      positions.push({ kind: "vault", protocol: v.protocol, name: v.name, symbol: v.key, vault: v.vault, shares: sf, assets: af, sharePrice: pf, usd: toNumber(assets, 6) });
    });
  }

  // Morpho Blue: supply, collateral and debt in every known market
  let morphoUp = true;
  await attempt(unreadable, "Morpho Blue", "the Morpho Blue contract", async () => {
    try {
      await needCode(MORPHO_BLUE, "Morpho Blue");
    } catch (e) {
      morphoUp = false;
      throw e;
    }
  });
  for (const id of morphoUp ? MORPHO_MARKETS : []) {
    await attempt(unreadable, "Morpho Blue", `market ${id.slice(0, 10)}…`, async () => {
      const pos = await readPosition(call, id, wallet, block);
      marketsRead++;
      if (pos.supplyShares === 0n && pos.borrowShares === 0n && pos.collateral === 0n) return;
      const snap = await snapshotMarket(call, id, timestamp, block);
      const p = evaluate(wallet, pos, snap);
      const pair = `${snap.collateral.symbol}/${snap.loan.symbol}`;
      const supplyAssets = (pos.supplyShares * (snap.state.totalSupplyAssets + 1n)) / (snap.state.totalSupplyShares + 1_000_000n);
      const lt = snap.loan.decimals;
      const src = (c: string): Source => ({ contract: MORPHO_BLUE, call: c, block });
      const supplied = fact(`${pair} supplied (${snap.loan.symbol})`, supplyAssets, lt, snap.loan.symbol, src("position(id,wallet).supplyShares × market()"));
      const collateral = fact(`${pair} collateral (${snap.collateral.symbol})`, pos.collateral, snap.collateral.decimals, snap.collateral.symbol, src("position(id,wallet).collateral"));
      const debt = fact(`${pair} debt (${snap.loan.symbol})`, borrowAssets(pos.borrowShares, snap.state), lt, snap.loan.symbol, src("position(id,wallet).borrowShares × market()"));
      const collValueRaw = (pos.collateral * snap.price) / 10n ** 36n;
      const cv = fact(`${pair} collateral valued in ${snap.loan.symbol}`, collValueRaw, lt, snap.loan.symbol, { contract: snap.params.oracle, call: "price()", block });
      const usdPegged = snap.loan.symbol === "USDC";
      const net = usdPegged ? toNumber(supplyAssets, lt) + toNumber(collValueRaw, lt) - toNumber(debt.raw, lt) : null;
      positions.push({ kind: "morpho", protocol: "Morpho Blue", market: id, pair, supplied, collateral, debt, collateralValue: cv, hf: p.debt === 0n ? null : p.hfNumber, netUsd: net, loanSymbol: snap.loan.symbol, usdPegged });
    });
  }

  return { wallet, block, timestamp, positions, zeros, unreadable, marketsRead };
}

// ---------------------------------------------------------------- yield: how fast a share price grew

export interface Yield { fromBlock: bigint; toBlock: bigint; days: number; growth: number; apy: number; priceThen: Fact; priceNow: Fact }

/** Annualised growth of a vault's share price between two blocks (simple extrapolation of the window, not a forecast). */
export async function vaultYield(call: Call, pos: Extract<Position, { kind: "vault" }>, fromBlock: bigint, fromTimestamp: bigint, now: Snapshot, book: FactBook): Promise<Yield> {
  const dec = pos.shares.decimals;
  const then = await ethCall(call, pos.vault, "convertToAssets", [10n ** BigInt(dec)], fromBlock);
  const priceThen = book.add(`${pos.symbol} price of 1 share in USDC (earlier)`, then, 6, "USDC", { contract: pos.vault, call: "convertToAssets(1 share)", block: fromBlock });
  const days = Number(now.timestamp - fromTimestamp) / 86_400;
  const growth = then === 0n ? 0 : Number(pos.sharePrice.raw) / Number(then) - 1;
  const apy = days > 0 ? Math.pow(1 + growth, 365 / days) - 1 : 0;
  return { fromBlock, toBlock: now.block, days, growth, apy, priceThen, priceNow: pos.sharePrice };
}
