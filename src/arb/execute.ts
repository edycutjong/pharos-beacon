import { encodeFunctionData, parseAbi, type Hex } from "viem";
import type { TestnetSigner } from "../lib/signer.js";
import type { ChainMcp } from "../lib/mcp.js";
import { explorerTx } from "../lib/networks.js";
import { fmtUnits, gasCost, type Candidate, type ScanConfig } from "./scan.js";
import { readArbPool, type Market } from "./venues.js";

// Acting on a decision. Mainnet is read-only: a decision to act yields a PLAN (the legs and their calldata), never a signature.
// On Atlantic the two ArbPool contracts let the scanner really execute: leg 1, a fresh read of leg 2, then leg 2 only if the
// round trip is still profitable.

const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const arbPool = parseAbi(["function swap(address tokenIn,uint256 amountIn,uint256 minOut) returns (uint256)"]);
const dodoPool = parseAbi(["function sellBase(address to) returns (uint256)", "function sellQuote(address to) returns (uint256)"]);
const v3Pool = parseAbi(["function swap(address recipient,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,bytes data) returns (int256,int256)"]);

const MIN_SQRT_RATIO_PLUS_1 = 4295128740n;
const MAX_SQRT_RATIO_MINUS_1 = 1461446703485210103287273052203988822378723970341n;

export interface PlannedTx { step: string; to: Hex; data: Hex; note?: string }

/** minOut with the slippage allowance taken off the quote. */
export const withSlippage = (out: bigint, slippageBps: number): bigint => (out * BigInt(1_000_000 - Math.round(slippageBps * 100))) / 1_000_000n;

type VenueRef = { kind: "uniswap-v3-style" | "dodo-v2-pmm" | "arb-pool"; address: Hex };

/** One leg as pool-level calls: what a router/helper contract would have to execute. Not signed, not sent. */
function legCalls(v: VenueRef, side: "base-in" | "quote-in", tokenIn: Hex, amountIn: bigint, minOut: bigint, to: Hex): PlannedTx[] {
  if (v.kind === "arb-pool") {
    return [
      { step: "approve", to: tokenIn, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [v.address, amountIn] }) },
      { step: "swap", to: v.address, data: encodeFunctionData({ abi: arbPool, functionName: "swap", args: [tokenIn, amountIn, minOut] }) },
    ];
  }
  if (v.kind === "dodo-v2-pmm") {
    return [
      { step: "transfer in", to: tokenIn, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [v.address, amountIn] }), note: "DODO pools take the input by transfer, then sell*()" },
      { step: side === "base-in" ? "sellBase" : "sellQuote", to: v.address, data: encodeFunctionData({ abi: dodoPool, functionName: side === "base-in" ? "sellBase" : "sellQuote", args: [to] }), note: `pays out at least ${minOut} raw units` },
    ];
  }
  return [{
    step: "pool.swap", to: v.address,
    data: encodeFunctionData({ abi: v3Pool, functionName: "swap", args: [to, side === "base-in", amountIn, side === "base-in" ? MIN_SQRT_RATIO_PLUS_1 : MAX_SQRT_RATIO_MINUS_1, "0x"] }),
    note: `a V3-style pool pays out through a callback contract (no router is documented for it), so this is the pool call a helper would make; minOut ${minOut} is checked by that helper`,
  }];
}

/** The plan for a decision to act: two legs, in order, with the minimum each must pay out. */
export function planRoute(c: Candidate, buy: VenueRef, sell: VenueRef, m: Market, cfg: ScanConfig, from: Hex): { legs: { venue: string; side: string; amountIn: string; minOut: string; calls: PlannedTx[] }[]; signed: false } {
  const bought = withSlippage(c.baseBought, cfg.slippageBps);
  const back = withSlippage(c.quoteBack, cfg.slippageBps);
  return {
    signed: false,
    legs: [
      { venue: c.buyOn, side: `${m.quote.symbol} in`, amountIn: fmtUnits(c.amountIn, m.quote.decimals), minOut: fmtUnits(bought, m.base.decimals, 8), calls: legCalls(buy, "quote-in", m.quote.address, c.amountIn, bought, from) },
      { venue: c.sellOn, side: `${m.base.symbol} in`, amountIn: fmtUnits(c.baseBought, m.base.decimals, 8), minOut: fmtUnits(back, m.quote.decimals), calls: legCalls(sell, "base-in", m.base.address, c.baseBought, back, from) },
    ],
  };
}

const bal = async (mcp: ChainMcp, token: Hex, who: Hex) =>
  BigInt((await mcp.call("eth_call", { transaction: { to: token, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [who] }) } })).result);

export interface ExecutionReport {
  outcome: "completed" | "stopped-after-leg-1" | "stopped-before-sending";
  reason?: string;
  txs: { step: string; hash: Hex; status: "success" | "reverted"; gasUsed: string; explorer: string }[];
  before: { quote: string; base: string };
  after: { quote: string; base: string };
  predictedNet: string;
  /** Quote balance change, plus the native gas actually paid priced at the sell pool's rate: comparable with `predictedNet` minus the slippage buffer. */
  realisedNet: string;
  gasUsedTotal: string;
  gasUnitsConfigured: string;
}

export async function executeOnAtlantic(o: {
  mcp: ChainMcp; signer: TestnetSigner; m: Market; cfg: ScanConfig; candidate: Candidate; buy: VenueRef; sell: VenueRef; log: (s: string) => void;
}): Promise<ExecutionReport> {
  const { mcp, signer, m, cfg, candidate: c } = o;
  const d = m.quote.decimals;
  const who = signer.address;
  const before = { quote: await bal(mcp, m.quote.address, who), base: await bal(mcp, m.base.address, who) };
  const txs: ExecutionReport["txs"] = [];
  let gasUsedTotal = 0n;
  let gasWeiTotal = 0n;
  const send = async (step: string, to: Hex, data: Hex) => {
    const s = await signer.send({ to, data });
    o.log(`  tx ${step}: ${explorerTx("atlantic", s.hash)} …`);
    const r = await signer.waitForReceipt(s.hash);
    gasUsedTotal += r.gasUsed;
    gasWeiTotal += r.gasUsed * (r.effectiveGasPrice ?? s.tx.maxFeePerGas);
    txs.push({ step, hash: s.hash, status: r.status, gasUsed: r.gasUsed.toString(), explorer: explorerTx("atlantic", s.hash) });
    if (r.status !== "success") throw new Error(`${step} reverted (${explorerTx("atlantic", s.hash)})`);
  };
  const report = (outcome: ExecutionReport["outcome"], after: { quote: bigint; base: bigint }, reason?: string): ExecutionReport => {
    const sellMid = Number(c.quoteBack) / Number(c.baseBought) * 10 ** (m.base.decimals - m.quote.decimals);
    const gasQuote = BigInt(Math.ceil((Number(gasWeiTotal) / 1e18) * sellMid * 10 ** d));
    return {
      outcome, ...(reason ? { reason } : {}), txs,
      before: { quote: fmtUnits(before.quote, d), base: fmtUnits(before.base, m.base.decimals, 8) }, after: { quote: fmtUnits(after.quote, d), base: fmtUnits(after.base, m.base.decimals, 8) },
      predictedNet: fmtUnits(c.net + c.slippageBuffer, d), realisedNet: fmtUnits(after.quote - before.quote - gasQuote, d),
      gasUsedTotal: gasUsedTotal.toString(), gasUnitsConfigured: cfg.gasUnits.toString(),
    };
  };

  const minBought = withSlippage(c.baseBought, cfg.slippageBps);
  const allowance = async (token: Hex, spender: Hex) => BigInt((await mcp.call("eth_call", { transaction: { to: token, data: encodeFunctionData({ abi: erc20, functionName: "allowance", args: [who, spender] }) } })).result);
  // Leg 1: buy the base where it is cheap.
  o.log(`leg 1: ${fmtUnits(c.amountIn, d)} ${m.quote.symbol} → ${m.base.symbol} on ${c.buyOn} (min out ${fmtUnits(minBought, m.base.decimals, 8)})`);
  if ((await allowance(m.quote.address, o.buy.address)) < c.amountIn) await send("approve quote → buy pool", m.quote.address, encodeFunctionData({ abi: erc20, functionName: "approve", args: [o.buy.address, c.amountIn] }));
  await send("swap on the cheap pool", o.buy.address, encodeFunctionData({ abi: arbPool, functionName: "swap", args: [m.quote.address, c.amountIn, minBought] }));
  const mid = { quote: await bal(mcp, m.quote.address, who), base: await bal(mcp, m.base.address, who) };
  const got = mid.base - before.base;
  o.log(`  bought ${fmtUnits(got, m.base.decimals, 8)} ${m.base.symbol}`);

  // Between the legs: read leg 2 again with what leg 1 really paid out; only go on when the round trip still clears the threshold.
  const sellPool = await readArbPool(mcp.call.bind(mcp), o.sell.address, m);
  const q2 = await sellPool.quote("base-in", got);
  const gasSoFar = BigInt(Math.ceil((Number(gasWeiTotal) / 1e18) * sellPool.mid * 10 ** d));
  const remainingGas = gasCost({ gasUnits: cfg.gasUnits / 2n, gasPriceWei: cfg.gasPriceWei }, sellPool.mid, d);
  if ("refused" in q2) return report("stopped-after-leg-1", mid, `leg 2 quote refused: ${q2.refused}`);
  const projected = q2.out - c.amountIn - c.slippageBuffer - gasSoFar - remainingGas;
  o.log(`re-read leg 2: ${sellPool.id} pays ${fmtUnits(q2.out, d)} ${m.quote.symbol} for ${fmtUnits(got, m.base.decimals, 8)} ${m.base.symbol}; projected net ${fmtUnits(projected, d)} (gas so far + the rest, slippage buffer included)`);
  if (projected < cfg.minProfit || projected <= 0n) return report("stopped-after-leg-1", mid, `after leg 1 the projected net ${fmtUnits(projected, d)} ${m.quote.symbol} is below the ${fmtUnits(cfg.minProfit, d)} ${m.quote.symbol} threshold: leg 2 not sent, ${m.base.symbol} is held`);

  // Leg 2: sell the base where it is dear.
  const minBack = withSlippage(q2.out, cfg.slippageBps);
  o.log(`leg 2: ${fmtUnits(got, m.base.decimals, 8)} ${m.base.symbol} → ${m.quote.symbol} on ${c.sellOn} (min out ${fmtUnits(minBack, d)})`);
  try {
    if ((await allowance(m.base.address, o.sell.address)) < got) await send("approve base → sell pool", m.base.address, encodeFunctionData({ abi: erc20, functionName: "approve", args: [o.sell.address, got] }));
    await send("swap on the dear pool", o.sell.address, encodeFunctionData({ abi: arbPool, functionName: "swap", args: [m.base.address, got, minBack] }));
  } catch (e) {
    // Leg 1 has landed: say so, with the transactions so far and the balances as they are, instead of throwing the report away.
    const now = { quote: await bal(mcp, m.quote.address, who), base: await bal(mcp, m.base.address, who) };
    return report("stopped-after-leg-1", now, `leg 2 failed (${(e as Error).message.slice(0, 160)}): ${m.base.symbol} is held`);
  }
  const after = { quote: await bal(mcp, m.quote.address, who), base: await bal(mcp, m.base.address, who) };
  return report("completed", after);
}
