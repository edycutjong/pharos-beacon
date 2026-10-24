import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Hex } from "viem";
import { UsageError } from "../src/lib/cli.js";
import { renderReport } from "../src/yield/format.js";
import { aprBetween, evaluateMove, fmtDays, parseWindows, rateView, recommend, usd, type Held, type Target, type WindowRate } from "../src/yield/model.js";
import { NotPlannable, planFingerprint, planMove } from "../src/yield/plan.js";
import { NoPosition, analyse } from "../src/yield/run.js";
import { holdingOf, rd, type Source } from "../src/yield/sources.js";
import { main } from "../tasks/yield-optimizer/index.js";

const ME = getAddress("0x1111111111111111111111111111111111111111");
const USDC = getAddress("0x2222222222222222222222222222222222222222");
const VA = getAddress("0x00000000000000000000000000000000000000a1");
const VB = getAddress("0x00000000000000000000000000000000000000b1");
const VC = getAddress("0x00000000000000000000000000000000000000c1");
const HEAD = 5_000_000n; // 1 s blocks, so a block number is also its timestamp

const win = (label: string, apr: number | null, seconds = 1): WindowRate => ({ label, seconds, apr });
const view = (a: (number | null)[]) => rateView(a.map((x, i) => win(["1d", "7d", "30d"][i]!, x, 86_400 * (i + 1))));

// ---------------------------------------------------------------- the maths

describe("windows and rates", () => {
  it("parses minutes, hours and days, shortest first", () => {
    expect(parseWindows("30d,1d,7d").map((w) => [w.label, w.seconds])).toEqual([["1d", 86_400], ["7d", 604_800], ["30d", 2_592_000]]);
    expect(parseWindows("10m, 1h").map((w) => w.seconds)).toEqual([600, 3600]);
  });
  it("refuses bad windows", () => {
    for (const bad of ["7d", "1d,1d", "1x,2d", "0d,1d", "", "1d,2d,3d,4d,5d,6d,7d"]) expect(() => parseWindows(bad)).toThrow();
  });
  it("annualises a price move by simple extrapolation", () => {
    const then = { block: 1n, timestamp: 0n, price: 1 };
    const now = { block: 2n, timestamp: BigInt(86_400 * 73), price: 1.01 }; // +1 % in 73 days = 5 periods a year
    expect(aprBetween(then, now)).toBeCloseTo(0.05, 10);
    expect(aprBetween(then, { ...now, timestamp: 0n })).toBeNull();
  });
  it("takes the median as the reference and the spread as the jumpiness", () => {
    const steady = view([0.05, 0.05, 0.049]);
    expect(steady.ref).toBeCloseTo(0.05);
    expect(steady.jumpy).toBe(false);
    expect(steady.pessimistic).toBeCloseTo(0.05 - 0.5 * 0.001, 10);
    const jumpy = view([0.0, 0.0355, 0.0347]);
    expect(jumpy.jumpy).toBe(true);
    expect(jumpy.pessimistic).toBeCloseTo(0.0347 - 0.5 * 0.0355, 10);
    expect(jumpy.optimistic).toBeCloseTo(0.0347 + 0.5 * 0.0355, 10);
  });
  it("never credits a negative conservative rate and flags thin history", () => {
    expect(view([-0.1, -0.002, -0.0106]).pessimistic).toBe(0);
    const thin = view([0.04, null, null]);
    expect(thin.thin).toBe(true);
    expect(thin.read).toBe(1);
    expect(view([null, null, null]).ref).toBeNull();
  });
  it("formats", () => {
    expect(usd(1234.5)).toBe("$1,234.50");
    expect(usd(-0.0123)).toBe("-$0.0123");
    expect(fmtDays(0.5)).toBe("12.0 h");
    expect(fmtDays(14.6)).toBe("15 d");
    expect(fmtDays(2 / 1440)).toBe("2 min");
  });
});

const held = (over: Partial<Held> = {}): Held => ({ key: "a", name: "Vault A", usd: 1000, rate: view([0.04, 0.04, 0.04]), exitFeeBps: 0, exitBlockers: [], ...over });
const target = (over: Partial<Target> = {}): Target => ({ key: "b", name: "Vault B", rate: view([0.09, 0.09, 0.09]), entryFeeBps: 10, lockSeconds: 0, entryBlockers: [], gasUsd: 1, ...over });
const P = { holdDays: 30, minNetUsd: 1 };

describe("evaluateMove: costs, break-even and the holding period", () => {
  it("nets gas, exit fee and entry fee out of the extra yield", () => {
    const e = evaluateMove(held({ exitFeeBps: 20 }), target(), P);
    expect(e.rateGap).toBeCloseTo(0.05, 10);
    expect(e.grossUsd).toBeCloseTo((1000 * 0.05 * 30) / 365, 8);
    expect(e.exitFeeUsd).toBeCloseTo(2, 8); // 20 bps of 1000
    expect(e.entryFeeUsd).toBeCloseTo(0.998, 8); // 10 bps of the 998 that is left
    expect(e.costUsd).toBeCloseTo(1 + 2 + 0.998, 8);
    expect(e.netUsd).toBeCloseTo(e.grossUsd! - e.costUsd!, 10);
    expect(e.breakEvenDays).toBeCloseTo(e.costUsd! / ((1000 * 0.05) / 365), 8);
  });
  it("moves when net, break-even and blockers all allow it", () => {
    const e = evaluateMove(held(), target({ entryFeeBps: 0 }), P);
    expect(e.verdict).toBe("move");
    expect(e.breakEvenDays).toBeCloseTo(7.3, 1);
  });
  it("does not move when the costs are not earned back inside the holding period", () => {
    const e = evaluateMove(held(), target({ gasUsd: 20 }), { holdDays: 30, minNetUsd: 0 });
    expect(e.netUsd).toBeLessThan(0);
    expect(e.verdict).toBe("no");
    expect(e.breakEvenDays).toBeGreaterThan(30);
  });
  it("has no break-even when the destination is not better", () => {
    const e = evaluateMove(held(), target({ rate: view([0.03, 0.03, 0.03]) }), P);
    expect(e.breakEvenDays).toBeNull();
    expect(e.verdict).toBe("no");
  });
  it("applies a destination lock-in: the horizon grows, and it is stated", () => {
    const e = evaluateMove(held(), target({ lockSeconds: 7 * 86_400, entryFeeBps: 0 }), { holdDays: 3, minNetUsd: 0 });
    expect(e.horizonDays).toBe(7);
    expect(e.notes.join()).toContain("locks deposits for 7.0 d");
    expect(e.grossUsd).toBeCloseTo((1000 * 0.05 * 7) / 365, 8);
  });
  it("credits a jumpy destination at its conservative rate and the held position at its optimistic one", () => {
    const steady = evaluateMove(held(), target({ rate: view([0.09, 0.09, 0.09]) }), P);
    const jumpy = evaluateMove(held(), target({ rate: view([0.4, 0.09, 0.05]) }), P);
    expect(jumpy.rateGap!).toBeLessThan(steady.rateGap!);
    const heldJumpy = evaluateMove(held({ rate: view([0.0, 0.04, 0.08]) }), target(), P);
    expect(heldJumpy.rateGap!).toBeCloseTo(0.09 - (0.04 + 0.5 * 0.08), 10);
  });
  it("cannot value a move whose fee is unreadable, and says why it is blocked", () => {
    const e = evaluateMove(held(), target({ entryFeeBps: null, entryBlockers: ["deposit is an asynchronous request"] }), P);
    expect(e.netUsd).toBeNull();
    expect(e.verdict).toBe("no");
    expect(e.entryBlockers).toEqual(["deposit is an asynchronous request"]);
  });
  it("refuses to judge a rate from one window", () => {
    const e = evaluateMove(held(), target({ rate: view([0.09, null, null]) }), P);
    expect(e.entryBlockers.join()).toContain("rate history too short");
    expect(e.verdict).toBe("no");
  });
});

describe("recommend", () => {
  it("picks the destination with the highest net gain", () => {
    const r = recommend(held(), [target({ key: "b", name: "B", entryFeeBps: 0 }), target({ key: "c", name: "C", rate: view([0.12, 0.12, 0.12]), entryFeeBps: 0 })], P);
    expect(r.decision).toBe("MOVE");
    expect(r.best!.key).toBe("c");
    expect(r.reason).toContain("move to C");
    expect(r.reason).toContain("earned back in");
  });
  it("ranks a jumpy source down: the steadier, slightly lower one wins", () => {
    const r = recommend(held(), [target({ key: "j", name: "Jumpy", rate: view([0.0, 0.12, 0.12]), entryFeeBps: 0 }), target({ key: "s", name: "Steady", rate: view([0.1, 0.1, 0.1]), entryFeeBps: 0 })], P);
    expect(r.best!.key).toBe("s");
  });
  it("stays put with the reason when the best alternative is not worth the costs", () => {
    const r = recommend(held(), [target({ rate: view([0.0405, 0.0405, 0.0405]), entryFeeBps: 25 })], P);
    expect(r.decision).toBe("STAY");
    expect(r.reason).toContain("the best alternative that could be entered, Vault B");
    expect(r.reason).toContain("must net at least $1.00");
  });
  it("stays put when the held position cannot be exited, saying so once", () => {
    const r = recommend(held({ exitBlockers: ["locked until 2026-11-01"] }), [target({ entryFeeBps: 0 })], P);
    expect(r.decision).toBe("STAY");
    expect(r.reason).toContain("Vault A cannot be exited in one transaction today (locked until 2026-11-01)");
  });
  it("stays put when no alternative can be entered", () => {
    const r = recommend(held(), [target({ entryBlockers: ["maxDeposit(wallet) = 0"], entryFeeBps: null })], P);
    expect(r.decision).toBe("STAY");
    expect(r.reason).toContain("no alternative can be entered by this wallet today (Vault B: maxDeposit(wallet) = 0)");
  });
  it("says there is nothing to compare with when the position is the only source", () => {
    expect(recommend(held(), [], P).reason).toContain("no other source to compare");
  });
});

// ---------------------------------------------------------------- a fake chain with two ERC-4626-shaped test vaults

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
  "function lockSeconds() view returns (uint256)",
  "function lockedUntil(address) view returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
]);

interface FakeVault {
  /** USDC per share at timestamp t (a block number is its own timestamp). */
  price: (t: bigint) => number;
  entryBps?: number;
  exitBps?: number;
  lock?: bigint;
  lockedUntil?: bigint;
  maxDeposit?: bigint;
  shares?: bigint;
  redeemReverts?: boolean;
  broken?: boolean;
}

function chain(vaults: Record<string, FakeVault>, calls: string[] = []) {
  const enc = (fn: string, v: unknown) => ({ result: encodeFunctionResult({ abi, functionName: fn as never, result: v as never }) });
  const call = (async (tool: string, args: Record<string, any> = {}) => {
    calls.push(tool);
    if (tool === "get_block_number") return { blockNumber: HEAD.toString() };
    if (tool === "get_block") return { timestamp: `0x${BigInt(args.block).toString(16)}`, number: args.block };
    if (tool === "get_gas_price") return { gasPriceWei: "10000000000" };
    if (tool === "estimate_gas") return { gas: "100000" };
    if (tool === "eth_call") {
      const v = vaults[args.transaction.to as string];
      if (!v) throw new Error(`no contract at ${args.transaction.to}`);
      if (v.broken) throw new Error("rpc down");
      const at = BigInt(args.block ?? HEAD);
      const d = decodeFunctionData({ abi, data: args.transaction.data as Hex });
      const px = v.price(at);
      const toAssets = (shares: bigint) => BigInt(Math.round((Number(shares) / 1e18) * px * 1e6 * 1e6)) / 1_000_000n; // keeps 1e-12 of precision
      const sharesOf = (a: bigint) => BigInt(Math.round((Number(a) / px / 1e6) * 1e18));
      switch (d.functionName) {
        case "asset": return enc("asset", USDC);
        case "decimals": return enc("decimals", 18);
        case "balanceOf": return enc("balanceOf", v.shares ?? 0n);
        case "totalAssets": return enc("totalAssets", 1_000_000_000n);
        case "convertToAssets": return enc("convertToAssets", (d.args![0] as bigint) >= 10n ** 24n ? BigInt(Math.round(Number(d.args![0] as bigint) / 1e24 * px * 1e12)) : toAssets(d.args![0] as bigint));
        case "convertToShares": return enc("convertToShares", sharesOf(d.args![0] as bigint));
        case "previewDeposit": return enc("previewDeposit", (sharesOf(d.args![0] as bigint) * BigInt(10_000 - (v.entryBps ?? 0))) / 10_000n);
        case "previewRedeem": return enc("previewRedeem", (toAssets(d.args![0] as bigint) * BigInt(10_000 - (v.exitBps ?? 0))) / 10_000n);
        case "maxDeposit": return enc("maxDeposit", v.maxDeposit ?? 10n ** 18n);
        case "maxRedeem": return enc("maxRedeem", v.shares ?? 0n);
        case "lockSeconds": return enc("lockSeconds", v.lock ?? 0n);
        case "lockedUntil": return enc("lockedUntil", v.lockedUntil ?? 0n);
        case "redeem": {
          if (v.redeemReverts) throw Object.assign(new Error("eth_call: execution reverted: StillLocked"), { code: 3 });
          return enc("redeem", 1n);
        }
      }
    }
    throw new Error(`fake chain: ${tool}`);
  }) as never;
  return call;
}

const growth = (apr: number) => (t: bigint) => 1 + (apr * Number(t)) / (365 * 86_400);
const SRC = (key: string, address: Hex): Source => ({ key, name: `Vault ${key.toUpperCase()}`, kind: "testvault", contract: address });
const sources = [SRC("a", VA), SRC("b", VB)];
const WINDOWS = parseWindows("1d,7d,30d");
const base = { chainId: 688689, network: "atlantic" as const, wallet: ME, usdc: USDC, assetDecimals: 6, windows: WINDOWS, holdDays: 30, minNetUsd: 0.001, slippageBps: 10, nativeUsd: { value: 0.5, basis: "test" } };
const ONE_SHARE_MILLION = 1_000_000n * 10n ** 18n; // 1,000,000 shares ≈ 1,000,000 USDC

describe("analyse (fake chain, two vaults)", () => {
  it("measures each vault's real rate from its share price and recommends the move", async () => {
    const call = chain({ [VA]: { price: growth(0.04), shares: ONE_SHARE_MILLION / 1000n }, [VB]: { price: growth(0.09), entryBps: 10 } });
    const r = await analyse({ ...base, call, sources });
    for (const x of r.readings) {
      const want = x.source.key === "a" ? 0.04 : 0.09;
      for (const w of x.windows) expect(Math.abs(w.apr! / want - 1)).toBeLessThan(0.02); // the fake's price grows linearly from 1, so the measured simple rate is the nominal one divided by the price level (about 1 % lower)
    }
    expect(r.held.source.key).toBe("a");
    expect(r.heldView.usd).toBeGreaterThan(1000);
    expect(r.targets[0]!.entryFeeBps).toBe(10);
    expect(r.recommendation.decision).toBe("MOVE");
    expect(r.recommendation.best!.key).toBe("b");
    expect(r.recommendation.best!.netUsd!).toBeGreaterThan(0);
    // gas: 3 transactions, the exit and the approve estimated by the node, the deposit configured
    expect(r.targets[0]!.gasBasis).toBe("exit:estimated, approve:estimated, enter:configured");
    expect(r.targets[0]!.gasUnits).toBe(100_000 + 100_000 + 300_000);
    expect(r.targets[0]!.gasUsd).toBeCloseTo((10e9 * 500_000) / 1e18 * 0.5, 12);
  });

  it("prepares unsigned transactions: redeem, approve, deposit, with a fingerprint", async () => {
    const call = chain({ [VA]: { price: growth(0.04), shares: ONE_SHARE_MILLION / 1000n }, [VB]: { price: growth(0.09) } });
    const r = await analyse({ ...base, call, sources });
    const p = r.plan!;
    expect(p.signed).toBe(false);
    expect(p.transactions.map((t) => t.action)).toEqual(["exit", "approve", "enter"]);
    const redeem = decodeFunctionData({ abi, data: p.transactions[0]!.request.data });
    expect(redeem.functionName).toBe("redeem");
    expect(redeem.args).toEqual([ONE_SHARE_MILLION / 1000n, ME, ME]);
    expect(p.transactions[0]!.request.to).toBe(VA);
    expect(p.transactions[1]!.request.to).toBe(USDC);
    expect(p.transactions[2]!.request.to).toBe(VB);
    for (const t of p.transactions) {
      expect(t.request.from).toBe(ME);
      expect(t.request.value).toBe("0x0");
    }
    expect(planFingerprint(p.transactions)).toBe(p.planId);
    const tampered = structuredClone(p.transactions);
    tampered[2]!.request.data = tampered[2]!.request.data.replace(/.$/, "0") as Hex;
    expect(planFingerprint(tampered)).not.toBe(p.planId);
    // the deposit puts in the previewed proceeds less the slippage allowance, never more than the exit pays
    const approve = Number(BigInt(`0x${p.transactions[1]!.request.data.slice(-64)}`));
    expect(approve).toBe(Number(BigInt(p.depositAssets)));
    expect(BigInt(p.depositAssets)).toBeLessThan(r.held.holding.assets);
  });

  it("stays put, with no transactions, when the destination's lead is eaten by its fee", async () => {
    const call = chain({ [VA]: { price: growth(0.04), shares: ONE_SHARE_MILLION / 1000n }, [VB]: { price: growth(0.0405), entryBps: 30 } });
    const r = await analyse({ ...base, call, sources });
    expect(r.recommendation.decision).toBe("STAY");
    expect(r.plan).toBeNull();
    expect(r.planNote).toContain("stay put");
    expect(r.recommendation.reason).toContain("would net -$");
  });

  it("reports a locked position as the reason to stay, and shows the destination's numbers anyway", async () => {
    const call = chain({ [VA]: { price: growth(0.04), shares: ONE_SHARE_MILLION / 1000n, lockedUntil: HEAD + 3600n }, [VB]: { price: growth(0.09) } });
    const r = await analyse({ ...base, call, sources });
    expect(r.recommendation.decision).toBe("STAY");
    expect(r.recommendation.reason).toContain("Vault A cannot be exited in one transaction today (locked until");
    expect(r.recommendation.evaluations[0]!.netUsd).not.toBeNull();
  });

  it("runs the exit before it believes it: a redeem that reverts blocks the move even when maxRedeem looks fine", async () => {
    const call = chain({ [VA]: { price: growth(0.04), shares: ONE_SHARE_MILLION / 1000n, redeemReverts: true }, [VB]: { price: growth(0.09) } });
    const r = await analyse({ ...base, call, sources });
    expect(r.recommendation.decision).toBe("STAY");
    expect(r.heldView.exitBlockers.join()).toContain("simulated redeem(all shares) from the wallet reverts");
  });

  it("does not trust a vault's maxDeposit of zero as an exit problem for the held vault, and blocks entry to a full vault", async () => {
    const call = chain({ [VA]: { price: growth(0.04), shares: ONE_SHARE_MILLION / 1000n }, [VB]: { price: growth(0.09), maxDeposit: 0n } });
    const r = await analyse({ ...base, call, sources });
    expect(r.recommendation.decision).toBe("STAY");
    expect(r.targets[0]!.entryBlockers.join()).toContain("maxDeposit(wallet) = 0");
  });

  it("lists a source that cannot be read instead of guessing", async () => {
    const call = chain({ [VA]: { price: growth(0.04), shares: ONE_SHARE_MILLION / 1000n }, [VB]: { price: growth(0.09), broken: true } });
    const r = await analyse({ ...base, call, sources });
    expect(r.unreadable.map((u) => u.source.key)).toEqual(["b"]);
    expect(r.recommendation.reason).toContain("no other source to compare");
  });

  it("says so when the wallet holds nothing in any source", async () => {
    const call = chain({ [VA]: { price: growth(0.04) }, [VB]: { price: growth(0.09) } });
    await expect(analyse({ ...base, call, sources })).rejects.toBeInstanceOf(NoPosition);
  });

  it("ranks a jumpy source down and calls it JUMPY in the report", async () => {
    // B earned 40 % a year until a day ago, then 2 %: its windows disagree
    const jumpy = (t: bigint) => 1 + (0.4 * Number(t < HEAD - 86_400n ? t : HEAD - 86_400n)) / (365 * 86_400) + (0.02 * Number(t > HEAD - 86_400n ? t - (HEAD - 86_400n) : 0n)) / (365 * 86_400);
    const call = chain({ [VA]: { price: growth(0.04), shares: ONE_SHARE_MILLION / 1000n }, [VB]: { price: jumpy } });
    const r = await analyse({ ...base, call, sources });
    const b = r.targets[0]!.rate;
    expect(b.jumpy).toBe(true);
    expect(b.pessimistic!).toBeLessThan(b.ref!);
    expect(renderReport(r).join("\n")).toContain("JUMPY");
  });

  it("does not trust a price its neighbour block contradicts: the anchor moves and the rate stays true", async () => {
    // the node answers 8 % too high at exactly the block the 1-day window starts from (the real flake, proof/node-flake.txt)
    const bad = HEAD - 86_400n;
    const flaky = (t: bigint) => (t === bad ? growth(0.04)(t) * 1.08 : growth(0.04)(t));
    const call = chain({ [VA]: { price: flaky, shares: ONE_SHARE_MILLION / 1000n }, [VB]: { price: growth(0.09) } });
    const r = await analyse({ ...base, call, sources });
    const a = r.readings.find((x) => x.source.key === "a")!;
    expect(a.windows.find((w) => w.label === "1d")!.apr!).toBeGreaterThan(0.035);
    expect(a.windows.find((w) => w.label === "1d")!.apr!).toBeLessThan(0.045);
    const e = a.evidence.find((x) => x.what.startsWith("share price 1d ago"))!;
    expect(e.block).toBe(bad - 2n); // the anchor moved two blocks
    expect(r.recommendation.decision).toBe("MOVE");
  });
  it("marks a window unreadable when the node never agrees with itself near its block", async () => {
    const bad = HEAD - 86_400n;
    const wild = (t: bigint) => (t <= bad && t > bad - 12n ? growth(0.04)(t) * (1 + Number(t % 2n) * 0.2) : growth(0.04)(t)); // alternating 0 / +20 % for 12 blocks
    const call = chain({ [VA]: { price: wild, shares: ONE_SHARE_MILLION / 1000n }, [VB]: { price: growth(0.09) } });
    const r = await analyse({ ...base, call, sources });
    const w = r.readings.find((x) => x.source.key === "a")!.windows.find((x) => x.label === "1d")!;
    expect(w.apr).toBeNull();
    expect(w.reason).toContain("disagree between adjacent blocks");
  });

  it("refuses windows longer than the chain's age", async () => {
    const call = chain({ [VA]: { price: growth(0.04), shares: 1n }, [VB]: { price: growth(0.09) } });
    await expect(analyse({ ...base, call, sources, windows: parseWindows("1d,200d") })).rejects.toThrow(/younger than the longest window/);
  });

  it("prints a report that carries every number's source (contract, call, block)", async () => {
    const call = chain({ [VA]: { price: growth(0.04), shares: ONE_SHARE_MILLION / 1000n }, [VB]: { price: growth(0.09) } });
    const r = await analyse({ ...base, call, sources });
    const text = renderReport(r).join("\n");
    expect(text).toContain("RECOMMENDATION: MOVE");
    expect(text).toContain("Prepared for the wallet owner's signature (nothing signed, no key read)");
    expect(r.evidence.some((e) => e.what.startsWith("share price now") && e.contract === VA && e.call.startsWith("convertToAssets") && e.block === HEAD)).toBe(true);
    expect(r.evidence.some((e) => e.what === "simulated redeem(all shares) (USDC raw)")).toBe(true);
  });

  it("holdingOf and rd read through the Chain MCP at a pinned block", async () => {
    const calls: string[] = [];
    const call = chain({ [VA]: { price: growth(0.04), shares: 5n * 10n ** 18n } }, calls);
    const h = await holdingOf(call, SRC("a", VA), ME, HEAD, HEAD);
    expect(h!.shares).toBe(5n * 10n ** 18n);
    expect(await rd(call, VA, "balanceOf(address) view returns (uint256)", [ME], HEAD)).toBe(5n * 10n ** 18n);
    expect(calls.every((c) => c === "eth_call")).toBe(true);
    expect(await holdingOf(chain({ [VA]: { price: growth(0.04) } }), SRC("a", VA), ME, HEAD, HEAD)).toBeNull();
  });
});

// ---------------------------------------------------------------- planning

describe("planMove", () => {
  const A = SRC("a", VA);
  const B = SRC("b", VB);
  const input = { call: chain({}), chainId: 688689, wallet: ME, usdc: USDC, from: A, to: B, shares: 10n ** 18n, proceeds: 1_000_000n, slippageBps: 10, block: HEAD, estimate: async () => null };
  it("falls back to configured gas when the node cannot estimate, and says so", async () => {
    const p = await planMove(input);
    expect(p.transactions.map((t) => t.gas.basis)).toEqual(["configured", "configured", "configured"]);
    expect(p.depositAssets).toBe("999000");
  });
  it("cannot plan an asynchronous (Centrifuge) vault", async () => {
    await expect(planMove({ ...input, to: { ...B, kind: "centrifuge" } })).rejects.toBeInstanceOf(NotPlannable);
    await expect(planMove({ ...input, from: { ...A, kind: "centrifuge" } })).rejects.toThrow(/asynchronous/);
  });
  it("refuses to move a position into itself", async () => {
    await expect(planMove({ ...input, to: A })).rejects.toThrow(/same/);
  });
  it("plans a Morpho Blue exit with withdraw(…, shares) and an entry with supply(…)", async () => {
    const morphoAbi = parseAbi(["function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)"]);
    const id = `0x${"ab".repeat(32)}` as Hex;
    const call = (async (_t: string, _a: unknown) => ({ result: encodeFunctionResult({ abi: morphoAbi, functionName: "idToMarketParams", result: [USDC, VC, VC, VC, 860_000_000_000_000_000n] }) })) as never;
    const m: Source = { key: "m", name: "Morpho X/USDC supply", kind: "morpho", contract: getAddress("0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb"), marketId: id };
    const out = await planMove({ ...input, call, from: m, to: B });
    expect(out.transactions[0]!.request.to).toBe(m.contract);
    const w = decodeFunctionData({ abi: parseAbi(["function withdraw((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)"]), data: out.transactions[0]!.request.data });
    expect(w.args!.slice(1)).toEqual([0n, input.shares, ME, ME]); // all shares out, no asset amount
    const back = await planMove({ ...input, call, from: A, to: m });
    expect(back.transactions[2]!.request.to).toBe(m.contract);
    expect(back.transactions[1]!.request.data).toContain(m.contract.slice(2).toLowerCase()); // approve(Morpho Blue)
  });
});

// ---------------------------------------------------------------- the agent never holds keys

describe("keyless by construction", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const agent = [...files("src/yield"), "tasks/yield-optimizer/index.ts"];
  it("the agent's sources import no signer, read no secret and cannot send", () => {
    for (const f of agent) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // comments may talk about signing
      expect(src, f).not.toMatch(/signer|privateKey|PRIVATE_KEY|secret\(|process\.env|send_raw_transaction|sendTransaction|broadcast|\.send\(|viem\/accounts/i);
    }
  });
  it("only the wallet stand-in reads a key, and it is a separate file", () => {
    const wallet = readFileSync("tasks/yield-optimizer/wallet.ts", "utf8");
    expect(wallet).toContain("testnetSigner");
    expect(wallet).toContain("--execute");
    expect(wallet).toContain("planFingerprint");
  });
  it("the Chain MCP client of the agent is read-only (no broadcast option)", () => {
    expect(readFileSync("tasks/yield-optimizer/index.ts", "utf8")).toMatch(/chainMcp\(network\)/);
  });
});

describe("CLI", () => {
  const ctx = { onExit: () => {} } as never;
  it("needs a wallet address", async () => {
    await expect(main(ctx, ["recommend"])).rejects.toBeInstanceOf(UsageError);
    await expect(main(ctx, ["recommend", "--wallet", "nope"])).rejects.toThrow(/address/);
  });
  it("rejects bad numbers and networks before any chain call", async () => {
    const w = ["recommend", "--wallet", ME];
    await expect(main(ctx, [...w, "--hold-days", "0"])).rejects.toBeInstanceOf(UsageError);
    await expect(main(ctx, [...w, "--slippage-bps", "9999"])).rejects.toBeInstanceOf(UsageError);
    await expect(main(ctx, [...w, "--network", "ethereum"])).rejects.toBeInstanceOf(UsageError);
    await expect(main(ctx, [...w, "--windows", "5d"])).rejects.toBeInstanceOf(UsageError);
    await expect(main(ctx, [...w, "--block", "-1"])).rejects.toBeInstanceOf(UsageError);
    await expect(main(ctx, ["compare", "--wallet", ME])).rejects.toBeInstanceOf(UsageError);
  });
});
