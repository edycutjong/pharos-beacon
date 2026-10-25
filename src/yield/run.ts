import { getAddress, type Hex } from "viem";
import { secondsPerBlock } from "../arb/backtest.js";
import { headerAt, type Call } from "../portfolio/read.js";
import { DEFAULT_RATE_OPTIONS, rateView, recommend, type Held, type Params, type RateOptions, type Recommendation, type Target, type Window } from "./model.js";
import { NotPlannable, planMove, totalGas, DEFAULT_GAS, type MovePlan } from "./plan.js";
import { holdingOf, readSource, windowSamples, type Ev, type Holding, type Reading, type Source } from "./sources.js";

// One analysis: read every source at one block, work out what moving would cost, decide, and (only for a MOVE) prepare the
// unsigned transactions. Read-only by construction: `call` is a Chain MCP client and this module has no signer.

export interface AnalyseOptions {
  call: Call;
  chainId: number;
  network: "pharos" | "atlantic";
  wallet: Hex;
  sources: Source[];
  usdc: Hex;
  assetDecimals: number;
  windows: Window[];
  holdDays: number;
  minNetUsd: number;
  slippageBps: number;
  /** USD value of one unit of the chain's native gas token, and where that number came from. */
  nativeUsd: { value: number; basis: string };
  block?: bigint;
  rate?: RateOptions;
  /** Sources skipped before the run (e.g. Morpho markets that do not lend USDC), shown in the report. */
  skipped?: string[];
}

export interface Report {
  network: "pharos" | "atlantic";
  chainId: number;
  wallet: Hex;
  block: bigint;
  timestamp: bigint;
  secondsPerBlock: number;
  windows: Window[];
  params: Params & { slippageBps: number; haircut: number };
  gas: { priceWei: bigint; nativeUsd: number; nativeBasis: string };
  held: { source: Source; holding: Holding; others: { source: Source; assets: bigint }[] };
  readings: Reading[];
  unreadable: { source: Source; reason: string }[];
  /** Sources whose balance for the wallet could not be read: a position there is NOT considered. */
  holdingErrors: { source: Source; reason: string }[];
  skipped: string[];
  heldView: Held;
  targets: (Target & { reading: Reading; gasUnits: number; gasBasis: string })[];
  recommendation: Recommendation;
  plan: MovePlan | null;
  planNote: string | null;
  evidence: Ev[];
}

export class NoPosition extends Error {
  override name = "NoPosition";
}

const toUsd = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

export async function analyse(o: AnalyseOptions): Promise<Report> {
  const rateOpts = o.rate ?? DEFAULT_RATE_OPTIONS;
  const head = await headerAt(o.call, o.block);
  const spb = await secondsPerBlock(o.call, head.block);
  const samples = await windowSamples(o.call, head, o.windows, spb);
  if (samples.length < o.windows.length) throw new Error(`the chain is younger than the longest window (${o.windows[o.windows.length - 1]!.label}); use shorter --windows`);
  const evidence: Ev[] = [];

  // 1. what does the wallet hold?
  const holdings: { source: Source; holding: Holding }[] = [];
  const holdingErrors: Report["holdingErrors"] = [];
  for (const s of o.sources) {
    try {
      const h = await holdingOf(o.call, s, o.wallet, head.block, head.timestamp, evidence);
      if (h && h.assets > 0n) holdings.push({ source: s, holding: h });
    } catch (e) {
      holdingErrors.push({ source: s, reason: ((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 160) });
    }
  }
  if (!holdings.length && holdingErrors.length) throw new Error(`could not read the wallet's balance in ${holdingErrors.map((h) => `${h.source.name} (${h.reason})`).join("; ")}, so it cannot be said what the wallet holds`);
  if (!holdings.length) throw new NoPosition(`wallet ${o.wallet} holds nothing in any of the ${o.sources.length} sources (${o.sources.map((s) => s.name).join(", ")}) at block ${head.block}`);
  holdings.sort((a, b) => (b.holding.assets > a.holding.assets ? 1 : -1));
  const cur = holdings[0]!;

  // 2. read every source in full
  const readings: Reading[] = [];
  const unreadable: Report["unreadable"] = [];
  for (const s of o.sources) {
    try {
      const r = await readSource(s, { call: o.call, wallet: o.wallet, head: { block: head.block, timestamp: head.timestamp }, samples, amount: cur.holding.assets, heldShares: s.key === cur.source.key ? cur.holding.shares : undefined, assetDecimals: o.assetDecimals, usdc: o.usdc });
      readings.push(r);
      evidence.push(...r.evidence);
    } catch (e) {
      unreadable.push({ source: s, reason: ((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 160) });
    }
  }
  const heldReading = readings.find((r) => r.source.key === cur.source.key);
  if (!heldReading) throw new Error(`the position in ${cur.source.name} could not be read: ${unreadable.find((u) => u.source.key === cur.source.key)?.reason ?? "unknown"}`);

  // 3. gas
  const gp = (await o.call("get_gas_price")) as { gasPriceWei: string };
  const priceWei = BigInt(gp.gasPriceWei);
  const estimate = async (tx: { from: Hex; to: Hex; data: Hex }): Promise<number | null> => {
    try {
      const r = (await o.call("estimate_gas", { transaction: tx })) as { gas: string };
      return Number(r.gas);
    } catch {
      return null;
    }
  };
  const usdOfGas = (units: number) => ((Number(priceWei) * units) / 1e18) * o.nativeUsd.value;

  const heldView: Held = {
    key: cur.source.key,
    name: cur.source.name,
    usd: toUsd(cur.holding.assets, o.assetDecimals),
    rate: rateView(heldReading.windows, rateOpts),
    exitFeeBps: heldReading.exit.feeBps,
    exitBlockers: heldReading.exit.blockers,
  };
  const proceeds = heldReading.exit.feeBps === null ? cur.holding.assets : (cur.holding.assets * BigInt(10_000 * 100 - Math.round(heldReading.exit.feeBps * 100))) / 1_000_000n;

  const targets: Report["targets"] = [];
  const plans = new Map<string, MovePlan>();
  for (const r of readings) {
    if (r.source.key === cur.source.key) continue;
    let units = DEFAULT_GAS.exit + DEFAULT_GAS.approve + DEFAULT_GAS.enter;
    let basis = "configured";
    if (heldReading.exit.blockers.length === 0 || r.source.kind !== "centrifuge") {
      try {
        const plan = await planMove({ call: o.call, chainId: o.chainId, wallet: o.wallet, usdc: o.usdc, from: cur.source, to: r.source, shares: cur.holding.shares, proceeds, slippageBps: o.slippageBps, block: head.block, estimate });
        plans.set(r.source.key, plan);
        units = totalGas(plan);
        basis = plan.transactions.map((t) => `${t.action}:${t.gas.basis}`).join(", ");
      } catch (e) {
        if (!(e instanceof NotPlannable)) throw e;
      }
    }
    // a Morpho market pays its suppliers the borrowers' interest: our deposit shares it out, so the rate we would earn is lower
    const dilution = r.source.kind === "morpho" && r.tvl !== null && r.tvl > 0n ? Number(r.tvl) / (Number(r.tvl) + Number(proceeds)) : 1;
    targets.push({ key: r.source.key, name: r.source.name, rate: rateView(r.windows, rateOpts), entryFeeBps: r.entry.feeBps, lockSeconds: r.lockSeconds, entryBlockers: r.entry.blockers, gasUsd: usdOfGas(units), dilution, reading: r, gasUnits: units, gasBasis: basis });
  }
  const params: Params = { holdDays: o.holdDays, minNetUsd: o.minNetUsd };
  const recommendation = recommend(heldView, targets, params);
  // what the decision did NOT see
  const unseen = [...unreadable.map((u) => `${u.source.name} (${u.reason})`), ...holdingErrors.map((h) => `a position in ${h.source.name} (balance unreadable: ${h.reason})`)];
  if (unseen.length) recommendation.reason += `; NOT CONSIDERED because it could not be read: ${unseen.join("; ")}`;
  let plan: MovePlan | null = null;
  let planNote: string | null = null;
  if (recommendation.decision === "MOVE") {
    plan = plans.get(recommendation.best!.key) ?? null;
    if (!plan) planNote = "the destination cannot be planned as one-shot transactions";
  } else {
    planNote = "no transactions prepared: the recommendation is to stay put";
  }
  return {
    network: o.network,
    chainId: o.chainId,
    wallet: getAddress(o.wallet),
    block: head.block,
    timestamp: head.timestamp,
    secondsPerBlock: spb,
    windows: o.windows,
    params: { ...params, slippageBps: o.slippageBps, haircut: rateOpts.haircut },
    gas: { priceWei, nativeUsd: o.nativeUsd.value, nativeBasis: o.nativeUsd.basis },
    held: { source: cur.source, holding: cur.holding, others: holdings.slice(1).map((h) => ({ source: h.source, assets: h.holding.assets })) },
    readings,
    unreadable,
    holdingErrors,
    skipped: o.skipped ?? [],
    heldView,
    targets,
    recommendation,
    plan,
    planNote,
    evidence,
  };
}
