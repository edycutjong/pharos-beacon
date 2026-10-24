import { getAddress, type Hex } from "viem";
import { secondsPerBlock } from "../arb/backtest.js";
import { headerAt, type Call } from "../portfolio/read.js";
import { DEFAULT_RATE_OPTIONS, rateView, type RateOptions, type Window } from "../yield/model.js";
import { rd, windowSamples, type Ev } from "../yield/sources.js";
import { ADAPTERS, NotPreparable, buildPlan, redeemShares, verifyActionPlan, type ActionPlan, type ActionTx, type PlanLeg, type ProtocolId, type Venue } from "./adapters.js";
import { routeDeposit, routeWithdraw, type Down, type Route, type RouteParams, type VenueView } from "./route.js";

// One analysis: read every venue of every protocol at ONE block, each behind its own guard, then answer the request. A venue that
// throws (or hangs) is recorded as `down` and the others are still read, compared and routed: one protocol being unavailable never
// breaks the rest. Read-only by construction: `call` is a Chain MCP client and this module has no signer.

export type Request =
  | { kind: "positions" }
  | { kind: "rates" }
  | { kind: "deposit"; assets: bigint }
  | { kind: "withdraw"; assets: bigint | "all" };

export interface AggregateOptions {
  call: Call;
  chainId: number;
  network: "pharos" | "atlantic";
  wallet: Hex;
  venues: Venue[];
  usdc: Hex;
  assetDecimals: number;
  windows: Window[];
  holdDays: number;
  nativeUsd: { value: number; basis: string };
  request: Request;
  block?: bigint;
  rate?: RateOptions;
  /** Protocols (or single venues, by id) to treat as down WITHOUT contacting them (an outage drill, labelled SIMULATED everywhere it shows). */
  down?: string[];
  /** A venue that has not answered after this many ms counts as down. */
  venueTimeoutMs?: number;
  /** Skip the check that the wallet holds the USDC it is told to deposit (the plan then says so). */
  assumeFunded?: boolean;
  /** USDC to size entry checks with when the request names no amount (a query), raw units. */
  referenceAssets?: bigint;
  skipped?: string[];
}

export class InsufficientFunds extends Error {
  override name = "InsufficientFunds";
}

export interface Report {
  network: "pharos" | "atlantic";
  chainId: number;
  wallet: Hex;
  block: bigint;
  timestamp: bigint;
  secondsPerBlock: number;
  windows: Window[];
  holdDays: number;
  haircut: number;
  gas: { priceWei: bigint; nativeUsd: number; nativeBasis: string };
  request: Request;
  referenceAssets: bigint;
  views: VenueView[];
  down: Down[];
  venues: Venue[];
  skipped: string[];
  route: Route | null;
  plan: ActionPlan | null;
  planNote: string | null;
  funded: { balance: bigint; assumed: boolean } | null;
  evidence: Ev[];
}

const msg = (e: unknown) => ((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 200);

function guarded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} did not answer within ${ms} ms`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

class SimulatedOutage extends Error {}

export async function aggregate(o: AggregateOptions): Promise<Report> {
  const rateOpts = o.rate ?? DEFAULT_RATE_OPTIONS;
  const head = await headerAt(o.call, o.block);
  const spb = await secondsPerBlock(o.call, head.block);
  const samples = await windowSamples(o.call, head, o.windows, spb);
  if (samples.length < o.windows.length) throw new Error(`the chain is younger than the longest window (${o.windows[o.windows.length - 1]!.label}); use shorter --windows`);
  const evidence: Ev[] = [];
  const timeoutMs = o.venueTimeoutMs ?? 120_000;
  const reference = o.referenceAssets ?? 1_000n * 10n ** BigInt(o.assetDecimals);
  const simulated = new Set(o.down ?? []);
  const dec = 10 ** o.assetDecimals;

  const probe = BigInt(dec);
  // a deposit or a withdrawal probes every venue with a small amount (does it take it at all, at what fee); how MUCH each can take
  // out or in is routed separately, from maxDeposit / the position / a Morpho market's idle liquidity, so a venue with a limit stays in
  // the running and takes its share. Queries are sized with the reference amount.
  const sizeFor = (h: { assets: bigint } | null): bigint => {
    if (o.request.kind === "deposit") return o.request.assets < probe ? o.request.assets : probe;
    if (o.request.kind === "withdraw") return h ? (h.assets < probe ? h.assets : probe) : probe;
    return h ? h.assets : reference;
  };

  const views: VenueView[] = [];
  const down: Down[] = [];
  for (const v of o.venues) {
    const a = ADAPTERS[v.protocol];
    try {
      if (simulated.has(v.protocol) || simulated.has(v.id)) throw new SimulatedOutage(simulated.has(v.id) ? `outage drill (--down ${v.id}): this venue was not contacted` : `outage drill (--down ${v.protocol}): ${v.protocolName} was not contacted`);
      const h = await guarded(a.holding(o.call, v, o.wallet, head.block, head.timestamp), timeoutMs, `${v.name} balance`);
      const r = await guarded(a.read(v, { call: o.call, wallet: o.wallet, head: { block: head.block, timestamp: head.timestamp }, samples, amount: sizeFor(h), heldShares: h?.shares, assetDecimals: o.assetDecimals, usdc: o.usdc, amountNote: o.request.kind === "deposit" ? " probe deposit" : o.request.kind === "withdraw" ? " probe withdrawal" : undefined }), timeoutMs, v.name);
      views.push({ venue: v, reading: r, rate: rateView(r.windows, rateOpts), holding: h && h.assets > 0n ? h : null });
      evidence.push(...r.evidence);
    } catch (e) {
      down.push({ venue: v, reason: msg(e), simulated: e instanceof SimulatedOutage });
    }
  }
  if (!views.length) throw new Error(`no venue answered (${down.map((d) => `${d.venue.name}: ${d.reason}`).join("; ")})`);

  const gp = (await o.call("get_gas_price")) as { gasPriceWei: string };
  const priceWei = BigInt(gp.gasPriceWei);
  const params: RouteParams = { holdDays: o.holdDays, usdPerGas: (Number(priceWei) / 1e18) * o.nativeUsd.value, assetDecimals: o.assetDecimals };
  const estimate = async (tx: { from: Hex; to: Hex; data: Hex }): Promise<number | null> => {
    try {
      return Number(((await o.call("estimate_gas", { transaction: tx })) as { gas: string }).gas);
    } catch {
      return null;
    }
  };

  let route: Route | null = null;
  let plan: ActionPlan | null = null;
  let planNote: string | null = null;
  let funded: Report["funded"] = null;
  const req = o.request;
  if (req.kind === "deposit" || req.kind === "withdraw") {
    if (req.kind === "deposit") {
      const balance = (await rd(o.call, o.usdc, "balanceOf(address) view returns (uint256)", [o.wallet], head.block)) as bigint;
      funded = { balance, assumed: !!o.assumeFunded && balance < req.assets };
      if (balance < req.assets && !o.assumeFunded) throw new InsufficientFunds(`wallet ${o.wallet} holds ${Number(balance) / dec} USDC at block ${head.block}, less than the ${Number(req.assets) / dec} to deposit (use --assume-funded to prepare the plan anyway; it would revert until the wallet is funded)`);
      route = routeDeposit(views, down, Number(req.assets) / dec, params);
    } else route = routeWithdraw(views, down, req.assets === "all" ? "all" : Number(req.assets) / dec, params);

    if (!route.allocations.length) planNote = "no transactions prepared: no venue can take the request";
    else {
      // raw amounts per leg: the last leg gets the remainder so the legs add up to the request exactly
      const total = req.kind === "deposit" ? req.assets : null;
      let placed = 0n;
      const legs: PlanLeg[] = [];
      const txs: ActionTx[] = [];
      try {
        for (const [n, al] of route.allocations.entries()) {
          const view = views.find((x) => x.venue.id === al.venueId)!;
          const a = ADAPTERS[view.venue.protocol];
          let assets: bigint;
          if (req.kind === "deposit") assets = n === route.allocations.length - 1 && route.unplacedUsd < 1e-9 ? total! - placed : BigInt(Math.round(al.usd * dec));
          else assets = al.all ? view.holding!.assets : BigInt(Math.round(al.usd * dec));
          if (req.kind === "withdraw" && req.assets !== "all" && n === route.allocations.length - 1 && route.unplacedUsd < 1e-9) assets = req.assets - placed;
          placed += assets;
          const whole = req.kind === "withdraw" && (al.all || assets >= view.holding!.assets);
          const input = { call: o.call, chainId: o.chainId, wallet: o.wallet, usdc: o.usdc, venue: view.venue, assets, all: whole, holding: view.holding ?? undefined, block: head.block, estimate };
          const shares = req.kind === "withdraw" ? (view.venue.protocol === "morpho" ? (whole ? view.holding!.shares : 0n) : redeemShares(assets, view.holding!, whole)) : undefined;
          legs.push({ venue: view.venue.id, name: view.venue.name, contract: view.venue.source.contract, protocol: view.venue.protocol, assets: assets.toString(), all: whole, ...(shares !== undefined ? { shares: shares.toString() } : {}), ...(view.venue.protocol === "morpho" ? { market: view.venue.source.marketId } : {}) });
          txs.push(...(await (req.kind === "deposit" ? a.prepareDeposit(input) : a.prepareWithdraw(input))));
        }
        plan = buildPlan(req.kind, o.chainId, o.wallet, legs, txs);
        const bad = verifyActionPlan(plan, o.usdc);
        if (bad.length) throw new Error(`the prepared plan fails its own wallet-side check, so it is not shown: ${bad.join("; ")}`);
      } catch (e) {
        if (!(e instanceof NotPreparable)) throw e;
        plan = null;
        planNote = e.message;
      }
      if (plan && req.kind === "withdraw" && req.assets === "all" && down.length) planNote = `"all" covers only the venues that answered: ${[...new Set(down.map((d) => d.venue.name))].join(", ")} did not, so whatever the wallet holds there is not in this plan`;
      if (plan && route.unplacedUsd > 1e-9) planNote = `the plan covers only part of the request: ${route.unplacedUsd.toFixed(2)} USD could not be placed`;
    }
  }

  return {
    network: o.network,
    chainId: o.chainId,
    wallet: getAddress(o.wallet),
    block: head.block,
    timestamp: head.timestamp,
    secondsPerBlock: spb,
    windows: o.windows,
    holdDays: o.holdDays,
    haircut: rateOpts.haircut,
    gas: { priceWei, nativeUsd: o.nativeUsd.value, nativeBasis: o.nativeUsd.basis },
    request: req,
    referenceAssets: reference,
    views,
    down,
    venues: o.venues,
    skipped: o.skipped ?? [],
    route,
    plan,
    planNote,
    funded,
    evidence,
  };
}
