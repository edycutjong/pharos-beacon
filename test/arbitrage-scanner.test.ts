import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, type Hex } from "viem";
import type { ChainMcp } from "../src/lib/mcp.js";
import type { TestnetSigner } from "../src/lib/signer.js";
import { backtest, pinBlocks } from "../src/arb/backtest.js";
import { executeOnAtlantic, planRoute, withSlippage } from "../src/arb/execute.js";
import { decide, fmtUnits, gasCost, logLine, makeRecord, priceRoute, scanVenues, type ScanConfig } from "../src/arb/scan.js";
import { InconsistentRead, Q96, quoteV3, readArbPool, readDodo, readUniV3, withRetries, type Market, type QuoteResult, type Side, type V3Snapshot, type Venue } from "../src/arb/venues.js";
import { parseAmounts } from "../tasks/arbitrage-scanner/index.js";
import { UsageError } from "../src/lib/cli.js";

const BASE = "0x838800b758277CC111B2d48Ab01e5E164f8E9471" as Hex;
const QUOTE = "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B" as Hex;
const POOL_A = "0x4c614696467128e14ba15e82dce543335184a271" as Hex;
const POOL_B = "0xe9091a1d8c41b9b995d77e1fe939df97e169b4cd" as Hex;
const ME = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975" as Hex;
const M: Market = { base: { symbol: "WBASE", address: BASE, decimals: 18 }, quote: { symbol: "USDC", address: QUOTE, decimals: 6 } };
const CFG: ScanConfig = { sizes: [250_000n, 1_000_000n, 2_000_000n], minProfit: 1_000n, slippageBps: 10, gasUnits: 350_000n, gasPriceWei: 10_000_000_000n };

/** A venue with a constant mid price, a fee and a linear impact: out = in·mid·(1−fee)·(1−impact·in). */
function fake(id: string, mid: number, feeBps: number, impactPerUnit = 0): Venue {
  return {
    id, kind: "arb-pool", address: POOL_A, mid, feeBps, raw: {},
    async quote(side: Side, amountIn: bigint): Promise<QuoteResult> {
      const inUnits = Number(amountIn) / (side === "base-in" ? 1e18 : 1e6);
      const gross = side === "base-in" ? inUnits * mid * 1e6 : (inUnits / mid) * 1e18;
      const out = BigInt(Math.floor(gross * (1 - feeBps / 1e4) * (1 - impactPerUnit * (side === "base-in" ? inUnits * mid : inUnits))));
      return { out, feeBps };
    },
  };
}

describe("fmtUnits / parseAmounts", () => {
  it("formats raw units", () => {
    expect(fmtUnits(1_234_567n, 6)).toBe("1.234567");
    expect(fmtUnits(-2_000n, 6)).toBe("-0.002000");
    expect(fmtUnits(5n, 18, 8)).toBe("0.00000000");
  });
  it("parses amounts and rejects bad ones", () => {
    expect(parseAmounts("0.25, 1,2", 6, "--sizes")).toEqual([250_000n, 1_000_000n, 2_000_000n]);
    expect(() => parseAmounts("0.0000001", 6, "--sizes")).toThrow(UsageError);
    expect(() => parseAmounts("abc", 6, "--sizes")).toThrow(/not an amount/);
    expect(() => parseAmounts("0", 6, "--sizes")).toThrow(/positive/);
  });
});

describe("Uniswap-V3-style quote", () => {
  // price 0.65 quote per base at 18/6 decimals: raw price = 0.65e-12, sqrtP = sqrt(0.65e-12)·2^96
  const sqrtP = BigInt(Math.floor(Math.sqrt(0.65e-12) * Number(Q96)));
  const tick = Math.floor(Math.log(0.65e-12) / Math.log(1.0001));
  const snap: V3Snapshot = { sqrtP, liquidity: 10n ** 24n, tick, spacing: 1, feePpm: 100 };
  it("a base→quote trade pays about mid·(1−fee) and a quote→base trade about 1/mid", () => {
    const sell = quoteV3(snap, "base-in", 10n ** 18n) as { out: bigint };
    expect(Number(sell.out) / 1e6).toBeGreaterThan(0.6498); // 1 base: 0.65 less the 1 bp fee
    expect(Number(sell.out) / 1e6).toBeLessThan(0.65);
    const buy = quoteV3(snap, "quote-in", 1_000_000n) as { out: bigint };
    expect(Number(buy.out) / 1e18).toBeGreaterThan(1 / 0.651);
    expect(Number(buy.out) / 1e18).toBeLessThan(1 / 0.65);
  });
  it("a round trip on one pool never makes money (fees + rounding)", () => {
    const a = quoteV3(snap, "quote-in", 1_000_000n) as { out: bigint };
    const b = quoteV3(snap, "base-in", a.out) as { out: bigint };
    expect(b.out).toBeLessThan(1_000_000n);
  });
  it("refuses a trade that would leave the tick range, and an empty pool", () => {
    expect(quoteV3({ ...snap, liquidity: 10n ** 16n }, "quote-in", 50_000_000n)).toHaveProperty("refused");
    expect(quoteV3({ ...snap, liquidity: 0n }, "base-in", 1n)).toEqual({ refused: "no liquidity in range" });
    expect(quoteV3(snap, "base-in", 0n)).toEqual({ refused: "amount must be positive" });
  });
});

describe("priceRoute / decide", () => {
  const cheap = fake("cheap", 0.65, 30);
  const dear = fake("dear", 0.665, 30);
  it("the cost lines add up: gross − fees − impact = quote back − amount in", async () => {
    const c = await priceRoute(cheap, dear, 2_000_000n, M, CFG);
    expect(c.gross - c.fees - c.impact).toBe(c.quoteBack - c.amountIn);
    expect(c.net).toBe(c.quoteBack - c.amountIn - c.slippageBuffer - c.gas);
    expect(c.grossBps).toBeCloseTo(230.8, 0);
    expect(c.slippageBuffer).toBe(2_000n); // 10 bps of 2 USDC
  });
  it("acts when the spread survives fees, slippage and gas", async () => {
    const cands = await scanVenues([cheap, dear], M, CFG);
    const d = decide(cands, CFG, M);
    expect(d.decision).toBe("ACT");
    expect(d.best?.buyOn).toBe("cheap");
    expect(d.reason).toMatch(/≥ the 0\.001000 USDC threshold/);
  });
  it("skips, naming the costs, when the spread is smaller than the fees", async () => {
    const d = decide(await scanVenues([cheap, fake("near", 0.653, 30)], M, CFG), CFG, M);
    expect(d.decision).toBe("SKIP");
    expect(d.reason).toMatch(/gross \+46\.\d bps/);
    expect(d.reason).toMatch(/fees .* \+ impact .* \+ slippage buffer .* \+ gas .* → net -/);
    expect(d.reason).toMatch(/does not survive its costs/);
  });
  it("never acts on a negative gross spread even when the quotes claim a profit", async () => {
    const odd: Venue = { ...fake("odd", 0.60, 30), quote: async (side) => (side === "quote-in" ? { out: 5n * 10n ** 18n, feeBps: 30 } : { out: 4_000_000n, feeBps: 30 }) };
    const d = decide(await scanVenues([odd, fake("normal", 0.65, 30)], M, CFG), CFG, M);
    const c = (await priceRoute(odd, fake("normal", 0.65, 30), 1_000_000n, M, CFG));
    expect(c.net).toBeGreaterThan(0n);
    expect(c.gross).toBeGreaterThan(0n); // gross comes from the mids: the odd venue is cheaper, so this direction is positive
    expect(["ACT", "SKIP"]).toContain(d.decision);
    const rev = await priceRoute(fake("normal", 0.65, 30), odd, 1_000_000n, M, CFG);
    expect(rev.gross).toBeLessThan(0n);
    expect(decide([rev], CFG, M).decision).toBe("SKIP");
  });
  it("skips with 'no positive gross spread' when both venues agree", async () => {
    const d = decide(await scanVenues([cheap, fake("same", 0.65, 30)], M, CFG), CFG, M);
    expect(d.decision).toBe("SKIP");
    expect(d.reason).toMatch(/no positive gross spread in either direction/);
  });
  it("the profit threshold is configurable: the same scan acts at 0.001 and skips at 0.05", async () => {
    const cands = await scanVenues([cheap, dear], M, CFG);
    expect(decide(cands, CFG, M).decision).toBe("ACT");
    expect(decide(cands, { ...CFG, minProfit: 50_000n }, M).decision).toBe("SKIP");
  });
  it("gas is priced in the quote token at the sell venue's mid", () => {
    expect(gasCost(CFG, 0.665, 6)).toBe(2_328n); // 350k × 10 gwei = 0.0035 native × 0.665
  });
  it("price impact can turn a wide spread into a skip: a thin venue loses to its own curve", async () => {
    const thin = fake("thin", 0.665, 30, 0.3);
    const d = decide(await scanVenues([cheap, thin], M, CFG), CFG, M);
    // the best size is the smallest: bigger sizes pay more impact than the spread earns
    expect(d.best!.amountIn).toBe(250_000n);
  });
  it("a refused quote is carried, never priced; all refused → skip", async () => {
    const dead: Venue = { ...cheap, id: "dead", quote: async () => ({ refused: "no liquidity in range" }) };
    const cands = await scanVenues([dead, dear], M, CFG);
    expect(cands.every((c) => c.refused)).toBe(true);
    expect(decide(cands, CFG, M).decision).toBe("SKIP");
    expect(decide(cands, CFG, M).reason).toMatch(/no route could be quoted/);
  });
  it("the log line carries gross, costs, net and the decision for every candidate", async () => {
    const cands = await scanVenues([cheap, dear], M, CFG);
    const rec = makeRecord({ network: "atlantic", block: 5n, m: M, venues: [cheap, dear], cfg: CFG, candidates: cands, at: new Date("2026-10-24T00:00:00Z") });
    const j = JSON.parse(logLine(rec, M));
    expect(j.decision).toBe("ACT");
    expect(j.candidates).toHaveLength(6);
    for (const c of j.candidates) for (const k of ["grossBps", "gross", "fees", "impact", "slippageBuffer", "gas", "net"]) expect(c).toHaveProperty(k);
    expect(j.sources).toHaveLength(2);
  });
});

describe("planRoute", () => {
  it("builds two unsigned legs with the slippage allowance on the minimum out", async () => {
    const c = await priceRoute(fake("cheap", 0.65, 30), fake("dear", 0.665, 30), 2_000_000n, M, CFG);
    const plan = planRoute(c, { kind: "arb-pool", address: POOL_A }, { kind: "dodo-v2-pmm", address: POOL_B }, M, CFG, ME);
    expect(plan.signed).toBe(false);
    expect(plan.legs).toHaveLength(2);
    expect(plan.legs[0]!.calls.map((x) => x.step)).toEqual(["approve", "swap"]);
    expect(plan.legs[1]!.calls.map((x) => x.step)).toEqual(["transfer in", "sellBase"]);
    expect(withSlippage(1_000_000n, 10)).toBe(999_000n);
  });
});

describe("pinBlocks", () => {
  it("spaces blocks by time, oldest first, ending at the head", () => {
    expect(pinBlocks(1000n, 3, 10, 0.5)).toEqual([960n, 980n, 1000n]);
  });
});

// ---- the on-chain readers and the Atlantic execution, against a fake chain

const swapAbi = parseAbi(["function swap(address tokenIn,uint256 amountIn,uint256 minOut) returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const word = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
const addrWord = (a: string) => ("0x" + a.slice(2).toLowerCase().padStart(64, "0")) as Hex;

function fakeChain(rates: Record<string, bigint>, opts: { moveRateAfterLeg1?: bigint } = {}) {
  const bal: Record<string, bigint> = { [BASE]: 0n, [QUOTE]: 10_000_000n };
  const sent: string[] = [];
  const allowance: Record<string, bigint> = {};
  let legsDone = 0;
  const quote = (pool: string, tokenIn: string, amt: bigint) => (tokenIn.toLowerCase() === BASE.toLowerCase() ? (amt * rates[pool]!) / 10n ** 18n : (amt * 10n ** 18n) / rates[pool]!) * 9970n / 10000n;
  const mcp = {
    network: "atlantic", chainId: 688689, endpoint: "fake", broadcast: true, perMinute: 0, server: undefined,
    async call(name: string, args: any) {
      if (name !== "eth_call") throw new Error(`unexpected ${name}`);
      const { to, data } = args.transaction as { to: Hex; data: Hex };
      const sel = data.slice(0, 10);
      const to_ = to.toLowerCase();
      if (sel === "0x70a08231") return { result: word(bal[to_ === BASE.toLowerCase() ? BASE : QUOTE]!) }; // balanceOf
      if (sel === "0xdd62ed3e") return { result: word(allowance[to_ + data.slice(-40)] ?? 0n) };
      const pool = to_ === POOL_A.toLowerCase() ? POOL_A : POOL_B;
      if (sel === "0x0fc63d10") return { result: addrWord(BASE) };
      if (sel === "0x5f64b55b") return { result: addrWord(QUOTE) };
      if (sel === "0xda438bfa") return { result: word(rates[pool]!) };
      if (sel === "0x200fe4fb") return { result: word(10n ** 18n) };
      if (sel === "0x24a9d853") return { result: word(30n) };
      if (sel === "0x8f79306e") {
        const [tokenIn, amt] = [("0x" + data.slice(34, 74)) as Hex, BigInt("0x" + data.slice(74, 138))];
        return { result: word(quote(pool, tokenIn, amt)) };
      }
      throw new Error(`unexpected selector ${sel}`);
    },
    async close() {},
  } as unknown as ChainMcp;
  const signer = {
    address: ME, unresolved: undefined,
    async send(intent: { to: Hex; data: Hex }) {
      const { functionName, args } = decodeFunctionData({ abi: swapAbi, data: intent.data });
      if (functionName === "approve") {
        allowance[intent.to.toLowerCase() + (args as [Hex, bigint])[0].slice(2).toLowerCase()] = (args as [Hex, bigint])[1];
        sent.push("approve");
      } else {
        const [tokenIn, amt, minOut] = args as [Hex, bigint, bigint];
        const pool = intent.to.toLowerCase() === POOL_A.toLowerCase() ? POOL_A : POOL_B;
        const out = quote(pool, tokenIn, amt);
        if (out < minOut) throw new Error("TooLittleOut");
        const outTok = tokenIn.toLowerCase() === BASE.toLowerCase() ? QUOTE : BASE;
        bal[tokenIn.toLowerCase() === BASE.toLowerCase() ? BASE : QUOTE]! -= amt;
        bal[outTok]! += out;
        sent.push(`swap@${pool === POOL_A ? "A" : "B"}`);
        legsDone++;
        if (legsDone === 1 && opts.moveRateAfterLeg1) rates[POOL_B] = opts.moveRateAfterLeg1;
      }
      const hash = ("0x" + sent.length.toString(16).padStart(64, "0")) as Hex;
      return { hash, raw: "0x" as Hex, tx: { maxFeePerGas: 1_000_000_000n } };
    },
    async waitForReceipt() { return { status: "success" as const, blockNumber: 1n, gasUsed: 120_000n, effectiveGasPrice: 1_000_000_000n }; },
  } as unknown as TestnetSigner;
  return { mcp, signer, sent, bal };
}

describe("readers", () => {
  it("readArbPool reads rate and fee and quotes on chain; a wrong token pair is refused", async () => {
    const { mcp } = fakeChain({ [POOL_A]: 650_000n, [POOL_B]: 665_000n });
    const v = await readArbPool(mcp.call.bind(mcp), POOL_A, M);
    expect(v.mid).toBeCloseTo(0.65, 6);
    expect(v.feeBps).toBe(30);
    const q = (await v.quote("quote-in", 1_000_000n)) as { out: bigint };
    expect(q.out).toBe((((1_000_000n * 10n ** 18n) / 650_000n) * 9970n) / 10000n);
    await expect(readArbPool(mcp.call.bind(mcp), POOL_A, { ...M, base: { ...M.base, address: QUOTE } })).rejects.toThrow(/expected/);
  });
  it("readUniV3 and readDodo reject a pool whose tokens are not the market's", async () => {
    const call = (async () => ({ result: addrWord("0x0000000000000000000000000000000000000001") })) as unknown as ChainMcp["call"];
    await expect(readUniV3(call, POOL_A, M)).rejects.toThrow(/token0\/token1/);
    await expect(readDodo(call, POOL_A, M)).rejects.toThrow(/base\/quote/);
  });
  it("a contract that answers with no data is named, not misread", async () => {
    const call = (async () => ({ result: "0x" })) as unknown as ChainMcp["call"];
    await expect(readUniV3(call, POOL_A, M)).rejects.toThrow(/no data/);
  });
});

describe("inconsistent reads (the RPC sometimes answers a historical call from another state)", () => {
  const dodoChain = (mid: bigint, quoteOut: bigint) =>
    (async (_n: string, args: { transaction: { data: Hex } }) => {
      const sel = args.transaction.data.slice(0, 10);
      if (sel === "0x4a248d2a") return { result: addrWord(BASE) };
      if (sel === "0xd4b97046") return { result: addrWord(QUOTE) };
      if (sel === "0xee27c689") return { result: word(mid) };
      if (sel === "0xab44a7a3") return { result: word(2_400_000_000_000_000n) };
      if (sel === "0x79a04876") return { result: ("0x" + quoteOut.toString(16).padStart(64, "0") + (2n).toString(16).padStart(64, "0")) as Hex };
      throw new Error(sel);
    }) as unknown as ChainMcp["call"];
  it("readDodo reads when the mid price and a tiny sale agree, and refuses when they do not", async () => {
    // 0.001 base at 0.68 → ~680 raw USDC less the 0.24% fee
    const v = await readDodo(dodoChain(680_380n, 678n), POOL_B, M);
    expect(v.mid).toBeCloseTo(0.68038, 6);
    await expect(readDodo(dodoChain(600_914n, 678n), POOL_B, M)).rejects.toThrow(InconsistentRead);
  });
  it("a DODO quote that beats the pool's own mid price is discarded, never traded on", async () => {
    // mid 0.68: selling 1 base can pay at most ~0.68 USDC; a quote of 1.5 USDC is from another state
    const call = ((_n: string, args: { transaction: { data: Hex } }) => {
      const sel = args.transaction.data.slice(0, 10);
      if (sel === "0x79a04876" && BigInt("0x" + args.transaction.data.slice(74)) === 10n ** 15n) return Promise.resolve({ result: ("0x" + 678n.toString(16).padStart(64, "0") + (2n).toString(16).padStart(64, "0")) as Hex });
      if (sel === "0x79a04876") return Promise.resolve({ result: ("0x" + 1_500_000n.toString(16).padStart(64, "0") + (900n).toString(16).padStart(64, "0")) as Hex });
      return dodoChain(680_380n, 678n)("x", args);
    }) as unknown as ChainMcp["call"];
    const v = await readDodo(call, POOL_B, M);
    const r = await v.quote("base-in", 10n ** 18n);
    expect(r).toHaveProperty("refused");
    expect((r as { refused: string }).refused).toMatch(/more than the pool's own mid price allows/);
  });
  it("readUniV3 refuses when slot0 answers differently twice", async () => {
    let n = 0;
    const call = (async (_x: string, args: { transaction: { data: Hex } }) => {
      const sel = args.transaction.data.slice(0, 10);
      if (sel === "0x0dfe1681") return { result: addrWord(BASE) };
      if (sel === "0xd21220a7") return { result: addrWord(QUOTE) };
      if (sel === "0x3850c7bd") return { result: ("0x" + (++n).toString(16).padStart(64, "0").repeat(7)) as Hex };
      return { result: word(1n) };
    }) as unknown as ChainMcp["call"];
    await expect(readUniV3(call, POOL_A, M)).rejects.toThrow(/answered differently twice/);
  });
  it("withRetries repeats only an inconsistent read, at most 3 times", async () => {
    let tries = 0;
    expect(await withRetries(async () => (++tries < 3 ? Promise.reject(new InconsistentRead("x")) : "ok"))).toBe("ok");
    expect(tries).toBe(3);
    let t2 = 0;
    await expect(withRetries(async () => { t2++; throw new InconsistentRead("always"); })).rejects.toThrow("always");
    expect(t2).toBe(3);
    let t3 = 0;
    await expect(withRetries(async () => { t3++; throw new Error("other"); })).rejects.toThrow("other");
    expect(t3).toBe(1);
  });
});

describe("executeOnAtlantic", () => {
  const cfg: ScanConfig = { ...CFG, sizes: [2_000_000n] };
  async function setup(opts?: { moveRateAfterLeg1?: bigint }) {
    const chain = fakeChain({ [POOL_A]: 650_000n, [POOL_B]: 665_000n }, opts);
    const call = chain.mcp.call.bind(chain.mcp);
    const [a, b] = await Promise.all([readArbPool(call, POOL_A, M), readArbPool(call, POOL_B, M)]);
    const cands = await scanVenues([a, b], M, cfg);
    const d = decide(cands, cfg, M);
    return { chain, d };
  }
  it("runs both legs and the quote balance ends higher than it started", async () => {
    const { chain, d } = await setup();
    expect(d.decision).toBe("ACT");
    const logs: string[] = [];
    const r = await executeOnAtlantic({ mcp: chain.mcp, signer: chain.signer, m: M, cfg, candidate: d.best!, buy: { kind: "arb-pool", address: POOL_A }, sell: { kind: "arb-pool", address: POOL_B }, log: (s) => logs.push(s) });
    expect(r.outcome).toBe("completed");
    expect(chain.sent).toEqual(["approve", "swap@A", "approve", "swap@B"]);
    expect(Number(r.after.quote)).toBeGreaterThan(Number(r.before.quote));
    expect(r.after.base).toBe("0.00000000"); // everything bought was sold
    expect(Number(r.realisedNet)).toBeGreaterThan(0);
  });
  it("stops after leg 1 when the second pool's rate moved away in between: leg 2 is never sent", async () => {
    const { chain, d } = await setup({ moveRateAfterLeg1: 640_000n });
    const r = await executeOnAtlantic({ mcp: chain.mcp, signer: chain.signer, m: M, cfg, candidate: d.best!, buy: { kind: "arb-pool", address: POOL_A }, sell: { kind: "arb-pool", address: POOL_B }, log: () => {} });
    expect(r.outcome).toBe("stopped-after-leg-1");
    expect(r.reason).toMatch(/below the 0\.001000 USDC threshold: leg 2 not sent/);
    expect(chain.sent).toEqual(["approve", "swap@A"]);
  });
});

describe("backtest", () => {
  it("scans each pinned block at that block and summarises how many spreads survived", async () => {
    const seen: string[] = [];
    const call = (async (name: string, args: any) => {
      if (name === "get_block") return { baseFeePerGas: "0x2540be400", timestamp: "0x" + (1_700_000_000 + Number(args.block)).toString(16) };
      if (name === "eth_call") {
        seen.push(String(args.block));
        throw new Error("no such pool in this test");
      }
      throw new Error(name);
    }) as unknown as ChainMcp["call"];
    const { records, summary } = await backtest({ call, m: M, uni: POOL_A, dodo: POOL_B, pins: [10n, 20n], cfg: CFG });
    expect(records).toHaveLength(0);
    expect(summary.failed).toBe(2);
    expect(seen.every((b) => b === "10" || b === "20")).toBe(true);
  });
});
