import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, toHex, type Hex } from "viem";
import { MORPHO_BLUE, readMarketParams } from "../liq/morpho.js";
import type { Call } from "../portfolio/read.js";
import { DEFAULT_GAS, erc20, erc4626, morpho } from "../yield/plan.js";
import { holdingOf, readSource, type Holding, type ReadCtx, type Reading, type Source } from "../yield/sources.js";

// One interface over every protocol the aggregator speaks to. A protocol is an `Adapter`: how to read a position, how to read the
// market (rate, entry, exit), and how to PREPARE a deposit or a withdrawal. Nothing here signs or sends: the output is calldata for
// the owner's wallet, and this file imports no signer (a test greps for it). The router (route.ts) only ever sees `Venue`s and
// `Reading`s, so a new protocol is one new adapter and no change to the routing.

export type ProtocolId = "rockawayx" | "morpho" | "centrifuge" | "testvault";

export interface Venue {
  /** Unique, e.g. `morpho-5be0cf`. */
  id: string;
  protocol: ProtocolId;
  protocolName: string;
  name: string;
  source: Source;
}

export interface ActionTx {
  step: number;
  action: "approve" | "deposit" | "withdraw";
  venue: string;
  description: string;
  /** The transaction parameters a wallet's send request takes, ready for any wallet. */
  request: { from: Hex; to: Hex; data: Hex; value: Hex; chainId: Hex };
  gas: { units: number; basis: "estimated" | "configured" };
}

/** A deposit or withdrawal that cannot be prepared as plain transactions, with the reason. */
export class NotPreparable extends Error {
  override name = "NotPreparable";
}

export interface PrepareInput {
  call: Call;
  chainId: number;
  wallet: Hex;
  usdc: Hex;
  venue: Venue;
  /** USDC raw units to put in or take out. */
  assets: bigint;
  /** A withdrawal of the whole position, as shares (so no dust is left behind). */
  all?: boolean;
  /** The wallet's position, for a withdrawal. */
  holding?: Holding;
  block: bigint;
  estimate: (tx: { from: Hex; to: Hex; data: Hex }) => Promise<number | null>;
}

export interface Adapter {
  protocol: ProtocolId;
  protocolName: string;
  holding(call: Call, v: Venue, wallet: Hex, block: bigint, timestamp: bigint): Promise<Holding | null>;
  read(v: Venue, ctx: ReadCtx): Promise<Reading>;
  prepareDeposit(i: PrepareInput): Promise<ActionTx[]>;
  prepareWithdraw(i: PrepareInput): Promise<ActionTx[]>;
}

const tx = (i: PrepareInput, step: number, action: ActionTx["action"], description: string, to: Hex, data: Hex, g: number | null, dflt: number): ActionTx => ({
  step,
  action,
  venue: i.venue.id,
  description,
  request: { from: i.wallet, to, data, value: "0x0", chainId: toHex(i.chainId) },
  gas: g === null ? { units: dflt, basis: "configured" } : { units: g, basis: "estimated" },
});

const base = { holding: (call: Call, v: Venue, wallet: Hex, block: bigint, timestamp: bigint) => holdingOf(call, v.source, wallet, block, timestamp), read: (v: Venue, ctx: ReadCtx) => readSource(v.source, ctx) };

/** ERC-4626 vaults (RockawayX, and our own test vaults): `deposit(assets, receiver)` and `redeem(shares, receiver, owner)`. */
const vault = (protocol: ProtocolId, protocolName: string): Adapter => ({
  protocol,
  protocolName,
  ...base,
  async prepareDeposit(i) {
    const approve = encodeFunctionData({ abi: erc20, functionName: "approve", args: [i.venue.source.contract, i.assets] });
    const dep = encodeFunctionData({ abi: erc4626, functionName: "deposit", args: [i.assets, i.wallet] });
    return [
      tx(i, 1, "approve", `Approve ${i.venue.name} to pull ${i.assets} USDC raw`, i.usdc, approve, await i.estimate({ from: i.wallet, to: i.usdc, data: approve }), DEFAULT_GAS.approve),
      tx(i, 2, "deposit", `Deposit ${i.assets} USDC raw into ${i.venue.name}`, i.venue.source.contract, dep, null, DEFAULT_GAS.enter),
    ];
  },
  async prepareWithdraw(i) {
    const h = i.holding!;
    // a partial withdrawal redeems the shares worth the amount, rounded UP so at least the amount comes out
    const shares = i.all || i.assets >= h.assets ? h.shares : (i.assets * h.shares + h.assets - 1n) / h.assets;
    const data = encodeFunctionData({ abi: erc4626, functionName: "redeem", args: [shares, i.wallet, i.wallet] });
    return [tx(i, 1, "withdraw", `Redeem ${shares} shares of ${i.venue.name} (about ${i.all ? h.assets : i.assets} USDC raw)`, i.venue.source.contract, data, await i.estimate({ from: i.wallet, to: i.venue.source.contract, data }), DEFAULT_GAS.exit)];
  },
});

const morphoAdapter: Adapter = {
  protocol: "morpho",
  protocolName: "Morpho Blue",
  ...base,
  async prepareDeposit(i) {
    const params = await readMarketParams(i.call, i.venue.source.marketId!, i.block);
    const approve = encodeFunctionData({ abi: erc20, functionName: "approve", args: [MORPHO_BLUE, i.assets] });
    const sup = encodeFunctionData({ abi: morpho, functionName: "supply", args: [params, i.assets, 0n, i.wallet, "0x"] });
    return [
      tx(i, 1, "approve", `Approve Morpho Blue to pull ${i.assets} USDC raw`, i.usdc, approve, await i.estimate({ from: i.wallet, to: i.usdc, data: approve }), DEFAULT_GAS.approve),
      tx(i, 2, "deposit", `Supply ${i.assets} USDC raw to ${i.venue.name}`, MORPHO_BLUE, sup, null, DEFAULT_GAS.enter),
    ];
  },
  async prepareWithdraw(i) {
    const h = i.holding!;
    const params = await readMarketParams(i.call, i.venue.source.marketId!, i.block);
    const whole = i.all || i.assets >= h.assets;
    // the whole position leaves by SHARES (no dust); a part leaves by assets
    const data = encodeFunctionData({ abi: morpho, functionName: "withdraw", args: [params, whole ? 0n : i.assets, whole ? h.shares : 0n, i.wallet, i.wallet] });
    return [tx(i, 1, "withdraw", `Withdraw ${whole ? "all supply" : `${i.assets} USDC raw`} from ${i.venue.name}`, MORPHO_BLUE, data, await i.estimate({ from: i.wallet, to: MORPHO_BLUE, data }), DEFAULT_GAS.exit)];
  },
};

/** Centrifuge vaults are ERC-7540: deposits and redeems are REQUESTS that settle in a later epoch. They are read and compared, never routed to. */
const centrifuge: Adapter = {
  protocol: "centrifuge",
  protocolName: "Centrifuge",
  ...base,
  async prepareDeposit(i) {
    throw new NotPreparable(`${i.venue.name} is an asynchronous (ERC-7540) vault: a deposit is a request settled in a later epoch for approved investors, so no one-shot deposit can be prepared`);
  },
  async prepareWithdraw(i) {
    throw new NotPreparable(`${i.venue.name} is an asynchronous (ERC-7540) vault: a redeem is a request settled in a later epoch, so no one-shot withdrawal can be prepared`);
  },
};

export const ADAPTERS: Record<ProtocolId, Adapter> = {
  rockawayx: vault("rockawayx", "RockawayX"),
  morpho: morphoAdapter,
  centrifuge,
  testvault: vault("testvault", "Test vaults"),
};

export function protocolOf(s: Source): ProtocolId {
  if (s.kind === "morpho") return "morpho";
  if (s.kind === "centrifuge") return "centrifuge";
  if (s.kind === "testvault") return "testvault";
  return "rockawayx";
}

export const venuesFromSources = (sources: Source[]): Venue[] =>
  sources.map((s) => {
    const a = ADAPTERS[protocolOf(s)];
    return { id: s.key, protocol: a.protocol, protocolName: a.protocolName, name: s.name, source: s };
  });

// ---------------------------------------------------------------- a plan, and what a wallet checks before signing it

export interface PlanLeg {
  venue: string;
  name: string;
  contract: Hex;
  protocol: ProtocolId;
  /** USDC raw units. */
  assets: string;
  /** A withdrawal of the whole position. */
  all: boolean;
}

export interface ActionPlan {
  kind: "unsigned-action-plan";
  signed: false;
  note: string;
  request: "deposit" | "withdraw";
  chainId: number;
  wallet: Hex;
  legs: PlanLeg[];
  transactions: ActionTx[];
  /** Fingerprint of the requests, so the wallet can check it signs what was shown. */
  planId: Hex;
}

export const planFingerprint = (txs: ActionTx[]): Hex => keccak256(toHex(JSON.stringify(txs.map((t) => t.request))));

export function buildPlan(request: ActionPlan["request"], chainId: number, wallet: Hex, legs: PlanLeg[], txs: ActionTx[]): ActionPlan {
  const transactions = txs.map((t, n) => ({ ...t, step: n + 1 }));
  return {
    kind: "unsigned-action-plan",
    signed: false,
    note: "Prepared for the wallet owner's signature. This file holds no key and nothing in it has been signed or sent; the wallet shows each transaction and the owner signs it.",
    request,
    chainId,
    wallet: getAddress(wallet),
    legs,
    transactions,
    planId: planFingerprint(transactions),
  };
}

/**
 * What a wallet checks before it signs: it decodes the calldata itself (a description or a fingerprint proves nothing, anyone who
 * edits a plan can recompute both). Money may only move from the owner, into a venue listed in the plan, for the amounts the legs
 * name, and withdrawals may only pay the owner. Returns the problems found.
 */
export function verifyActionPlan(plan: ActionPlan, usdc: Hex): string[] {
  const bad: string[] = [];
  const me = plan.wallet.toLowerCase();
  const same = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();
  if (planFingerprint(plan.transactions) !== plan.planId) bad.push("the fingerprint does not match the transactions");
  const want = new Map(plan.legs.map((l) => [l.venue, l]));
  const seen = new Map<string, { approved: bigint; moved: bigint }>();
  for (const t of plan.transactions) {
    const leg = want.get(t.venue);
    if (!leg) {
      bad.push(`step ${t.step}: venue ${t.venue} is not one of the plan's legs`);
      continue;
    }
    if (!same(t.request.from, me)) bad.push(`step ${t.step}: sent from ${t.request.from}, not the owner ${plan.wallet}`);
    if (t.request.value !== "0x0") bad.push(`step ${t.step}: carries value ${t.request.value}`);
    if (t.request.chainId !== toHex(plan.chainId)) bad.push(`step ${t.step}: chain id ${t.request.chainId}`);
    const acc = seen.get(t.venue) ?? { approved: 0n, moved: 0n };
    seen.set(t.venue, acc);
    const target = leg.protocol === "morpho" ? MORPHO_BLUE : leg.contract;
    try {
      if (t.action === "approve") {
        const d = decodeFunctionData({ abi: erc20, data: t.request.data });
        if (d.functionName !== "approve" || !same(t.request.to, usdc)) bad.push(`step ${t.step}: an approval must be a USDC approve()`);
        else {
          if (!same(d.args![0], target)) bad.push(`step ${t.step}: approves ${d.args![0]}, not the venue ${target}`);
          acc.approved = d.args![1] as bigint;
          if (String(d.args![1]) !== leg.assets) bad.push(`step ${t.step}: approves ${d.args![1]}, the leg is ${leg.assets}`);
        }
      } else if (t.action === "deposit") {
        if (plan.request !== "deposit") bad.push(`step ${t.step}: a deposit inside a ${plan.request} plan`);
        if (!same(t.request.to, target)) bad.push(`step ${t.step}: goes to ${t.request.to}, not ${leg.name} (${target})`);
        if (leg.protocol === "morpho") {
          const d = decodeFunctionData({ abi: morpho, data: t.request.data });
          if (d.functionName !== "supply") bad.push(`step ${t.step}: calls ${d.functionName}, not supply`);
          else {
            if (!same(d.args![3], me)) bad.push(`step ${t.step}: supplies on behalf of someone other than the owner`);
            if (String(d.args![1]) !== leg.assets) bad.push(`step ${t.step}: supplies ${d.args![1]}, the leg is ${leg.assets}`);
            acc.moved = d.args![1] as bigint;
          }
        } else {
          const d = decodeFunctionData({ abi: erc4626, data: t.request.data });
          if (d.functionName !== "deposit") bad.push(`step ${t.step}: calls ${d.functionName}, not deposit`);
          else {
            if (!same(d.args![1], me)) bad.push(`step ${t.step}: deposits for someone other than the owner`);
            if (String(d.args![0]) !== leg.assets) bad.push(`step ${t.step}: deposits ${d.args![0]}, the leg is ${leg.assets}`);
            acc.moved = d.args![0] as bigint;
          }
        }
      } else {
        if (plan.request !== "withdraw") bad.push(`step ${t.step}: a withdrawal inside a ${plan.request} plan`);
        if (!same(t.request.to, target)) bad.push(`step ${t.step}: goes to ${t.request.to}, not ${leg.name} (${target})`);
        if (leg.protocol === "morpho") {
          const d = decodeFunctionData({ abi: morpho, data: t.request.data });
          if (d.functionName !== "withdraw") bad.push(`step ${t.step}: calls ${d.functionName}, not withdraw`);
          else if (!same(d.args![3], me) || !same(d.args![4], me)) bad.push(`step ${t.step}: withdraws to or on behalf of someone other than the owner`);
        } else {
          const d = decodeFunctionData({ abi: erc4626, data: t.request.data });
          if (d.functionName !== "redeem") bad.push(`step ${t.step}: calls ${d.functionName}, not redeem`);
          else if (!same(d.args![1], me) || !same(d.args![2], me)) bad.push(`step ${t.step}: redeems to or from someone other than the owner`);
        }
      }
    } catch (e) {
      bad.push(`step ${t.step}: calldata is not what a ${t.action} uses (${((e as Error).message ?? "").split("\n")[0]})`);
    }
  }
  if (plan.request === "deposit") {
    for (const l of plan.legs) {
      const s = seen.get(l.venue);
      if (!s || s.approved !== BigInt(l.assets) || s.moved !== BigInt(l.assets)) bad.push(`leg ${l.name}: needs one approve and one deposit of ${l.assets}`);
    }
  } else if (plan.transactions.length !== plan.legs.length) bad.push("a withdrawal plan is one transaction per leg");
  return bad;
}
