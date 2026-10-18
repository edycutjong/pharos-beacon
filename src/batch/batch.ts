import { decodeFunctionResult, encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, parseEther, parseUnits, toHex, type Hex } from "viem";
import { ChainToolError, type ChainMcp } from "../lib/mcp.js";
import { TOKENS } from "../lib/networks.js";
import { explainRevertData } from "../dryrun/simulate.js";

// Batch Executor: several independent actions → ONE transaction through Multicall3.aggregate3Value, every call with
// allowFailure = true, so one failing action does not undo the others. Multicall3 is the contract that makes the calls,
// so for tokens the batch uses transferFrom(sender, to, amount) against an allowance given to Multicall3.

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Hex;
export type Call = ChainMcp["call"];

export const multicallAbi = [
  {
    type: "function", name: "aggregate3Value", stateMutability: "payable",
    inputs: [{ name: "calls", type: "tuple[]", components: [
      { name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" },
    ] }],
    outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }],
  },
] as const;

export type ActionSpec =
  | { type: "native"; to: string; value: string }
  | { type: "erc20"; token: string; to: string; amount: string };

export class PlanError extends Error {}

export interface Action {
  index: number;
  label: string;
  /** What the batch calls (the token, or the recipient for a native send). */
  target: Hex;
  value: bigint;
  data: Hex;
  /** What the same action costs as a transaction of its own. */
  alone: { to: Hex; value: bigint; data?: Hex };
  /** Who must end up richer, and in what, for the action to count as applied. */
  watch: { holder: Hex; asset: string; token?: Hex; decimals: number; amount: bigint };
}

const TOKEN_NAMES = Object.keys(TOKENS.atlantic);

/** Check a plan's actions and turn them into calls. Throws PlanError with the reason; the minimum is 3 independent actions. */
export function resolveActions(specs: unknown, sender: Hex): Action[] {
  if (!Array.isArray(specs)) throw new PlanError("the plan needs an \"actions\" list");
  if (specs.length < 3) throw new PlanError(`a batch needs at least 3 independent actions, the plan has ${specs.length}`);
  const seen = new Set<string>();
  return specs.map((raw, index): Action => {
    const n = index + 1;
    const s = raw as Partial<ActionSpec> & Record<string, string>;
    if (s.type !== "native" && s.type !== "erc20") throw new PlanError(`action ${n}: "type" must be "native" or "erc20"`);
    const to = (() => {
      try { return getAddress(String(s.to)); } catch { throw new PlanError(`action ${n}: "to" must be a 0x address`); }
    })();
    let action: Action;
    if (s.type === "native") {
      let value: bigint;
      try { value = parseEther(String(s.value)); } catch { throw new PlanError(`action ${n}: "value" must be a number of PHRS`); }
      if (value <= 0n) throw new PlanError(`action ${n}: "value" must be above 0`);
      action = {
        index, label: `send ${s.value} PHRS to ${to}`, target: to, value, data: "0x", alone: { to, value },
        watch: { holder: to, asset: "PHRS", decimals: 18, amount: value },
      };
    } else {
      const tok = TOKENS.atlantic[String(s.token) as keyof typeof TOKENS.atlantic];
      if (!tok) throw new PlanError(`action ${n}: "token" must be one of ${TOKEN_NAMES.join(", ")}`);
      let amount: bigint;
      try { amount = parseUnits(String(s.amount), tok.decimals); } catch { throw new PlanError(`action ${n}: "amount" must be a number`); }
      if (amount <= 0n) throw new PlanError(`action ${n}: "amount" must be above 0`);
      const token = getAddress(tok.address);
      action = {
        index, label: `send ${s.amount} ${s.token} to ${to}`, target: token, value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [sender, to, amount] }),
        alone: { to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) },
        watch: { holder: to, asset: String(s.token), token, decimals: tok.decimals, amount },
      };
    }
    const key = `${action.watch.asset}:${to.toLowerCase()}`;
    if (seen.has(key)) throw new PlanError(`action ${n}: ${action.watch.asset} to ${to} appears twice; independent actions need their own recipient`);
    seen.add(key);
    return action;
  });
}

export const batchCalldata = (actions: Action[]): { data: Hex; value: bigint } => ({
  data: encodeFunctionData({
    abi: multicallAbi, functionName: "aggregate3Value",
    args: [actions.map((a) => ({ target: a.target, allowFailure: true, value: a.value, callData: a.data }))],
  }),
  value: actions.reduce((t, a) => t + a.value, 0n),
});

export interface ActionSim {
  action: Action;
  /** Would the action succeed inside the batch (the eth_call of the whole batch says so, per action)? */
  ok: boolean;
  failure?: string;
  /** Gas the action would cost as its own transaction; undefined when that would fail. */
  aloneGas?: bigint;
  aloneFailure?: string;
}

export interface BatchSim {
  block: string;
  actions: ActionSim[];
  /** Estimated gas of the single batch transaction. */
  batchGas?: bigint;
  gasPriceWei: bigint;
  /** The batch transaction itself would revert (not one action): nothing to send. */
  batchFailure?: string;
}

const balanceOfData = (a: Hex) => `0x70a08231${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

export async function readHolder(call: Call, w: Action["watch"]): Promise<bigint> {
  if (!w.token) return BigInt((await call("get_balance", { address: w.holder })).balanceWei);
  return BigInt((await call("eth_call", { transaction: { to: w.token, data: balanceOfData(w.holder) } })).result);
}

const failureOf = (e: unknown): string => {
  if (!(e instanceof ChainToolError)) throw e;
  return e.code === 3 && typeof e.data === "string" ? explainRevertData(e.data as Hex) : `the node refused the call: ${e.reason}`;
};

/** Simulate the batch and each action alone. Sends nothing. */
export async function simulateBatch(call: Call, sender: Hex, actions: Action[]): Promise<BatchSim> {
  const [{ blockNumber }, block, price] = await Promise.all([call("get_block_number"), call("get_block", { block: "latest" }), call("get_gas_price")]);
  const gasPriceWei = BigInt(block?.baseFeePerGas ?? 0) + BigInt(price.maxPriorityFeePerGasWei);
  const { data, value } = batchCalldata(actions);
  const tx = { from: sender, to: MULTICALL3, value: toHex(value), data };
  const sim: BatchSim = { block: blockNumber, actions: [], gasPriceWei };

  // 1. what each action does inside the batch: allowFailure turns a revert into success=false for that action only
  let flags: { success: boolean; returnData: Hex }[] | undefined;
  try {
    const { result } = await call("eth_call", { transaction: tx });
    flags = decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3Value", data: result }) as unknown as { success: boolean; returnData: Hex }[];
  } catch (e) {
    sim.batchFailure = failureOf(e);
  }
  // 2. what each action costs alone (the comparison), or why it could not go alone
  for (const [position, action] of actions.entries()) {
    const f = flags?.[position]; // by position in THIS batch: after --drop-failing, action.index still names the plan's number
    const s: ActionSim = { action, ok: f?.success ?? false };
    if (f && !f.success) s.failure = explainRevertData(f.returnData);
    if (!flags) s.failure = sim.batchFailure!;
    try {
      const alone = { from: sender, to: action.alone.to, value: toHex(action.alone.value), ...(action.alone.data ? { data: action.alone.data } : {}) };
      s.aloneGas = BigInt((await call("estimate_gas", { transaction: alone })).gas);
    } catch (e) {
      s.aloneFailure = failureOf(e);
    }
    sim.actions.push(s);
  }
  // 3. gas of the single batch transaction
  if (flags) {
    try { sim.batchGas = BigInt((await call("estimate_gas", { transaction: tx })).gas); } catch (e) { sim.batchFailure = `gas estimation failed: ${failureOf(e)}`; }
  }
  return sim;
}

export interface SendResult { tx: Hex; status: "success" | "reverted"; block: string; gasUsed: bigint; effectiveGasPrice?: bigint }
export type Send = (to: Hex, value: bigint, data: Hex, gas: bigint) => Promise<SendResult>;

export interface ActionOutcome {
  action: Action;
  predictedOk: boolean;
  /** What the chain says after the send: the recipient received exactly the amount. */
  applied: boolean;
  received: bigint;
  failure?: string;
}

export interface Comparison {
  /** Actions that could also run alone, and the sum of their individual estimates. */
  comparable: number;
  individualGas: bigint;
  batchGasEstimated: bigint;
  batchGasUsed: bigint;
  /** individual sum − batch used (negative = the batch cost MORE gas). */
  savedGas: bigint;
  savedPct: string;
  /** Transactions to sign and send: N alone vs 1 batch. */
  txAlone: number;
  txBatch: 1;
}

export interface BatchResult {
  status: "simulated" | "blocked" | "executed" | "reverted";
  sim: BatchSim;
  /** Actions removed before sending by --drop-failing, with the reason. */
  dropped: { label: string; failure: string }[];
  /** The simulation the sent batch was built from (differs from `sim` only when actions were dropped). */
  sent?: SendResult;
  outcomes?: ActionOutcome[];
  comparison?: Comparison;
  /** Why a viable-looking batch was not sent (set with status "blocked"). */
  blockReason?: string;
  /** Allowance given to Multicall3 per token, when --approve had to raise it. */
  approvals?: { token: string; tx: Hex }[];
}

export const pct = (num: bigint, den: bigint): string => {
  if (den === 0n) return "0.00";
  const bp = (num * 10000n) / den;
  const sign = bp < 0n ? "-" : "";
  const abs = bp < 0n ? -bp : bp;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
};

export function compare(sim: BatchSim, batchGasUsed: bigint): Comparison {
  const comparable = sim.actions.filter((a) => a.aloneGas !== undefined);
  const individualGas = comparable.reduce((t, a) => t + a.aloneGas!, 0n);
  const saved = individualGas - batchGasUsed;
  return {
    comparable: comparable.length, individualGas, batchGasEstimated: sim.batchGas ?? 0n, batchGasUsed,
    savedGas: saved, savedPct: pct(saved, individualGas), txAlone: comparable.length, txBatch: 1,
  };
}

/** simulate → (optionally drop the actions that would fail) → only a viable batch may reach `send`. */
export async function runBatch(
  call: Call, sender: Hex, all: Action[], o: { execute: boolean; dropFailing: boolean; send?: Send },
): Promise<BatchResult> {
  let actions = all;
  let sim = await simulateBatch(call, sender, actions);
  const dropped: BatchResult["dropped"] = [];
  if (o.dropFailing && !sim.batchFailure) {
    const bad = sim.actions.filter((a) => !a.ok);
    if (bad.length > 0) {
      for (const b of bad) dropped.push({ label: b.action.label, failure: b.failure ?? "would fail" });
      actions = actions.filter((a) => sim.actions.find((s) => s.action === a)!.ok);
      if (actions.length === 0) return { status: "blocked", sim, dropped };
      sim = await simulateBatch(call, sender, actions);
    }
  }
  if (sim.batchFailure || sim.batchGas === undefined) return { status: "blocked", sim, dropped, blockReason: sim.batchFailure ?? "no gas estimate" };
  // aggregate3Value keeps the PHRS of a failed call inside Multicall3: never send one on purpose.
  const stranded = sim.actions.filter((a) => !a.ok && a.action.value > 0n);
  if (stranded.length > 0) {
    return { status: "blocked", sim, dropped, blockReason: `${stranded.map((a) => `action ${a.action.index + 1}`).join(", ")} would fail and its PHRS would stay stuck in Multicall3; fix it or pass --drop-failing` };
  }
  if (!o.execute || !o.send) return { status: "simulated", sim, dropped };

  const before = await Promise.all(actions.map((a) => readHolder(call, a.watch)));
  const { data, value } = batchCalldata(actions);
  const sent = await o.send(MULTICALL3, value, data, (sim.batchGas * 12n) / 10n);
  if (sent.status === "reverted") return { status: "reverted", sim, dropped, sent };
  const after = await Promise.all(actions.map((a) => readHolder(call, a.watch)));
  const outcomes: ActionOutcome[] = actions.map((action, i) => {
    const received = after[i]! - before[i]!;
    const s = sim.actions[i]!;
    return { action, predictedOk: s.ok, applied: received === action.watch.amount, received, ...(s.failure ? { failure: s.failure } : {}) };
  });
  return { status: "executed", sim, dropped, sent, outcomes, comparison: compare(sim, sent.gasUsed) };
}

export const fmtAmount = (w: Action["watch"], v: bigint) => `${formatUnits(v, w.decimals)} ${w.asset}`;
export const feeOf = (gas: bigint, price: bigint) => `${formatEther(gas * price)} PHRS`;
