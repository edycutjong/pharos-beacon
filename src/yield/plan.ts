import { encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Hex } from "viem";
import { MORPHO_BLUE, readMarketParams, type MarketParams } from "../liq/morpho.js";
import type { Call } from "../portfolio/read.js";
import type { Source } from "./sources.js";

// A move, prepared for the user's wallet to sign. This file builds calldata and nothing else: it imports no signer, reads no key and
// has no way to send (a test greps the sources to keep it that way). The wallet shows each transaction, the user signs it.

export interface UnsignedTx {
  step: number;
  action: "exit" | "approve" | "enter";
  description: string;
  /** eth_sendTransaction parameters, ready for any wallet. */
  request: { from: Hex; to: Hex; data: Hex; value: Hex; chainId: Hex };
  /** Gas units: an estimate_gas answer ("estimated") or the configured default ("configured"). */
  gas: { units: number; basis: "estimated" | "configured" };
}

export interface MovePlan {
  kind: "unsigned-move-plan";
  signed: false;
  note: string;
  chainId: number;
  wallet: Hex;
  from: { key: string; name: string; contract: Hex };
  to: { key: string; name: string; contract: Hex };
  /** What the second and third transactions put in: the previewed proceeds of the exit, minus the slippage allowance. */
  depositAssets: string;
  slippageBps: number;
  transactions: UnsignedTx[];
  /** Fingerprint of the transactions, so the wallet can check it signs what was shown. */
  planId: Hex;
}

const erc4626 = parseAbi(["function redeem(uint256 shares, address receiver, address owner) returns (uint256)", "function deposit(uint256 assets, address receiver) returns (uint256)"]);
const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const morpho = parseAbi([
  "function withdraw((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
  "function supply((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
]);

/** Gas units used when estimate_gas cannot be asked (a deposit before its approve is mined). Stated as "configured" wherever shown. */
export const DEFAULT_GAS = { exit: 250_000, approve: 60_000, enter: 300_000 } as const;

export class NotPlannable extends Error {
  override name = "NotPlannable";
}

export interface PlanInput {
  call: Call;
  chainId: number;
  wallet: Hex;
  usdc: Hex;
  from: Source;
  to: Source;
  /** Shares of `from` to redeem (everything the wallet holds). */
  shares: bigint;
  /** Previewed proceeds of the exit in USDC raw units (after the exit fee). */
  proceeds: bigint;
  slippageBps: number;
  block: bigint;
  /** Ask the node how much gas a transaction needs; null = could not be asked. */
  estimate: (tx: { from: Hex; to: Hex; data: Hex }) => Promise<number | null>;
}

const needParams = async (call: Call, s: Source, block: bigint): Promise<MarketParams> => readMarketParams(call, s.marketId!, block);

export async function planMove(i: PlanInput): Promise<MovePlan> {
  for (const s of [i.from, i.to]) if (s.kind === "centrifuge") throw new NotPlannable(`${s.name} is an asynchronous (ERC-7540) vault: its deposits and redeems are requests settled in a later epoch, so no one-shot move can be prepared`);
  if (i.from.key === i.to.key) throw new NotPlannable("the source and the destination are the same");
  const depositAssets = (i.proceeds * BigInt(10_000 - i.slippageBps)) / 10_000n;
  const w = i.wallet;
  const hex = toHex(i.chainId);

  let exitData: Hex;
  let exitTo: Hex;
  if (i.from.kind === "morpho") {
    exitTo = MORPHO_BLUE;
    exitData = encodeFunctionData({ abi: morpho, functionName: "withdraw", args: [await needParams(i.call, i.from, i.block), 0n, i.shares, w, w] });
  } else {
    exitTo = i.from.contract;
    exitData = encodeFunctionData({ abi: erc4626, functionName: "redeem", args: [i.shares, w, w] });
  }
  const spender = i.to.kind === "morpho" ? MORPHO_BLUE : i.to.contract;
  const approveData = encodeFunctionData({ abi: erc20, functionName: "approve", args: [spender, depositAssets] });
  let enterData: Hex;
  if (i.to.kind === "morpho") enterData = encodeFunctionData({ abi: morpho, functionName: "supply", args: [await needParams(i.call, i.to, i.block), depositAssets, 0n, w, "0x"] });
  else enterData = encodeFunctionData({ abi: erc4626, functionName: "deposit", args: [depositAssets, w] });

  const exitGas = await i.estimate({ from: w, to: exitTo, data: exitData });
  const approveGas = await i.estimate({ from: w, to: i.usdc, data: approveData });
  const mk = (step: number, action: UnsignedTx["action"], description: string, to: Hex, data: Hex, g: number | null, dflt: number): UnsignedTx => ({
    step,
    action,
    description,
    request: { from: w, to, data, value: "0x0", chainId: hex },
    gas: g === null ? { units: dflt, basis: "configured" } : { units: g, basis: "estimated" },
  });
  const transactions: UnsignedTx[] = [
    mk(1, "exit", `${i.from.kind === "morpho" ? "Withdraw all supply from" : "Redeem all shares of"} ${i.from.name}`, exitTo, exitData, exitGas, DEFAULT_GAS.exit),
    mk(2, "approve", `Approve ${i.to.name} to pull ${depositAssets} USDC raw (the exit's previewed proceeds ${i.proceeds} less ${i.slippageBps} bps)`, i.usdc, approveData, approveGas, DEFAULT_GAS.approve),
    mk(3, "enter", `${i.to.kind === "morpho" ? "Supply" : "Deposit"} ${depositAssets} USDC raw into ${i.to.name}`, spender, enterData, null, DEFAULT_GAS.enter),
  ];
  const planId = planFingerprint(transactions);
  return {
    kind: "unsigned-move-plan",
    signed: false,
    note: "Prepared for the wallet owner's signature. This file holds no key and nothing in it has been signed or sent; the wallet shows each transaction and the owner signs it.",
    chainId: i.chainId,
    wallet: getAddress(w),
    from: { key: i.from.key, name: i.from.name, contract: i.from.contract },
    to: { key: i.to.key, name: i.to.name, contract: i.to.contract },
    depositAssets: depositAssets.toString(),
    slippageBps: i.slippageBps,
    transactions,
    planId,
  };
}

/** Fingerprint of the requests in a plan: a wallet recomputes it to check it is signing what was shown. */
export const planFingerprint = (txs: UnsignedTx[]): Hex => keccak256(toHex(JSON.stringify(txs.map((t) => t.request))));

export const totalGas = (p: MovePlan): number => p.transactions.reduce((a, t) => a + t.gas.units, 0);
