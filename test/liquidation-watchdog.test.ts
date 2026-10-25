import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Hex } from "viem";
import { buildAlert, checkThresholds, fmtHf, fmtToken, levelOf, nextLevel, pct, type Thresholds } from "../src/liq/alert.js";
import { addBorrowers, BORROW_TOPIC, discoverBorrowers, emptyIndex, loadIndex } from "../src/liq/discover.js";
import {
  accrue, borrowAssets, dropToLiquidation, evaluate, healthFactor, maxBorrow, MORPHO_BLUE, ORACLE_PRICE_SCALE, readPosition, remedy, snapshotMarket, taylorCompounded, WAD,
  type MarketSnapshot, type MarketState,
} from "../src/liq/morpho.js";
import { shockedHf, sortRows, tableText, main, type Row } from "../tasks/liquidation-watchdog/index.js";
import { UsageError } from "../src/lib/cli.js";

const ID = ("0x" + "ab".repeat(32)) as Hex;
const USER = getAddress("0xA4A5000000000000000000000000000000003DCc");
const LLTV = 915_000_000_000_000_000n; // 0.915
const PRICE = ORACLE_PRICE_SCALE; // 1.0 (loan and collateral priced alike)
const T: Thresholds = { warn: 1.3, critical: 1.1, rearm: 0.02 };
const dirs: string[] = [];
const tmp = () => (dirs.push(mkdtempSync(join(tmpdir(), "liq-"))), dirs.at(-1)!);
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const STATE: MarketState = { totalSupplyAssets: 2_000_000n, totalSupplyShares: 2_000_000_000_000n, totalBorrowAssets: 1_000_000n, totalBorrowShares: 1_000_000_000_000n, lastUpdate: 1_000n, fee: 0n };
const snap = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  id: ID, params: { loanToken: "0x0000000000000000000000000000000000000001", collateralToken: "0x0000000000000000000000000000000000000002", oracle: "0x0000000000000000000000000000000000000003", irm: "0x0000000000000000000000000000000000000004", lltv: LLTV },
  state: STATE, accrued: true, price: PRICE, loan: { symbol: "USDC", decimals: 6 }, collateral: { symbol: "syzUSD", decimals: 18 }, timestamp: 2_000n, ...over,
});
const row = (collateral: bigint, borrowShares: bigint, level?: Row["level"]): Row => {
  const s = snap();
  const p = evaluate(USER, { supplyShares: 0n, borrowShares, collateral }, s);
  return { snap: s, p, level: level ?? levelOf(p.hfNumber, T) };
};

describe("health maths (Morpho Blue's own rounding)", () => {
  it("max borrow is collateral × price × LLTV and a position is liquidatable when debt exceeds it", () => {
    expect(maxBorrow(1_000n, PRICE, LLTV)).toBe(915n);
    expect(healthFactor(1_000n, PRICE, LLTV, 915n)).toBe(WAD); // exactly at the line = 1.0
    expect(healthFactor(1_000n, PRICE, LLTV, 916n)! < WAD).toBe(true);
    expect(healthFactor(1_000n, PRICE, LLTV, 0n)).toBeNull();
  });
  it("debt rounds UP from shares, with the virtual 1 asset / 1e6 shares", () => {
    expect(borrowAssets(1_000_000_000_000n, STATE)).toBe(1_000_000n); // exact: (1e6+1)/(1e12+1e6) ×1e12 = 999,999.0.. → rounded up
    expect(borrowAssets(1n, STATE)).toBe(1n);
    expect(borrowAssets(0n, STATE)).toBe(0n);
  });
  it("accrues interest the way wTaylorCompounded does", () => {
    const rate = 3_000_000_000n; // 3e-9 per second
    expect(taylorCompounded(rate, 0n)).toBe(0n);
    expect(taylorCompounded(rate, 86_400n)).toBeGreaterThan(rate * 86_400n); // compounding adds a bit
    const a = accrue(STATE, rate, 86_400n);
    expect(a.totalBorrowAssets).toBeGreaterThan(STATE.totalBorrowAssets);
    expect(a.totalSupplyAssets - STATE.totalSupplyAssets).toBe(a.totalBorrowAssets - STATE.totalBorrowAssets);
    expect(accrue(STATE, rate, 0n)).toBe(STATE);
    expect(accrue({ ...STATE, totalBorrowAssets: 0n }, rate, 100n).totalBorrowAssets).toBe(0n);
  });
  it("distance to liquidation is 1 − 1/HF as a fraction of the collateral price", () => {
    expect(dropToLiquidation(1.25)).toBeCloseTo(0.2, 10);
    expect(dropToLiquidation(1)).toBe(0);
    expect(dropToLiquidation(0.9)).toBe(0);
    expect(dropToLiquidation(Infinity)).toBe(1);
  });
  it("evaluate: liquidation price is the oracle price where the health factor reaches 1.0", () => {
    const coll = 1_200_000n, shares = 1_000_000_000_000n; // debt 1,000,000 → max borrow 1,098,000 → HF 1.098
    const s = snap();
    const p = evaluate(USER, { supplyShares: 0n, borrowShares: shares, collateral: coll }, s);
    expect(p.debt).toBe(1_000_000n);
    expect(p.hfNumber).toBeCloseTo(1.098, 6);
    expect(p.dropToLiquidation).toBeCloseTo(1 - 1 / 1.098, 6);
    expect(healthFactor(coll, p.liquidationPrice!, LLTV, p.debt)! >= WAD).toBe(true);
    expect(healthFactor(coll, p.liquidationPrice! - ORACLE_PRICE_SCALE / 1_000_000n, LLTV, p.debt)! < WAD).toBe(true);
    expect(evaluate(USER, { supplyShares: 0n, borrowShares: 0n, collateral: coll }, s).hf).toBeNull();
  });
  it("a price shock lowers the health factor by the same fraction (what-if, same read)", () => {
    const r = row(1_200_000n, 1_000_000_000_000n);
    expect(shockedHf(r, 0.05)).toBeCloseTo(r.p.hfNumber * 0.95, 4);
    expect(evaluate(USER, { supplyShares: 0n, borrowShares: 1_000_000_000_000n, collateral: 1_200_000n }, snap(), 0.05).hfNumber).toBeCloseTo(r.p.hfNumber * 0.95, 4);
  });
});

describe("remedy: the concrete action", () => {
  it("repaying or adding the quoted amount reaches the target, and one unit less does not", () => {
    const coll = 1_200_000n, debt = 1_000_000n;
    const { repay, addCollateral } = remedy(coll, PRICE, LLTV, debt, 1.3);
    expect(repay).toBeGreaterThan(0n);
    expect(healthFactor(coll, PRICE, LLTV, debt - repay)! >= 1_300_000_000_000_000_000n).toBe(true);
    expect(healthFactor(coll, PRICE, LLTV, debt - repay + 2n)! < 1_300_000_000_000_000_000n).toBe(true);
    expect(healthFactor(coll + addCollateral, PRICE, LLTV, debt)! >= 1_300_000_000_000_000_000n).toBe(true);
    expect(healthFactor(coll + addCollateral - 2n, PRICE, LLTV, debt)! < 1_300_000_000_000_000_000n).toBe(true);
  });
  it("never asks for more than the whole debt and quotes nothing on a zero price", () => {
    expect(remedy(1n, PRICE, LLTV, 1_000_000n, 1.3).repay).toBe(1_000_000n); // collateral worth next to nothing: repay at most the debt
    expect(remedy(1_000n, 0n, LLTV, 100n, 1.3)).toEqual({ repay: 0n, addCollateral: 0n });
  });
  it("needs nothing when the position is already above the target or has no debt", () => {
    expect(remedy(10_000_000n, PRICE, LLTV, 1_000n, 1.3)).toEqual({ repay: 0n, addCollateral: 0n });
    expect(remedy(1_000n, PRICE, LLTV, 0n, 1.3)).toEqual({ repay: 0n, addCollateral: 0n });
  });
});

describe("thresholds, levels, hysteresis", () => {
  it("validates thresholds", () => {
    expect(checkThresholds(T)).toBe(T);
    expect(() => checkThresholds({ ...T, critical: 1 })).toThrow(/above 1.0/);
    expect(() => checkThresholds({ ...T, warn: 1.1 })).toThrow(/above --critical/);
    expect(() => checkThresholds({ ...T, rearm: 0.5 })).toThrow(/rearm/);
    expect(() => checkThresholds({ ...T, warn: NaN })).toThrow(/numbers/);
  });
  it("classifies at warn 1.3 and critical 1.1", () => {
    expect([2, 1.3, 1.2999, 1.1, 1.0999, 1.0, 0.99].map((h) => levelOf(h, T))).toEqual(["ok", "ok", "warn", "warn", "critical", "critical", "liquidatable"]);
  });
  it("worsening is reported at once; clearing waits until the health factor is `rearm` clear", () => {
    expect(nextLevel("ok", 1.25, T)).toBe("warn");
    expect(nextLevel("warn", 1.05, T)).toBe("critical");
    expect(nextLevel("warn", 1.305, T)).toBe("warn"); // hovering just above the line: no flapping
    expect(nextLevel("warn", 1.33, T)).toBe("ok");
    expect(nextLevel("critical", 1.115, T)).toBe("critical");
    expect(nextLevel("critical", 1.25, T)).toBe("warn"); // eases one band, not to ok
    expect(nextLevel("critical", 1.5, T)).toBe("ok");
    expect(nextLevel("ok", 5, T)).toBe("ok");
  });
});

describe("alert text", () => {
  it("has a timestamp, the state, the distance to liquidation and a concrete repay / add-collateral action", () => {
    const r = row(1_200_000n, 1_000_000_000_000n);
    const a = buildAlert("critical", r.snap, r.p, T, new Date("2026-10-24T10:00:00Z"));
    expect(a.text).toMatch(/^\[2026-10-24T10:00:00.000Z\] CRITICAL Morpho syzUSD\/USDC 0xA4a5…3DCc: health factor 1.0980/);
    expect(a.text).toContain("Liquidated if syzUSD falls 8.93% further");
    expect(a.text).toMatch(/Act now: repay [\d,.]+ USDC or add [\d,.]+ syzUSD collateral to get back to 1\.30\./);
    expect(buildAlert("liquidatable", r.snap, { ...r.p, hfNumber: 0.97 }, T, new Date()).text).toContain("Liquidatable now.");
  });
  it("labels a scenario and prices the action at the shocked price", () => {
    const r = row(1_200_000n, 1_000_000_000_000n);
    const hf = shockedHf(r, 0.1);
    const a = buildAlert("critical", r.snap, { ...r.p, hfNumber: hf }, T, new Date(), 0.1);
    expect(a.text).toContain("[scenario: syzUSD price −10.0%]");
    const plain = buildAlert("critical", r.snap, r.p, T, new Date());
    expect(a.text).not.toBe(plain.text);
  });
  it("formats token amounts", () => {
    expect(fmtToken(1_523_800_410_000n, 6)).toBe("1,523,800.41");
    expect(fmtToken(5n, 6)).toBe("0.000005"); // a tiny amount is never shown as 0.00
    expect(fmtToken(0n, 6)).toBe("0.00");
    expect(fmtToken(1_500_000n, 6)).toBe("1.50");
    expect(fmtHf(677060.0018)).toBe("> 1000");
    expect(fmtHf(1.01339)).toBe("1.0134");
    expect(fmtToken(10n ** 18n * 3n / 2n, 18)).toBe("1.50");
    expect(fmtToken(-1_500_000n, 6)).toBe("-1.50");
    expect(pct(0.0132)).toBe("1.32%");
  });
});

describe("table", () => {
  it("labels the level column as unshocked when a scenario is shown", () => {
    expect(tableText([row(1_200_000n, 1_000_000_000_000n)], 5, 0.05).split("\n")[0]).toContain("level now (unshocked)");
    expect(tableText([row(1_200_000n, 1_000_000_000_000n)], 5, 0).split("\n")[0]).toMatch(/\| level$/);
  });
  it("marks dust positions as listed but never alerted", () => {
    const r = { ...row(1_200_000n, 1_000_000_000_000n), dust: true };
    expect(tableText([r], 5, 0).split("\n")[1]).toContain("critical (dust, no alert)");
  });
  it("lists the closest to liquidation first and adds the scenario column", () => {
    const rows = sortRows([row(2_000_000n, 1_000_000_000_000n), row(1_100_000n, 1_000_000_000_000n)]);
    const text = tableText(rows, 10, 0.05);
    const lines = text.split("\n");
    expect(lines[0]).toContain("health at −5.0%");
    expect(lines[1]).toContain("| 1.0065 |");
    expect(lines[2]).toContain("| 1.8300 |");
    expect(tableText(rows, 1, 0).split("\n")).toHaveLength(2);
  });
});

describe("discovery", () => {
  const log = (id: string, user: string): { topics: [Hex, ...Hex[]] } => ({ topics: [BORROW_TOPIC, id as Hex, ("0x" + "0".repeat(24) + user.slice(2)) as Hex, ("0x" + "0".repeat(64)) as Hex] });
  it("collects each borrower once per market and ignores other events", () => {
    const idx = emptyIndex(0n, 10n);
    addBorrowers(idx, [log(ID, USER), log(ID, USER), log(ID, "0x00000000000000000000000000000000000000aa"), { topics: ["0x1234" as Hex, ID, ID] }, { topics: [] as [] }]);
    expect(idx.markets[ID]).toEqual([USER, getAddress("0x00000000000000000000000000000000000000aa")]);
  });
  it("scans in windows, saves progress and reuses the cache on both sides", async () => {
    const file = join(tmp(), "idx.json");
    const ranges: string[] = [];
    const call = (async (name: string, args: { fromBlock: string; toBlock: string }) => {
      expect(name).toBe("get_logs");
      ranges.push(`${args.fromBlock}-${args.toBlock}`);
      return Number(args.fromBlock) <= 2500 && Number(args.toBlock) >= 2500 ? [log(ID, USER)] : [];
    }) as never;
    const first = await discoverBorrowers(call, { from: 2000n, to: 3999n, cacheFile: file, chunk: 1000n });
    expect(first.reused).toBe(false);
    expect(first.scannedBlocks).toBe(2000n);
    expect(first.index.markets[ID]).toEqual([USER]);
    expect(loadIndex(file)).toMatchObject({ from: "2000", to: "3999" });
    ranges.length = 0;
    const second = await discoverBorrowers(call, { from: 1500n, to: 4499n, cacheFile: file, chunk: 1000n });
    expect(second.reused).toBe(true);
    expect(second.scannedBlocks).toBe(1000n); // 500 above + 500 below; the cached 2000 are not read again
    expect(ranges.sort()).toEqual(["1500-1999", "4000-4499"]);
    expect(loadIndex(file)).toMatchObject({ from: "1500", to: "4499" });
    ranges.length = 0;
    const third = await discoverBorrowers(call, { from: 2000n, to: 4499n, cacheFile: file });
    expect(third.scannedBlocks).toBe(0n);
    expect(ranges).toEqual([]);
  });
  it("refuses an index file that is not for Morpho Blue", () => {
    const file = join(tmp(), "bad.json");
    const idx = emptyIndex(0n, 1n);
    idx.morpho = "0x0000000000000000000000000000000000000009";
    return import("../src/lib/state.js").then(({ writeJsonAtomic }) => {
      writeJsonAtomic(file, idx);
      expect(() => loadIndex(file)).toThrow(/not a borrower index/);
      expect(readFileSync(file, "utf8")).toContain("0x0000000000000000000000000000000000000009");
    });
  });
  it("stops when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(discoverBorrowers((async () => []) as never, { from: 0n, to: 10n, signal: ac.signal })).rejects.toThrow(/interrupted/);
  });
});

// A fake Chain MCP that answers eth_call for the Morpho / oracle / token / IRM ABIs.
const abi = parseAbi([
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)",
  "function price() view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)",
]);
function fakeCall(opts: { rate?: bigint | "revert"; lltv?: bigint } = {}) {
  const P = snap().params;
  const seen: string[] = [];
  const fn = async (name: string, args: { transaction: { to: Hex; data: Hex }; block?: string }) => {
    expect(name).toBe("eth_call");
    const { functionName, args: a } = decodeFunctionData({ abi, data: args.transaction.data });
    seen.push(functionName);
    const enc = (v: unknown) => ({ result: encodeFunctionResult({ abi, functionName, result: v as never } as never) });
    switch (functionName) {
      case "idToMarketParams": return enc([P.loanToken, P.collateralToken, P.oracle, P.irm, opts.lltv ?? LLTV]);
      case "market": return enc([STATE.totalSupplyAssets, STATE.totalSupplyShares, STATE.totalBorrowAssets, STATE.totalBorrowShares, STATE.lastUpdate, 0n]);
      case "position": return enc([0n, 1_000_000_000_000n, 1_200_000n]);
      case "price": return enc([PRICE]);
      case "symbol": return enc([args.transaction.to === P.loanToken ? "USDC" : "syzUSD"]);
      case "decimals": return enc([args.transaction.to === P.loanToken ? 6 : 18]);
      case "borrowRateView":
        if (opts.rate === "revert") throw new Error("execution reverted");
        return enc([opts.rate ?? 0n]);
    }
    void a;
    throw new Error("unexpected call");
  };
  return { call: fn as never, seen };
}

describe("reads through the Chain MCP", () => {
  it("snapshots a market, accrues interest from the IRM and reads a position", async () => {
    const { call, seen } = fakeCall({ rate: 3_000_000_000n });
    const s = await snapshotMarket(call, ID, 1_000n + 86_400n);
    expect(s.accrued).toBe(true);
    expect(s.state.totalBorrowAssets).toBeGreaterThan(STATE.totalBorrowAssets);
    expect(s.loan).toEqual({ symbol: "USDC", decimals: 6 });
    expect(s.collateral).toEqual({ symbol: "syzUSD", decimals: 18 });
    expect(seen).toEqual(expect.arrayContaining(["idToMarketParams", "market", "price", "symbol", "decimals", "borrowRateView"]));
    expect(await readPosition(call, ID, USER)).toEqual({ supplyShares: 0n, borrowShares: 1_000_000_000_000n, collateral: 1_200_000n });
    const p = evaluate(USER, await readPosition(call, ID, USER), s);
    expect(p.debt).toBeGreaterThan(1_000_000n); // interest makes the debt, and so the health factor, worse than a stale read
  });
  it("says so when the IRM cannot be read and falls back to the stored totals", async () => {
    const s = await snapshotMarket(fakeCall({ rate: "revert" }).call, ID, 90_000n);
    expect(s.accrued).toBe(false);
    expect(s.state).toEqual(STATE);
  });
  it("fails closed on a market that does not exist and on a contract that returns nothing", async () => {
    await expect(snapshotMarket(fakeCall({ lltv: 0n }).call, ID, 1n)).rejects.toThrow(/does not exist/);
    const empty = (async () => ({ result: "0x" })) as never;
    await expect(readPosition(empty, ID, USER)).rejects.toThrow(/no data/);
    expect(MORPHO_BLUE).toBe("0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb");
  });
});

describe("CLI input checks (no network is touched)", () => {
  const ctx = { onExit() {}, signal: new AbortController().signal };
  const bad = (argv: string[], re: RegExp) => expect(main(ctx, argv)).rejects.toThrow(re);
  it("rejects bad thresholds, ids and addresses", async () => {
    await bad(["scan", "--warn", "1.05", "--critical", "1.1"], /above --critical/);
    await bad(["scan", "--critical", "1"], /above 1.0/);
    await bad(["scan", "--market", "0x1234"], /32-byte/);
    await bad(["position"], /needs --market and --user/);
    await bad(["position", "--market", ID, "--user", "nope"], /--user must be an address/);
    await bad(["scan", "--shock", "1.5"], /--shock/);
    await bad(["scan", "--min-debt", "-1"], /--min-debt/);
    await bad(["watch", "--proof", "x"], /--proof is for scan/);
    await bad(["flip"], /command/);
    await expect(main(ctx, ["scan", "--warn", "x"])).rejects.toBeInstanceOf(UsageError);
  });
});
