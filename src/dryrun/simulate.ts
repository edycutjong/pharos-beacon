import { decodeErrorResult, decodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, toHex, type Hex } from "viem";
import { ChainToolError, type ChainMcp } from "../lib/mcp.js";
import { ERRORS_ABI } from "../../tasks/dapp-support-agent/diagnose.js";

// Simulate a transaction without broadcasting it: eth_call (does it run, what does it return or revert with), estimate_gas
// (how much gas), get_block + get_gas_price (what a unit costs), get_balance / balanceOf (state before). The state after is
// PREDICTED from the call (value moves, a decoded ERC-20 transfer moves tokens) and checked against the chain after a real send.

export type Call = ChainMcp["call"];

export interface SimRequest {
  from: Hex;
  to: Hex;
  value: bigint;
  data?: Hex;
  /** Set for token transfers so balances carry a symbol and decimals. */
  token?: { symbol: string; decimals: number };
}

export interface BalanceChange {
  who: "sender" | "recipient";
  address: Hex;
  asset: string; // "PHRS" or the token symbol / address
  before: bigint;
  after: bigint;
  decimals: number;
}

export interface Simulation {
  request: SimRequest;
  block: string;
  ok: boolean;
  /** Why it would fail, in one line (revert reason decoded when the contract gave one). */
  failure?: string;
  revertData?: Hex;
  gas?: bigint;
  /** gas × (base fee + priority fee) in wei at simulation time. */
  gasPriceWei: bigint;
  costWei?: bigint;
  changes: BalanceChange[];
}

/** Revert bytes → a sentence. Error(string) and Panic come from viem; token and ownership errors from the shared list. */
export function explainRevertData(data: Hex | undefined): string {
  if (!data || data === "0x") return "reverted without a reason";
  try {
    const d = decodeErrorResult({ abi: ERRORS_ABI, data }) as { errorName: string; args?: readonly unknown[] };
    const a = (d.args ?? []).map((x) => (typeof x === "bigint" ? x.toString() : String(x)));
    if (d.errorName === "Error") return `reverted: ${a[0]}`;
    return `reverted: ${d.errorName}(${a.join(", ")})`;
  } catch {
    return `reverted with an error this tool cannot decode (selector ${data.slice(0, 10)})`;
  }
}

/** The ERC-20 transfer(to, amount) a call carries, if it is one. */
export function decodeTransfer(data: Hex | undefined): { to: Hex; amount: bigint } | null {
  if (!data || data === "0x") return null;
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data });
    if (d.functionName === "transfer") return { to: getAddress(d.args[0]), amount: d.args[1] };
  } catch {
    /* not an ERC-20 call */
  }
  return null;
}

const balanceOfData = (a: Hex) => `0x70a08231${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

async function tokenBalance(call: Call, token: Hex, holder: Hex): Promise<bigint> {
  const { result } = await call("eth_call", { transaction: { to: token, data: balanceOfData(holder) } });
  return BigInt(result);
}

export async function simulate(call: Call, req: SimRequest): Promise<Simulation> {
  const tx = { from: req.from, to: req.to, value: toHex(req.value), ...(req.data ? { data: req.data } : {}) };
  const [{ blockNumber }, senderBal, block, price] = await Promise.all([
    call("get_block_number"),
    call("get_balance", { address: req.from }),
    call("get_block", { block: "latest" }),
    call("get_gas_price"),
  ]);
  const gasPriceWei = BigInt(block?.baseFeePerGas ?? 0) + BigInt(price.maxPriorityFeePerGasWei);
  const transfer = decodeTransfer(req.data);
  const decimals = req.token?.decimals ?? 18;
  const changes: BalanceChange[] = [];
  const sim: Simulation = { request: req, block: blockNumber, ok: true, gasPriceWei, changes };

  const fail = (why: string, revertData?: Hex) => {
    sim.ok = false;
    sim.failure = why;
    if (revertData) sim.revertData = revertData;
  };

  // 1. does it run? A revert is JSON-RPC code 3 with the reason bytes; anything else is the node refusing the call.
  try {
    await call("eth_call", { transaction: tx });
  } catch (e) {
    if (!(e instanceof ChainToolError)) throw e;
    const data = e.code === 3 && typeof e.data === "string" ? (e.data as Hex) : undefined;
    fail(e.code === 3 ? explainRevertData(data) : `the node refused the call: ${e.reason}`, data);
  }

  // 2. how much gas? (also fails on a revert; the first failure wins)
  if (sim.ok) {
    try {
      sim.gas = BigInt((await call("estimate_gas", { transaction: tx })).gas);
      sim.costWei = sim.gas * gasPriceWei;
    } catch (e) {
      if (!(e instanceof ChainToolError)) throw e;
      fail(`gas estimation failed: ${e.reason}`);
    }
  }

  // 3. can the sender pay value + fee?
  const senderNative = BigInt(senderBal.balanceWei);
  if (sim.ok && sim.costWei !== undefined && senderNative < req.value + sim.costWei) {
    fail(`not enough PHRS for value + fee: has ${formatEther(senderNative)}, needs ${formatEther(req.value + sim.costWei)}`);
  }

  // 4. balances before → predicted after (what the transaction touches)
  const fee = sim.ok ? sim.costWei ?? 0n : 0n;
  const value = sim.ok ? req.value : 0n;
  const selfSend = req.to.toLowerCase() === req.from.toLowerCase();
  changes.push({ who: "sender", address: req.from, asset: "PHRS", decimals: 18, before: senderNative, after: senderNative - value - fee });
  if (transfer === null) {
    const recipBal = selfSend ? senderBal : await call("get_balance", { address: req.to });
    changes.push({ who: "recipient", address: req.to, asset: "PHRS", decimals: 18, before: BigInt(recipBal.balanceWei), after: BigInt(recipBal.balanceWei) + (selfSend ? 0n : value) });
  } else {
    const symbol = req.token?.symbol ?? req.to;
    const [sTok, rTok] = await Promise.all([tokenBalance(call, req.to, req.from), tokenBalance(call, req.to, transfer.to)]);
    const moved = sim.ok ? transfer.amount : 0n;
    changes.push({ who: "sender", address: req.from, asset: symbol, decimals, before: sTok, after: sTok - moved });
    changes.push({ who: "recipient", address: transfer.to, asset: symbol, decimals, before: rTok, after: transfer.to.toLowerCase() === req.from.toLowerCase() ? rTok : rTok + moved });
  }
  return sim;
}

export const fmt = (c: { before: bigint; after: bigint; decimals: number; asset: string }) =>
  `${formatUnits(c.before, c.decimals)} → ${formatUnits(c.after, c.decimals)} ${c.asset}`;
