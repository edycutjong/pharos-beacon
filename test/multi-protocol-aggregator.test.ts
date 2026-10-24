import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, parseAbi, type Hex } from "viem";
import { UsageError } from "../src/lib/cli.js";
import { MORPHO_BLUE } from "../src/liq/morpho.js";
import { ADAPTERS, NotPreparable, buildPlan, verifyActionPlan, venuesFromSources, type ActionPlan, type Venue } from "../src/aggregator/adapters.js";
import { renderReport } from "../src/aggregator/format.js";
import { routeDeposit, routeWithdraw, type Down, type VenueView } from "../src/aggregator/route.js";
import { InsufficientFunds, aggregate, type AggregateOptions } from "../src/aggregator/run.js";
import { rateView, parseWindows, type WindowRate } from "../src/yield/model.js";
import { erc20, erc4626, morpho as morphoAbi } from "../src/yield/plan.js";
import type { Reading, Source } from "../src/yield/sources.js";
import { main } from "../tasks/multi-protocol-aggregator/index.js";

const ME = getAddress("0x1111111111111111111111111111111111111111");
const USDC = getAddress("0x2222222222222222222222222222222222222222");
const ROX = getAddress("0x00000000000000000000000000000000000000a1");
const CEN = getAddress("0x00000000000000000000000000000000000000c1");
const IRM = getAddress("0x00000000000000000000000000000000000000d1");
const MID = ("0x" + "ab".repeat(32)) as Hex;
const HEAD = 5_000_000n; // 1 s blocks, so a block number is also its timestamp
const MILLION = 10n ** 12n; // 1,000,000 USDC raw

// ---------------------------------------------------------------- the router, on hand-made readings

const win = (label: string, apr: number | null, seconds = 1): WindowRate => ({ label, seconds, apr });
const rate = (apr: number) => rateView([win("1d", apr, 86_400), win("7d", apr, 604_800), win("30d", apr, 2_592_000)]);
const src = (key: string, kind: Source["kind"]): Source => ({ key, name: `Venue ${key}`, kind, contract: ROX, ...(kind === "morpho" ? { marketId: MID } : {}) });
const reading = (s: Source, o: { entryBps?: number | null; exitBps?: number | null; maxDeposit?: bigint | null; entryBlockers?: string[]; exitBlockers?: string[]; tvl?: bigint; depth?: bigint | null } = {}): Reading =>
  ({
    source: s,
    tvl: o.tvl ?? 10n * MILLION,
    entry: { feeBps: o.entryBps === undefined ? 0 : o.entryBps, maxDeposit: o.maxDeposit === undefined ? null : o.maxDeposit, blockers: o.entryBlockers ?? [], note: "" },
    exit: { feeBps: o.exitBps === undefined ? 0 : o.exitBps, depth: o.depth === undefined ? null : o.depth, lockedUntil: null, blockers: o.exitBlockers ?? [], note: "" },
    windows: [],
    samples: [],
    lockSeconds: 0,
    evidence: [],
  }) as unknown as Reading;
function view(key: string, kind: Source["kind"], apr: number, o: Parameters<typeof reading>[1] & { held?: bigint } = {}): VenueView {
  const s = src(key, kind);
  const [v] = venuesFromSources([s]);
  return { venue: v!, reading: reading(s, o), rate: rate(apr), holding: o.held ? { shares: o.held, assets: o.held } : null };
}
const P = { holdDays: 30, usdPerGas: 1e-7, assetDecimals: 6 };

describe("routeDeposit", () => {
  it("picks the venue with the best net yield and says why, with the runner-up", () => {
    const r = routeDeposit([view("a", "erc4626", 0.04), view("b", "morpho", 0.06), view("c", "erc4626", 0.05, { entryBps: 100 })], [], 10_000, P);
    expect(r.allocations.map((a) => a.venueId)).toEqual(["b"]);
    expect(r.explanation[0]).toContain("Chose Venue b (Morpho Blue)");
    expect(r.explanation[0]).toMatch(/entry fee \$0\.00/);
    expect(r.explanation[1]).toContain("Next best: Venue a");
  });
  it("charges the entry fee and the gas against the yield", () => {
    // 5 % but a 100 bps entry fee over 30 d loses to a 4 % venue with no fee
    const r = routeDeposit([view("fee", "erc4626", 0.05, { entryBps: 100 }), view("free", "erc4626", 0.04)], [], 10_000, P);
    expect(r.allocations[0]!.venueId).toBe("free");
    const fee = r.options.find((o) => o.venueId === "fee")!;
    expect(fee.parts.entryFeeUsd).toBeCloseTo(100, 6);
  });
  it("dilutes a Morpho rate by the deposit, so a big deposit can lose to a vault", () => {
    const small = routeDeposit([view("m", "morpho", 0.06, { tvl: 100_000n * 10n ** 6n }), view("v", "erc4626", 0.055)], [], 1_000, P);
    expect(small.allocations[0]!.venueId).toBe("m");
    const big = routeDeposit([view("m", "morpho", 0.06, { tvl: 100_000n * 10n ** 6n }), view("v", "erc4626", 0.055)], [], 100_000, P);
    expect(big.allocations[0]!.venueId).toBe("v"); // 6 % × 100k/(100k+100k) = 3 %
    expect(big.options.find((o) => o.venueId === "m")!.parts.dilution).toBeCloseTo(0.5, 9);
  });
  it("never routes to a venue with a blocker, and lists it with the reason", () => {
    const r = routeDeposit([view("a", "erc4626", 0.04), view("async", "centrifuge", 0.09, { entryBlockers: ["deposit is an asynchronous request"] })], [], 1_000, P);
    expect(r.allocations.map((a) => a.venueId)).toEqual(["a"]);
    expect(r.explanation.join("\n")).toContain("Not eligible: Venue async (Centrifuge): deposit is an asynchronous request");
  });
  it("splits across venues when the best one has a limit", () => {
    const r = routeDeposit([view("small", "erc4626", 0.09, { maxDeposit: 400n * 10n ** 6n }), view("big", "erc4626", 0.05)], [], 1_000, P);
    expect(r.allocations.map((a) => [a.venueId, Math.round(a.usd)])).toEqual([["small", 400], ["big", 600]]);
    expect(r.explanation.join("\n")).toContain("takes at most $400.00");
    expect(r.unplacedUsd).toBe(0);
  });
  it("says so when nobody can take it", () => {
    const r = routeDeposit([view("a", "erc4626", 0.04, { entryBlockers: ["paused"] })], [], 1_000, P);
    expect(r.allocations).toEqual([]);
    expect(r.explanation[0]).toContain("No venue can take $1,000.00");
  });
  it("does not rank a venue whose rate is unreadable", () => {
    const v = view("x", "erc4626", 0.04);
    v.rate = rateView([win("1d", null)]);
    const r = routeDeposit([v, view("y", "erc4626", 0.01)], [], 1_000, P);
    expect(r.allocations[0]!.venueId).toBe("y");
    expect(r.options.find((o) => o.venueId === "x")!.reasons[0]).toContain("no rate could be read");
  });
  it("names an unavailable protocol and routes without it", () => {
    const [dv] = venuesFromSources([src("m", "morpho")]);
    const down: Down[] = [{ venue: dv!, reason: "outage drill (--down morpho)", simulated: true }];
    const r = routeDeposit([view("a", "erc4626", 0.04)], down, 1_000, P);
    expect(r.explanation.join("\n")).toContain("SIMULATED OUTAGE: Venue m (Morpho Blue)");
    expect(r.allocations.map((a) => a.venueId)).toEqual(["a"]);
  });
});

describe("routeWithdraw", () => {
  it("takes the money out where leaving costs least: the lowest-yielding position first", () => {
    const r = routeWithdraw([view("hi", "erc4626", 0.09, { held: 5n * MILLION }), view("lo", "morpho", 0.03, { held: 5n * MILLION })], [], 1_000_000, P);
    expect(r.allocations.map((a) => a.venueId)).toEqual(["lo"]);
    expect(r.explanation[0]).toContain("yield given up");
    expect(r.explanation[1]).toContain("Next cheapest: Venue hi");
  });
  it("counts the exit fee against a venue", () => {
    const r = routeWithdraw([view("fee", "erc4626", 0.03, { held: 5n * MILLION, exitBps: 300 }), view("hi", "erc4626", 0.04, { held: 5n * MILLION })], [], 100_000, P);
    expect(r.allocations[0]!.venueId).toBe("hi"); // 3 % of 100k = $3,000 fee beats the 1 % yield difference
  });
  it("skips a blocked exit and says why, and uses the other", () => {
    const r = routeWithdraw([view("locked", "erc4626", 0.01, { held: 5n * MILLION, exitBlockers: ["locked until 2026-12-01"] }), view("open", "erc4626", 0.09, { held: 5n * MILLION })], [], 1_000, P);
    expect(r.allocations.map((a) => a.venueId)).toEqual(["open"]);
    expect(r.explanation.join("\n")).toContain("Cannot withdraw from Venue locked");
    expect(r.explanation.join("\n")).toContain("locked until 2026-12-01");
  });
  it("splits when no single venue holds enough, and sizes a Morpho exit by the market's idle liquidity", () => {
    const r = routeWithdraw([view("a", "erc4626", 0.03, { held: 600n * 10n ** 6n }), view("m", "morpho", 0.05, { held: 900n * 10n ** 6n, depth: 500n * 10n ** 6n })], [], 1_000, P);
    expect(r.allocations.map((a) => [a.venueId, Math.round(a.usd)])).toEqual([["a", 600], ["m", 400]]);
    expect(r.explanation.join("\n")).toContain("it is split");
  });
  it("'all' takes every position that can leave", () => {
    const r = routeWithdraw([view("a", "erc4626", 0.03, { held: 600n * 10n ** 6n }), view("b", "erc4626", 0.05, { held: 300n * 10n ** 6n })], [], "all", P);
    expect(r.amountUsd).toBe(900);
    expect(r.allocations.every((a) => a.all)).toBe(true);
  });
  it("says the position is unknown for a protocol that is down", () => {
    const [dv] = venuesFromSources([src("m", "morpho")]);
    const r = routeWithdraw([view("a", "erc4626", 0.03, { held: 600n * 10n ** 6n })], [{ venue: dv!, reason: "timed out", simulated: false }], 100, P);
    expect(r.explanation.join("\n")).toContain("Unavailable: Venue m (Morpho Blue): timed out. The wallet's position there is UNKNOWN");
  });
  it("reports an empty wallet", () => {
    expect(routeWithdraw([view("a", "erc4626", 0.03)], [], 100, P).explanation[0]).toContain("nothing to withdraw");
  });
});

// ---------------------------------------------------------------- a fake chain: an ERC-4626 vault, an async (Centrifuge-shaped) vault, a Morpho market

const abi = parseAbi([
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)",
  "function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)",
]);

interface FakeVault {
  price: (t: bigint) => number;
  shares?: bigint;
  async?: boolean;
  maxDeposit?: bigint;
  broken?: boolean;
  hang?: boolean;
}
interface FakeMorpho {
  apr: number;
  supplyShares?: bigint;
  broken?: boolean;
}

function chain(vaults: Record<string, FakeVault>, mo?: FakeMorpho, usdcBalance = 10_000n * 10n ** 6n) {
  const enc = (fn: string, v: unknown) => ({ result: encodeFunctionResult({ abi, functionName: fn as never, result: v as never }) });
  return (async (tool: string, args: Record<string, any> = {}) => {
    if (tool === "get_block_number") return { blockNumber: HEAD.toString() };
    if (tool === "get_block") return { timestamp: `0x${BigInt(args.block).toString(16)}`, number: args.block };
    if (tool === "get_gas_price") return { gasPriceWei: "10000000000" };
    if (tool === "estimate_gas") return { gas: "100000" };
    if (tool !== "eth_call") throw new Error(`fake chain: ${tool}`);
    const to = args.transaction.to as string;
    const d = decodeFunctionData({ abi, data: args.transaction.data as Hex });
    const at = BigInt(args.block ?? HEAD);
    if (to === USDC) {
      if (d.functionName === "balanceOf") return enc("balanceOf", usdcBalance);
      throw new Error("usdc: " + d.functionName);
    }
    if (to === MORPHO_BLUE || to === IRM) {
      if (!mo) throw new Error(`no contract at ${to}`);
      if (mo.broken) throw new Error("rpc down");
      const supply = BigInt(Math.round(Number(2n * MILLION) * (1 + (mo.apr * Number(at)) / (365 * 86_400))));
      const state = [supply, 2n * MILLION * 1_000_000n, supply / 2n, supply / 2n, at, 0n];
      switch (d.functionName) {
        case "idToMarketParams": return enc("idToMarketParams", [USDC, ROX, ROX, IRM, 860000000000000000n]);
        case "market": return enc("market", state);
        case "borrowRateView": return enc("borrowRateView", 0n);
        case "position": return enc("position", [mo.supplyShares ?? 0n, 0n, 0n]);
      }
      throw new Error("morpho: " + d.functionName);
    }
    const v = vaults[to];
    if (!v) throw new Error(`no contract at ${to}`);
    if (v.broken) throw new Error("rpc down");
    if (v.hang) return new Promise(() => {});
    const px = v.price(at);
    const toAssets = (s: bigint) => BigInt(Math.round((Number(s) / 1e18) * px * 1e12)) / 1_000_000n;
    const sharesOf = (a: bigint) => BigInt(Math.round((Number(a) / px / 1e6) * 1e18));
    switch (d.functionName) {
      case "asset": return enc("asset", USDC);
      case "decimals": return enc("decimals", 18);
      case "balanceOf": return enc("balanceOf", v.shares ?? 0n);
      case "totalAssets": return enc("totalAssets", 1_000_000_000n);
      case "convertToAssets": return enc("convertToAssets", (d.args![0] as bigint) >= 10n ** 24n ? BigInt(Math.round((Number(d.args![0] as bigint) / 1e24) * px * 1e12)) : toAssets(d.args![0] as bigint));
      case "convertToShares": return enc("convertToShares", sharesOf(d.args![0] as bigint));
      case "previewDeposit": if (v.async) throw new Error("eth_call: execution reverted: (code 3)"); return enc("previewDeposit", sharesOf(d.args![0] as bigint));
      case "previewRedeem": if (v.async) throw new Error("eth_call: execution reverted: (code 3)"); return enc("previewRedeem", toAssets(d.args![0] as bigint));
      case "maxDeposit": return enc("maxDeposit", v.async ? 0n : (v.maxDeposit ?? 10n ** 18n));
      case "maxRedeem": return enc("maxRedeem", v.shares ?? 0n);
      case "redeem": return enc("redeem", 1n);
    }
    throw new Error("vault: " + d.functionName);
  }) as never;
}
const growth = (apr: number) => (t: bigint) => 1 + (apr * Number(t)) / (365 * 86_400);
const SHARES = 1_000n * 10n ** 18n; // ≈ 1,000 USDC
const moSrc: Source = { key: "morpho-ab", name: "Morpho Blue TEST/USDC supply", kind: "morpho", contract: MORPHO_BLUE, marketId: MID };
const roxSrc: Source = { key: "rox", name: "RockawayX USDC vault", kind: "erc4626", contract: ROX, share: ROX };
const cenSrc: Source = { key: "cen", name: "Janus Test Fund", kind: "centrifuge", contract: CEN, share: CEN };
const venues = venuesFromSources([roxSrc, cenSrc, moSrc]);
const WINDOWS = parseWindows("1d,7d,30d");
const base = (call: any, request: AggregateOptions["request"], extra: Partial<AggregateOptions> = {}): AggregateOptions => ({ call, chainId: 1672, network: "pharos", wallet: ME, venues, usdc: USDC, assetDecimals: 6, windows: WINDOWS, holdDays: 30, nativeUsd: { value: 0.5, basis: "test" }, request, ...extra });
const world = () => chain({ [ROX]: { price: growth(0.04), shares: SHARES }, [CEN]: { price: growth(0.03), async: true } }, { apr: 0.06, supplyShares: 500n * 10n ** 6n * 1_000_000n });

describe("aggregate (fake chain: RockawayX-shaped vault, async fund vault, Morpho market)", () => {
  it("answers a positions query from all three protocols with one interface", async () => {
    const r = await aggregate(base(world(), { kind: "positions" }));
    expect(r.down).toEqual([]);
    expect(r.views.map((v) => v.venue.protocol).sort()).toEqual(["centrifuge", "morpho", "rockawayx"]);
    const held = r.views.filter((v) => v.holding).map((v) => v.venue.protocol).sort();
    expect(held).toEqual(["morpho", "rockawayx"]);
    const lines = renderReport(r).join("\n");
    expect(lines).toContain("RockawayX      UP · 1 of 1 venue answered");
    expect(lines).toContain("Morpho Blue    UP · 1 of 1 venue answered");
    expect(lines).toContain("YOU HOLD");
  });
  it("measures each venue's own rate from its share price", async () => {
    const r = await aggregate(base(world(), { kind: "rates" }));
    const apr = (k: string) => r.views.find((v) => v.venue.id === k)!.rate.ref!;
    expect(apr("rox")).toBeGreaterThan(0.035);
    expect(apr("rox")).toBeLessThan(0.0425);
    expect(apr("morpho-ab")).toBeGreaterThan(0.055);
    expect(apr("morpho-ab")).toBeLessThan(0.0605);
  });
  it("routes a deposit to the best eligible venue across protocols and never to the async one", async () => {
    const r = await aggregate(base(world(), { kind: "deposit", assets: 100n * 10n ** 6n }));
    expect(r.route!.allocations.map((a) => a.venueId)).toEqual(["morpho-ab"]);
    expect(r.route!.explanation.join("\n")).toContain("Not eligible: Janus Test Fund (Centrifuge)");
    const tx = r.plan!.transactions;
    expect(tx.map((t) => t.action)).toEqual(["approve", "deposit"]);
    expect(tx[1]!.request.to).toBe(MORPHO_BLUE);
    const d = decodeFunctionData({ abi: morphoAbi, data: tx[1]!.request.data });
    expect(d.functionName).toBe("supply");
    expect(d.args![1]).toBe(100n * 10n ** 6n);
    expect(String(d.args![3]).toLowerCase()).toBe(ME.toLowerCase());
    expect(verifyActionPlan(r.plan!, USDC)).toEqual([]);
    expect(r.plan!.signed).toBe(false);
  });
  it("keeps working when a protocol is down (drill): the others are read, compared and routed", async () => {
    const r = await aggregate(base(world(), { kind: "deposit", assets: 100n * 10n ** 6n }, { down: ["morpho"] }));
    expect(r.down.map((d) => [d.venue.protocol, d.simulated])).toEqual([["morpho", true]]);
    expect(r.views.map((v) => v.venue.id).sort()).toEqual(["cen", "rox"]);
    expect(r.route!.allocations.map((a) => a.venueId)).toEqual(["rox"]);
    const text = renderReport(r).join("\n");
    expect(text).toContain("Morpho Blue    DOWN (simulated outage drill) · 0 of 1 venue answered");
    expect(text).toContain("SIMULATED OUTAGE: Morpho Blue TEST/USDC supply");
    expect(verifyActionPlan(r.plan!, USDC)).toEqual([]);
    expect(r.plan!.transactions[1]!.request.to).toBe(ROX);
  });
  it("keeps working when ONE venue is down (drill by venue id): the request goes to the next best of the same protocol", async () => {
    const two = venuesFromSources([roxSrc, moSrc, { ...moSrc, key: "morpho-cd", name: "Morpho Blue SECOND/USDC supply", marketId: ("0x" + "cd".repeat(32)) as Hex }]);
    const call = chain({ [ROX]: { price: growth(0.01), shares: 0n } }, { apr: 0.06 });
    const r = await aggregate(base(call, { kind: "deposit", assets: 100n * 10n ** 6n }, { venues: two, down: ["morpho-ab"] }));
    expect(r.down.map((d) => [d.venue.id, d.simulated])).toEqual([["morpho-ab", true]]);
    expect(r.down[0]!.reason).toContain("--down morpho-ab");
    expect(r.route!.allocations.map((a) => a.venueId)).toEqual(["morpho-cd"]);
    expect(renderReport(r).join("\n")).toContain("Morpho Blue    PARTLY UP");
  });
  it("keeps working when a protocol really fails mid-run (an RPC error), not only in a drill", async () => {
    const call = chain({ [ROX]: { price: growth(0.04), shares: SHARES, broken: true }, [CEN]: { price: growth(0.03), async: true } }, { apr: 0.06, supplyShares: 500n * 10n ** 12n });
    const r = await aggregate(base(call, { kind: "withdraw", assets: 100n * 10n ** 6n }));
    expect(r.down.map((d) => [d.venue.id, d.simulated])).toEqual([["rox", false]]);
    expect(r.down[0]!.reason).toContain("rpc down");
    expect(r.route!.allocations.map((a) => a.venueId)).toEqual(["morpho-ab"]);
    expect(r.route!.explanation.join("\n")).toContain("Unavailable: RockawayX USDC vault");
  });
  it("counts a venue that hangs as down after the timeout, and still answers", async () => {
    const call = chain({ [ROX]: { price: growth(0.04), shares: SHARES, hang: true }, [CEN]: { price: growth(0.03), async: true } }, { apr: 0.06 });
    const r = await aggregate(base(call, { kind: "rates" }, { venueTimeoutMs: 150 }));
    expect(r.down.map((d) => d.venue.id)).toEqual(["rox"]);
    expect(r.down[0]!.reason).toContain("did not answer within 150 ms");
    expect(r.views.map((v) => v.venue.id).sort()).toEqual(["cen", "morpho-ab"]);
  });
  it("refuses, saying so, when nothing answers", async () => {
    await expect(aggregate(base(world(), { kind: "rates" }, { down: ["morpho", "rockawayx", "centrifuge"] }))).rejects.toThrow("no venue answered");
  });
  it("prepares a withdrawal of a part (Morpho by assets) and of all (by shares), to the owner", async () => {
    const part = await aggregate(base(world(), { kind: "withdraw", assets: 100n * 10n ** 6n }, { down: ["rockawayx"] }));
    const t = part.plan!.transactions;
    expect(t).toHaveLength(1);
    const d = decodeFunctionData({ abi: morphoAbi, data: t[0]!.request.data });
    expect(d.functionName).toBe("withdraw");
    expect(d.args![1]).toBe(100n * 10n ** 6n);
    expect(d.args![2]).toBe(0n);
    expect(verifyActionPlan(part.plan!, USDC)).toEqual([]);
    const all = await aggregate(base(world(), { kind: "withdraw", assets: "all" }));
    expect(all.plan!.legs.every((l) => l.all)).toBe(true);
    const redeem = all.plan!.transactions.find((x) => x.request.to === ROX)!;
    const rd = decodeFunctionData({ abi: erc4626, data: redeem.request.data });
    expect(rd.functionName).toBe("redeem");
    expect(rd.args![0]).toBe(SHARES);
    expect(verifyActionPlan(all.plan!, USDC)).toEqual([]);
  });
  it("sizes a Morpho exit by what is asked: idle liquidity covers 100 USDC of a position it could not cover whole", async () => {
    const call = chain({}, { apr: 0.06, supplyShares: 1_500_000n * 10n ** 6n * 10n ** 6n }); // ≈ 1.5M USDC held, 1M idle
    const mo = { venues: [venues[2]!] };
    const part = await aggregate(base(call, { kind: "withdraw", assets: 100n * 10n ** 6n }, mo));
    expect(part.route!.allocations.map((a) => a.venueId)).toEqual(["morpho-ab"]);
    expect(verifyActionPlan(part.plan!, USDC)).toEqual([]);
    const all = await aggregate(base(call, { kind: "withdraw", assets: "all" }, mo));
    expect(all.plan).toBeNull();
    expect(all.route!.explanation.join("\n")).toContain("idle liquidity");
  });
  it("redeems a part of an ERC-4626 position in shares, rounded up", async () => {
    const r = await aggregate(base(world(), { kind: "withdraw", assets: 250n * 10n ** 6n }, { down: ["morpho"] }));
    const d = decodeFunctionData({ abi: erc4626, data: r.plan!.transactions[0]!.request.data });
    expect(d.functionName).toBe("redeem");
    const shares = d.args![0] as bigint;
    expect(shares).toBeLessThan(SHARES);
    expect(shares).toBeGreaterThan(SHARES / 5n); // about a quarter of a ~1,000 USDC position
  });
  it("splits a deposit when the best venue has a limit", async () => {
    const call = chain({ [ROX]: { price: growth(0.04), shares: SHARES, maxDeposit: 30n * 10n ** 6n } }, { apr: 0.06 });
    const r = await aggregate(base(call, { kind: "deposit", assets: 100n * 10n ** 6n }, { venues: venuesFromSources([roxSrc, moSrc]) }));
    // Morpho is better but has no limit: it takes it all; ROX is the one with a limit, so cap the better one instead
    expect(r.route!.allocations.map((a) => a.venueId)).toEqual(["morpho-ab"]);
    const call2 = chain({ [ROX]: { price: growth(0.09), shares: SHARES, maxDeposit: 30n * 10n ** 6n } }, { apr: 0.04 });
    const r2 = await aggregate(base(call2, { kind: "deposit", assets: 100n * 10n ** 6n }, { venues: venuesFromSources([roxSrc, moSrc]) }));
    expect(r2.route!.allocations.map((a) => [a.venueId, Math.round(a.usd)])).toEqual([["rox", 30], ["morpho-ab", 70]]);
    expect(r2.plan!.legs.map((l) => l.assets)).toEqual([String(30n * 10n ** 6n), String(70n * 10n ** 6n)]);
    expect(r2.plan!.legs.reduce((a, l) => a + BigInt(l.assets), 0n)).toBe(100n * 10n ** 6n);
    expect(verifyActionPlan(r2.plan!, USDC)).toEqual([]);
  });
  it("refuses a deposit the wallet cannot fund, unless told to assume it", async () => {
    await expect(aggregate(base(chain({}, { apr: 0.06 }, 5n * 10n ** 6n), { kind: "deposit", assets: 100n * 10n ** 6n }, { venues: [venues[2]!] }))).rejects.toBeInstanceOf(InsufficientFunds);
    const r = await aggregate(base(chain({}, { apr: 0.06 }, 5n * 10n ** 6n), { kind: "deposit", assets: 100n * 10n ** 6n }, { venues: [venues[2]!], assumeFunded: true }));
    expect(r.funded).toEqual({ balance: 5n * 10n ** 6n, assumed: true });
    expect(renderReport(r).join("\n")).toContain("prepared on --assume-funded");
  });
  it("lists a Centrifuge position as readable but cannot prepare its withdrawal", async () => {
    const call = chain({ [CEN]: { price: growth(0.03), async: true, shares: SHARES } });
    const r = await aggregate(base(call, { kind: "withdraw", assets: "all" }, { venues: [venues[1]!] }));
    expect(r.views[0]!.holding).not.toBeNull();
    expect(r.plan).toBeNull();
    expect(r.route!.allocations).toEqual([]);
    expect(r.route!.explanation.join("\n")).toContain("Cannot withdraw from Janus Test Fund");
  });
});

describe("adapters", () => {
  it("a Centrifuge adapter reads but refuses to prepare, with the ERC-7540 reason", async () => {
    const v = venuesFromSources([cenSrc])[0]!;
    const i = { call: world(), chainId: 1672, wallet: ME, usdc: USDC, venue: v, assets: 1n, block: HEAD, estimate: async () => null };
    await expect(ADAPTERS.centrifuge.prepareDeposit(i)).rejects.toBeInstanceOf(NotPreparable);
    await expect(ADAPTERS.centrifuge.prepareWithdraw(i)).rejects.toThrow("ERC-7540");
  });
});

// ---------------------------------------------------------------- the wallet-side check catches an edited plan

describe("verifyActionPlan", () => {
  const mk = async (): Promise<ActionPlan> => (await aggregate(base(world(), { kind: "deposit", assets: 100n * 10n ** 6n }, { down: ["rockawayx"] }))).plan!;
  const edit = (p: ActionPlan, f: (q: ActionPlan) => void): ActionPlan => {
    const q = JSON.parse(JSON.stringify(p)) as ActionPlan;
    f(q);
    return q;
  };
  const refp = (q: ActionPlan) => (q.planId = keccak256(new TextEncoder().encode(JSON.stringify(q.transactions.map((t) => t.request)))));
  void refp;
  it("passes the plan as prepared", async () => expect(verifyActionPlan(await mk(), USDC)).toEqual([]));
  it("catches a changed fingerprint, sender, value, chain id, target and amount", async () => {
    const p = await mk();
    const rebuild = (q: ActionPlan) => buildPlan(q.request, q.chainId, q.wallet, q.legs, q.transactions); // recomputes the fingerprint, as an attacker would
    expect(verifyActionPlan(edit(p, (q) => (q.planId = ("0x" + "00".repeat(32)) as Hex)), USDC)[0]).toContain("fingerprint");
    expect(verifyActionPlan(rebuild(edit(p, (q) => (q.transactions[1]!.request.from = getAddress("0x3333333333333333333333333333333333333333")))), USDC).join()).toContain("not the owner");
    expect(verifyActionPlan(rebuild(edit(p, (q) => (q.transactions[1]!.request.value = "0x1"))), USDC).join()).toContain("carries value");
    expect(verifyActionPlan(rebuild(edit(p, (q) => (q.transactions[0]!.request.chainId = "0x1"))), USDC).join()).toContain("chain id");
    expect(verifyActionPlan(rebuild(edit(p, (q) => (q.transactions[1]!.request.to = getAddress("0x4444444444444444444444444444444444444444")))), USDC).join()).toContain("goes to");
    expect(verifyActionPlan(rebuild(edit(p, (q) => (q.legs[0]!.assets = "1"))), USDC).join()).toMatch(/approves .* the leg is 1/);
  });
  it("catches a deposit made for someone else and an approval to someone else", async () => {
    const p = await mk();
    const rebuild = (q: ActionPlan) => buildPlan(q.request, q.chainId, q.wallet, q.legs, q.transactions);
    const thief = getAddress("0x5555555555555555555555555555555555555555");
    const d = decodeFunctionData({ abi: morphoAbi, data: p.transactions[1]!.request.data });
    const args = [...d.args!] as any[];
    args[3] = thief;
    const { encodeFunctionData } = await import("viem");
    const bad = rebuild(edit(p, (q) => (q.transactions[1]!.request.data = encodeFunctionData({ abi: morphoAbi, functionName: "supply", args: args as never }))));
    expect(verifyActionPlan(bad, USDC).join()).toContain("on behalf of someone other than the owner");
    const bad2 = rebuild(edit(p, (q) => (q.transactions[0]!.request.data = encodeFunctionData({ abi: erc20, functionName: "approve", args: [thief, 100n * 10n ** 6n] }))));
    expect(verifyActionPlan(bad2, USDC).join()).toContain("not the venue");
  });
  it("catches a transaction for a venue that is not one of the legs, and a missing deposit", async () => {
    const p = await mk();
    const rebuild = (q: ActionPlan) => buildPlan(q.request, q.chainId, q.wallet, q.legs, q.transactions);
    expect(verifyActionPlan(rebuild(edit(p, (q) => (q.transactions[1]!.venue = "elsewhere"))), USDC).join()).toContain("not one of the plan's legs");
    expect(verifyActionPlan(rebuild(edit(p, (q) => q.transactions.pop())), USDC).join()).toContain("needs one approve and one deposit");
  });
  it("catches a withdrawal that pays someone else", async () => {
    const r = await aggregate(base(world(), { kind: "withdraw", assets: 100n * 10n ** 6n }, { down: ["morpho"] }));
    const { encodeFunctionData } = await import("viem");
    const thief = getAddress("0x5555555555555555555555555555555555555555");
    const q = JSON.parse(JSON.stringify(r.plan)) as ActionPlan;
    q.transactions[0]!.request.data = encodeFunctionData({ abi: erc4626, functionName: "redeem", args: [1n, thief, ME] });
    const bad = buildPlan(q.request, q.chainId, q.wallet, q.legs, q.transactions);
    expect(verifyActionPlan(bad, USDC).join()).toContain("someone other than the owner");
  });
});

// ---------------------------------------------------------------- the CLI

const run = (a: string[]) => main({ onExit: () => {} } as never, a);

describe("CLI input", () => {
  const W = "0x1111111111111111111111111111111111111111";
  it("refuses bad input before touching the chain", async () => {
    await expect(run([])).rejects.toBeInstanceOf(UsageError);
    await expect(run(["rates"])).rejects.toThrow("--wallet must be an address");
    await expect(run(["rates", "--wallet", "nope"])).rejects.toThrow("--wallet must be an address");
    await expect(run(["fly", "--wallet", W])).rejects.toThrow("command must be one of positions, rates, deposit, withdraw");
    await expect(run(["deposit", "--wallet", W])).rejects.toThrow("deposit needs --amount");
    await expect(run(["withdraw", "--wallet", W])).rejects.toThrow("withdraw needs --amount");
    await expect(run(["deposit", "--wallet", W, "--amount", "all"])).rejects.toThrow("only makes sense for a withdrawal");
    await expect(run(["deposit", "--wallet", W, "--amount=-5"])).rejects.toThrow("positive USDC amount");
    await expect(run(["deposit", "--wallet", W, "--amount", "1.1234567"])).rejects.toThrow("at most 6 decimals");
    await expect(run(["positions", "--wallet", W, "--amount", "5"])).rejects.toThrow("--amount is for deposit and withdraw");
    await expect(run(["positions", "--wallet", W, "--down", "aave"])).rejects.toThrow("--down must be one of rockawayx, morpho, centrifuge");
    await expect(run(["positions", "--wallet", W, "--down", "morpho,aave"])).rejects.toThrow("--down must be one of");
    await expect(run(["withdraw", "--wallet", W, "--amount", "5", "--assume-funded"])).rejects.toThrow("--assume-funded is for deposit");
    await expect(run(["positions", "--wallet", W, "--windows", "7d"])).rejects.toThrow();
    await expect(run(["positions", "--wallet", W, "--hold-days", "0"])).rejects.toThrow("--hold-days must be a number");
    await expect(run(["positions", "--wallet", W, "--block", "x"])).rejects.toThrow("--block must be a block number");
    await expect(run(["positions", "--wallet", W, "--nope"])).rejects.toBeInstanceOf(UsageError);
  });
});

describe("this task cannot sign or send", () => {
  it("imports no signer, no key and no sender", () => {
    const files = [...readdirSync("src/aggregator").map((f) => join("src/aggregator", f)), "tasks/multi-protocol-aggregator/index.ts"];
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/from "[^"]*(signer|wallet)[^"]*"|privateKey|PRIVATE_KEY|send_raw_transaction|sendTransaction|signTransaction|\.config\//i);
    }
  });
});
