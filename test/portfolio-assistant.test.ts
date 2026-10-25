import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, pad, parseAbi, toHex, type Hex } from "viem";
import { UsageError } from "../src/lib/cli.js";
import { answerQuestion, classify, detectLang, sourceTable, valueOf, type Answer, type Intent, type Reads } from "../src/portfolio/ask.js";
import { diffSnapshots } from "../src/portfolio/change.js";
import { FactBook, MORPHO_MARKETS, agreeing, type Fact, PROS_POOL, USDC, VAULTS, WPROS, readSnapshot, vaultYield, type Call, type Snapshot } from "../src/portfolio/read.js";
import { main, REPORT_QUESTION } from "../tasks/portfolio-assistant/index.js";

const ME = getAddress("0x1111111111111111111111111111111111111111");
const ROX = VAULTS[0]!;
const JT = VAULTS[1]!;
const MORPHO = getAddress("0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb");
const ORACLE = getAddress("0x00000000000000000000000000000000000000a1");
const COLL = getAddress("0x00000000000000000000000000000000000000c1");
const IRM = getAddress("0x00000000000000000000000000000000000000b1");
const T0 = 1_700_000_000n;
const HEAD = 1_000_000n;
const EARLIER = HEAD - 86_400n * 3n; // 1 s blocks → 3 days before

// ---------------------------------------------------------------- a fake Pharos mainnet (selector-level), values may depend on the block

const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function price() view returns (uint256)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);

interface World {
  native: (b: bigint) => bigint;
  usdc: (b: bigint) => bigint;
  wpros: (b: bigint) => bigint;
  rox: (b: bigint) => bigint;
  /** assets (6 dec) per 1 roxUSDC share (1e18) */
  roxPrice: (b: bigint) => bigint;
  jtrsy: (b: bigint) => bigint;
  collateral: (b: bigint) => bigint;
  borrowShares: (b: bigint) => bigint;
  /** sqrt price for the WPROS/USDC pool: USDC per WPROS */
  prosPrice: number;
  /** tools / selectors that throw */
  broken: Set<string>;
  /** addresses with no code at the block read (not deployed yet) */
  noCode: Set<string>;
}

const base = (): World => ({
  native: () => 2n * 10n ** 18n,
  usdc: () => 1_000_000_000n, // 1,000 USDC
  wpros: () => 100n * 10n ** 18n,
  rox: () => 5_000n * 10n ** 18n,
  roxPrice: (b) => (b >= HEAD ? 1_010_000n : 1_000_000n),
  jtrsy: () => 0n,
  collateral: () => 0n,
  borrowShares: () => 0n,
  prosPrice: 0.5,
  broken: new Set(),
  noCode: new Set(),
});

const word = (n: bigint) => pad(toHex(n), { size: 32 });
const addrWord = (a: Hex) => pad(a, { size: 32 });

function fakeChain(w: World, spy: { tool: string; args: any }[] = []): Call {
  const call = async (tool: string, args: any = {}) => {
    spy.push({ tool, args });
    if (w.broken.has(tool)) throw new Error(`${tool} is down`);
    if (tool === "get_block_number") return { blockNumber: HEAD.toString() };
    if (tool === "get_block") return { number: toHex(BigInt(args.block)), timestamp: toHex(T0 + BigInt(args.block)) };
    if (tool === "get_code") return { code: w.noCode.has(getAddress(args.address)) ? "0x" : "0x6080" };
    if (tool === "get_balance") return { balanceWei: w.native(BigInt(args.block ?? HEAD)).toString() };
    if (tool !== "eth_call") throw new Error(`unexpected tool ${tool}`);
    const b = BigInt(args.block ?? HEAD);
    const to = getAddress(args.transaction.to);
    const data = args.transaction.data as Hex;
    const raw = (r: Hex) => ({ result: r });
    // the Uniswap-V3-style price pool (raw selectors)
    if (to === PROS_POOL) {
      if (data === "0x0dfe1681") return raw(addrWord(WPROS.address));
      if (data === "0xd21220a7") return raw(addrWord(USDC.address));
      if (data === "0x3850c7bd") {
        const sqrtP = BigInt(Math.floor(Math.sqrt(w.prosPrice / 1e12) * 2 ** 96));
        return raw(("0x" + [word(sqrtP), word(60n), word(0n), word(1n), word(1n), word(0n), word(1n)].map((x) => x.slice(2)).join("")) as Hex);
      }
      if (data === "0x1a686502") return raw(word(10n ** 18n));
      if (data === "0xd0c93a7c") return raw(word(1n));
      if (data === "0xddca3f43") return raw(word(100n));
    }
    const { functionName, args: a } = decodeFunctionData({ abi, data });
    const enc = (v: unknown) => raw(encodeFunctionResult({ abi, functionName: functionName as never, result: v as never }));
    const key = `${to}.${functionName}`;
    if (w.broken.has(key)) throw new Error("execution reverted");
    if (functionName === "balanceOf") {
      if (to === USDC.address) return enc(w.usdc(b));
      if (to === WPROS.address) return enc(w.wpros(b));
      if (to === ROX.share) return enc(w.rox(b));
      if (to === JT.share) return enc(w.jtrsy(b));
      return enc(0n);
    }
    if (functionName === "convertToAssets") {
      const shares = a![0] as bigint;
      if (to === ROX.vault) return enc((shares * w.roxPrice(b)) / 10n ** 18n);
      if (to === JT.vault) return enc((shares * 1_120_000n) / 10n ** 6n);
    }
    if (functionName === "decimals") return enc(to === COLL ? 18 : to === ROX.share ? 18 : 6);
    if (functionName === "symbol") return enc(to === COLL ? "syzUSD" : "USDC");
    if (to === MORPHO && functionName === "position") {
      return enc(String(a![0]) === MORPHO_MARKETS[0] ? [0n, w.borrowShares(b), w.collateral(b)] : [0n, 0n, 0n]);
    }
    if (to === MORPHO && functionName === "idToMarketParams") return enc([USDC.address, COLL, ORACLE, IRM, 915_000_000_000_000_000n]);
    if (to === MORPHO && functionName === "market") return enc([2_000_000_000_000n, 2_000_000_000_000_000_000n, 1_000_000_000_000n, 1_000_000_000_000_000_000n, T0, 0n]);
    if (to === ORACLE && functionName === "price") return enc(10n ** 24n); // 1 collateral (18 dec) = 1 USDC (6 dec): the oracle scale folds the decimals in
    throw new Error(`fake chain: no answer for ${to} ${functionName}`);
  };
  return call as unknown as Call;
}

const snapshot = (w: World, at?: bigint, book = new FactBook()) => readSnapshot(fakeChain(w), ME, book, at);

// ---------------------------------------------------------------- classify

describe("question → intent (English and Bahasa Indonesia)", () => {
  const cases: [string, Intent["type"]][] = [
    ["How much USDC do I have?", "balance"],
    ["what is my WPROS balance", "balance"],
    ["where is my USDC?", "where"],
    ["Where are my PROS tokens", "where"],
    ["what's my biggest position?", "biggest"],
    ["what am I earning?", "earning"],
    ["what yield do I get", "earning"],
    ["do I owe anything?", "debt"],
    ["am I close to liquidation?", "debt"],
    ["what is my total portfolio value?", "total"],
    ["what do I hold?", "list"],
    ["show my positions", "list"],
    ["what changed since block 999000?", "changed"],
    ["what changed in the last 3 days", "changed"],
    ["berapa saldo USDC saya?", "balance"],
    ["di mana USDC saya?", "where"],
    ["apa posisi terbesar saya?", "biggest"],
    ["apa yang menghasilkan bunga?", "earning"],
    ["apakah saya punya utang?", "debt"],
    ["berapa total nilai portofolio saya?", "total"],
    ["apa yang berubah sejak kemarin?", "changed"],
    ["apa saja yang saya punya?", "list"],
  ];
  it.each(cases)("%s → %s", (q, type) => expect(classify(q).type).toBe(type));

  it("extracts the token, the block and the number of days", () => {
    expect(classify("How much USDC do I have?")).toEqual({ type: "balance", token: "USDC" });
    expect(classify("where is my roxUSDC")).toEqual({ type: "where", token: "roxUSDC" });
    expect(classify("what changed since block 21000000?")).toEqual({ type: "changed", sinceBlock: 21_000_000n, sinceDays: undefined });
    expect(classify("what changed in the last 3 days")).toMatchObject({ type: "changed", sinceDays: 3 });
    expect(classify("apa yang berubah sejak kemarin?")).toMatchObject({ type: "changed", sinceDays: 1 });
  });

  it("declines protocols it does not read, price predictions and tokens it has never heard of", () => {
    expect(classify("what is my Harbor position?")).toEqual({ type: "unsupported", reason: "protocol", name: "Harbor" });
    expect(classify("how much do I have in Aave?")).toMatchObject({ type: "unsupported", reason: "protocol" });
    expect(classify("will PROS go up next week?")).toMatchObject({ type: "unsupported", reason: "advice" });
    expect(classify("should I buy more PROS")).toMatchObject({ type: "unsupported", reason: "advice" });
    expect(classify("how much DOGE do I have?")).toEqual({ type: "unsupported", reason: "token", name: "DOGE" });
    expect(classify("where is my DOGE")).toEqual({ type: "unsupported", reason: "token", name: "DOGE" });
    expect(classify("berapa saldo SHIB saya?")).toMatchObject({ type: "unsupported", reason: "token", name: "SHIB" });
    expect(classify("sing me a song").type).toBe("unknown");
  });

  it("detects the language", () => {
    expect(detectLang("berapa saldo USDC saya?")).toBe("id");
    expect(detectLang("how much USDC do I have?")).toBe("en");
  });
});

// ---------------------------------------------------------------- reads

describe("readSnapshot", () => {
  it("reads wallet tokens, a vault and a Morpho position at ONE block, each fact citing contract + call + block", async () => {
    const w = base();
    w.collateral = () => 2_000n * 10n ** 18n;
    w.borrowShares = () => 10n ** 15n; // market: 1e12 assets per 1e18 shares → debt 1,000 USDC
    const s = await snapshot(w);
    expect(s.block).toBe(HEAD);
    const kinds = s.positions.map((p) => p.kind).sort();
    expect(kinds).toEqual(["morpho", "token", "token", "token", "vault"]);
    const usdc = s.positions.find((p) => p.kind === "token" && p.symbol === "USDC");
    expect(usdc).toMatchObject({ usd: 1_000 });
    const pros = s.positions.find((p) => p.kind === "token" && p.symbol === "PROS");
    expect(pros).toMatchObject({ usd: expect.closeTo(1, 6) }); // 2 PROS × 0.5
    const vault = s.positions.find((p) => p.kind === "vault")!;
    if (vault.kind !== "vault") throw new Error();
    expect(vault.shares.raw).toBe(5_000n * 10n ** 18n);
    expect(vault.assets.raw).toBe(5_050_000_000n); // 5,000 shares × 1.010000 (after the price step at HEAD)
    expect(vault.assets.source).toEqual({ contract: ROX.vault, call: "convertToAssets(shares)", block: HEAD });
    expect(vault.usd).toBeCloseTo(5_050, 6);
    const m = s.positions.find((p) => p.kind === "morpho")!;
    if (m.kind !== "morpho") throw new Error();
    expect(m.collateral.source).toMatchObject({ contract: MORPHO, block: HEAD });
    expect(m.collateralValue.source.contract).toBe(ORACLE); // valued by the market's own oracle
    expect(m.hf).not.toBeNull();
    // every fact id in the positions exists in the book with its block
    const factsOf = (p: (typeof s.positions)[number]): Fact[] => Object.values(p).filter((v): v is Fact => typeof v === "object" && v !== null && "source" in v);
    for (const p of s.positions) for (const f of factsOf(p)) expect(f.source.block).toBe(HEAD);
  });

  it("an earlier block is read at THAT block (eth_call and get_balance both carry it)", async () => {
    const spy: { tool: string; args: any }[] = [];
    const s = await readSnapshot(fakeChain(base(), spy), ME, new FactBook(), EARLIER);
    expect(s.block).toBe(EARLIER);
    const pinned = spy.filter((c) => c.tool === "eth_call" || c.tool === "get_balance");
    expect(pinned.length).toBeGreaterThan(8);
    expect(pinned.every((c) => c.args.block === EARLIER.toString())).toBe(true);
    const vault = s.positions.find((p) => p.kind === "vault")!;
    if (vault.kind !== "vault") throw new Error();
    expect(vault.assets.raw).toBe(5_000_000_000n); // the older share price (1.000000)
  });

  it("is read-only: only read tools are ever called", async () => {
    const spy: { tool: string; args: any }[] = [];
    await readSnapshot(fakeChain(base(), spy), ME, new FactBook());
    expect(new Set(spy.map((c) => c.tool))).toEqual(new Set(["get_block_number", "get_block", "get_balance", "get_code", "eth_call"]));
  });

  it("a wallet with no PROS records the zero read of get_balance", async () => {
    const s = await snapshot({ ...base(), native: () => 0n });
    expect(s.zeros.find((f) => f.symbol === "PROS")).toMatchObject({ raw: 0n, source: { contract: "native", call: "get_balance", block: HEAD } });
    const book = new FactBook();
    const snap = await readSnapshot(fakeChain({ ...base(), native: () => 0n }), ME, book);
    const a = await answerQuestion("how much PROS do I have?", reads([snap], book));
    expect(a.text).toMatch(/no PROS here: the read returned 0 \[F\d+\]/);
  });

  it("a balance that is zero is recorded as a read, not skipped silently", async () => {
    const s = await snapshot(base());
    expect(s.zeros.map((f) => f.symbol).sort()).toEqual(["HYB", "JTRSY", "LINK", "WETH"].filter((x) => s.zeros.some((f) => f.symbol === x)).sort());
    const weth = s.zeros.find((f) => f.symbol === "WETH")!;
    expect(weth.raw).toBe(0n);
    expect(weth.source.call).toBe("balanceOf(wallet)");
    expect(s.marketsRead).toBe(MORPHO_MARKETS.length);
  });

  it("a source that cannot be read becomes an 'unreadable' entry; the rest of the portfolio still answers", async () => {
    const w = base();
    w.broken.add(`${JT.share}.balanceOf`);
    w.broken.add(`${PROS_POOL}.x`);
    const s = await snapshot(w);
    expect(s.unreadable.some((u) => u.protocol === "Fund vault" && /JTRSY share balance/.test(u.what))).toBe(true);
    expect(s.positions.some((p) => p.kind === "vault" && p.symbol === "roxUSDC")).toBe(true);
  });

  it("a contract with no code at the block is unreadable, NOT a zero balance (a call to an empty address returns 0x)", async () => {
    const w = base();
    w.noCode = new Set([MORPHO, JT.share, USDC.address]);
    const s = await snapshot(w);
    expect(s.unreadable.map((u) => `${u.protocol}: ${u.what}`)).toEqual(expect.arrayContaining(["Morpho Blue: the Morpho Blue contract", "Fund vault: JTRSY share balance", "Wallet: USDC balance"]));
    expect(s.unreadable.find((u) => u.protocol === "Morpho Blue")!.reason).toMatch(/no contract at 0x18573fA1.* at block 1000000 \(Morpho Blue not deployed yet/);
    expect(s.marketsRead).toBe(0);
    expect(s.zeros.some((f) => f.symbol === "USDC" || f.symbol === "JTRSY")).toBe(false);
    expect(s.positions.some((p) => p.kind === "token" && p.symbol === "USDC")).toBe(false);
  });

  it("with nothing readable the answers say so instead of 'you hold none'", async () => {
    const w = base();
    w.noCode = new Set([USDC.address, WPROS.address, ROX.share, JT.share, getAddress("0x4827C7ecce4f07ADfe44A97165f06A199e7d2505"), MORPHO, PROS_POOL, getAddress(JT.vault), getAddress("0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29"), getAddress("0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9")]);
    w.native = () => 0n;
    const h = await ask("what do I hold?", w);
    expect(h.a.text).not.toMatch(/no positions found/); // an empty list is not 'you hold nothing' when the sources were unreadable
    expect(h.a.text).toMatch(/I could not read Wallet: USDC balance/);
    expect(h.a.cites).toEqual([]);
    const u = await ask("how much USDC do I have?", w);
    expect(u.a.text).toContain("I have no successful read of USDC, so I cannot say what you hold");
    expect(u.a.text).not.toMatch(/You hold no USDC/);
    expect((await ask("berapa saldo USDC saya?", w)).a.text).toContain("Saya tidak punya bacaan USDC yang berhasil");
  });

  it("when Morpho cannot be read the answer to 'do I owe anything?' does NOT say 'no debt'; it says what it could not read", async () => {
    const w = base();
    w.noCode = new Set([MORPHO]);
    const { a } = await ask("do I owe anything?", w);
    expect(a.text).not.toMatch(/No debt/);
    expect(a.text).toMatch(/I could not read Morpho Blue: the Morpho Blue contract for 0x1111…1111 at block 1000000: no contract at/);
    const e = await ask("what am I earning?", w);
    expect(e.a.text).not.toMatch(/Nothing here earns/);
  });

  it("no price source → the position is listed but not valued (usd null), never guessed", async () => {
    const w = base();
    // a pool whose slot0 reverts: PROS cannot be priced
    const call = fakeChain(w);
    const broken: Call = (async (tool: string, args: any) => {
      if (tool === "eth_call" && args.transaction.data === "0x3850c7bd") throw new Error("execution reverted");
      return (call as any)(tool, args);
    }) as Call;
    const s = await readSnapshot(broken, ME, new FactBook());
    expect(s.unreadable.some((u) => /PROS price/.test(u.what))).toBe(true);
    expect(s.positions.find((p) => p.kind === "token" && p.symbol === "WPROS")).toMatchObject({ usd: null });
    expect(valueOf(s.positions.find((p) => p.kind === "token" && p.symbol === "WPROS")!)).toBeNull();
  });

  it("a node that answers slot0 differently twice for one block is asked again; after 4 tries the price is unreadable, not guessed", async () => {
    const call = fakeChain(base());
    let slot0Calls = 0;
    const flaky: Call = (async (tool: string, args: any) => {
      const r = await (call as any)(tool, args);
      if (tool === "eth_call" && args.transaction.data === "0x3850c7bd") {
        slot0Calls++;
        if (slot0Calls === 1) return { result: (r.result.slice(0, 66 - 4) + "ffff") as Hex }; // attempt 1: the two reads disagree
      }
      return r;
    }) as Call;
    const s = await readSnapshot(flaky, ME, new FactBook());
    expect(slot0Calls).toBeGreaterThanOrEqual(3); // the disagreeing read was repeated
    expect(s.unreadable.filter((u) => /PROS price/.test(u.what))).toEqual([]);
    expect(s.positions.find((p) => p.kind === "token" && p.symbol === "WPROS")).toMatchObject({ usd: expect.closeTo(50, 6) });
    let n = 0;
    const always: Call = (async (tool: string, args: any) => {
      const r = await (call as any)(tool, args);
      if (tool === "eth_call" && args.transaction.data === "0x3850c7bd") return { result: (r.result.slice(0, 62) + String(n++ % 2 ? "aaaa" : "bbbb")) as Hex };
      return r;
    }) as Call;
    const s2 = await readSnapshot(always, ME, new FactBook());
    expect(s2.unreadable.some((u) => /PROS price/.test(u.what) && /answered differently/.test(u.reason))).toBe(true);
    expect(s2.positions.find((p) => p.kind === "token" && p.symbol === "WPROS")).toMatchObject({ usd: null });
  });

  it("a verified (earlier-block) read asks twice, takes the agreed answer when one read was wrong, and refuses a node that never agrees", async () => {
    const real = fakeChain(base());
    let n = 0;
    const wrongOnce: Call = (async (tool: string, args: any) => {
      const r = await (real as any)(tool, args);
      if (tool === "eth_call" && args.transaction.data.startsWith("0x70a08231") && getAddress(args.transaction.to) === USDC.address && n++ === 0) return { result: pad(toHex(1_420_307_660_000n), { size: 32 }) }; // the first read of USDC is wrong
      return r;
    }) as Call;
    const s = await readSnapshot(wrongOnce, ME, new FactBook()); // head read: doubled too
    expect(s.positions.find((p) => p.kind === "token" && p.symbol === "USDC")).toMatchObject({ usd: 1_000 }); // not the wrong 1,420,307.66
    expect(s.unreadable).toEqual([]);
    let m = 0;
    const never: Call = (async (tool: string, args: any) => {
      const r = await (real as any)(tool, args);
      if (tool === "eth_call" && args.transaction.data.startsWith("0x70a08231") && getAddress(args.transaction.to) === USDC.address) return { result: pad(toHex(1_000_000_000n + BigInt(m++)), { size: 32 }) };
      return r;
    }) as Call;
    const s2 = await readSnapshot(never, ME, new FactBook(), EARLIER, true);
    expect(s2.unreadable.some((u) => /USDC balance/.test(u.what) && /answered differently on three reads/.test(u.reason))).toBe(true);
    expect(s2.positions.some((p) => p.kind === "token" && p.symbol === "USDC")).toBe(false);
    // verify defaults on (head reads too); off = single reads
    let k = 0;
    const counting: Call = (async (tool: string, args: any) => (k++, (real as any)(tool, args))) as Call;
    await readSnapshot(counting, ME, new FactBook(), EARLIER, false);
    const single = k;
    k = 0;
    await readSnapshot(counting, ME, new FactBook(), EARLIER);
    expect(k).toBeGreaterThan(single * 1.5);
    expect(typeof agreeing).toBe("function");
  });

  it("a falling share price is reported as read, not annualised into a yearly dollar loss", async () => {
    const w = base();
    const book = new FactBook();
    const snap = await readSnapshot(fakeChain(w), ME, book);
    const r = reads([snap], book, w);
    r.yieldOf = async (pos) => ({ fromBlock: 1n, toBlock: HEAD, days: 7, growth: -0.003, apy: -0.15, priceThen: book.add("then", 1_010_000n, 6, "USDC", { contract: pos.vault, call: "convertToAssets(1 share)", block: 1n }), priceNow: pos.sharePrice });
    const a = await answerQuestion("what am I earning?", r);
    expect(a.text).toMatch(/1 share fell 0\.300% over 7\.0 days.*a vault share price that falls is unusual; I report it as read and do not annualise it/);
    expect(a.text).not.toMatch(/APY|a year|-\$/);
    expect((await answerQuestion("apa yang menghasilkan bunga?", r)).text).toContain("turun 0.300%");
  });

  it("'where is my X' does not say 'you hold none' when X's balance was unreadable", async () => {
    const w = base();
    w.noCode = new Set([getAddress("0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9")]);
    const { a } = await ask("where is my WETH?", w);
    expect(a.text).not.toMatch(/You hold no WETH/);
    expect(a.text).toMatch(/I could not read Wallet: WETH balance/);
  });

  it("vault yield is the share-price growth over the window, annualised", async () => {
    const book = new FactBook();
    const now = await readSnapshot(fakeChain(base()), ME, book);
    const vault = now.positions.find((p) => p.kind === "vault")!;
    if (vault.kind !== "vault") throw new Error();
    const y = await vaultYield(fakeChain(base()), vault, EARLIER, T0 + EARLIER, now, book);
    expect(y.growth).toBeCloseTo(0.01, 9);
    expect(y.days).toBeCloseTo(3, 6);
    expect(y.apy).toBeCloseTo(Math.pow(1.01, 365 / 3) - 1, 6);
    expect(y.priceThen.raw).toBe(1_000_000n);
    expect(y.priceThen.source.block).toBe(EARLIER);
  });
});

// ---------------------------------------------------------------- answers

function reads(snaps: Snapshot[], book: FactBook, w: World = base()): Reads {
  return {
    snapshots: snaps,
    book,
    async earlier(sinceBlock) {
      return [await readSnapshot(fakeChain(w), ME, book, sinceBlock ?? EARLIER)];
    },
    async yieldOf(pos, snap, days) {
      return vaultYield(fakeChain(w), pos, HEAD - BigInt(days) * 86_400n, T0 + HEAD - BigInt(days) * 86_400n, snap, book);
    },
  };
}

async function ask(q: string, w = base()): Promise<{ a: Answer; book: FactBook; snap: Snapshot }> {
  const book = new FactBook();
  const snap = await readSnapshot(fakeChain(w), ME, book);
  const a = await answerQuestion(q, reads([snap], book, w));
  return { a, book, snap };
}

/** Every line that carries a number must carry its source ids (header and refusal lines carry none). */
function uncited(a: Answer): string[] {
  return a.text.split("\n").filter((l) => /\d/.test(l) && !/^(Wallet|Dompet) 0x|^Since block|^Sejak blok/.test(l) && !/\[F\d+/.test(l));
}

describe("answers", () => {
  it("how much USDC: the wallet balance with its source", async () => {
    const { a, book } = await ask("How much USDC do I have?");
    expect(a.text).toContain("1,000.0000 USDC in wallet");
    expect(a.cites.length).toBe(1);
    const f = book.facts.get(a.cites[0]!)!;
    expect(f).toMatchObject({ raw: 1_000_000_000n, symbol: "USDC" });
    expect(f.source).toEqual({ contract: USDC.address, call: "balanceOf(wallet)", block: HEAD });
    expect(uncited(a)).toEqual([]);
  });

  it("a balance of zero says so and cites the zero read", async () => {
    const { a, book } = await ask("how much WETH do I have?");
    expect(a.text).toMatch(/no WETH here: the read returned 0 \[F\d+\]/);
    expect(book.facts.get(a.cites[0]!)!.raw).toBe(0n);
  });

  it("where is my USDC: wallet + vault underlying (+ debt noted as borrowed, not held)", async () => {
    const w = base();
    w.collateral = () => 2_000n * 10n ** 18n;
    w.borrowShares = () => 5n * 10n ** 14n; // 500 USDC
    const { a } = await ask("where is my USDC?", w);
    expect(a.text).toMatch(/USDC: 1,000\.0000 USDC in wallet/);
    expect(a.text).toMatch(/USDC: 5,050\.00 USDC in roxUSDC vault \(RockawayX vault\)/);
    expect(a.text).toMatch(/USDC borrowed, not held/);
    expect(uncited(a)).toEqual([]);
  });

  it("biggest position ranks by value and lists what it could not value", async () => {
    const w = base();
    w.wpros = () => 100n * 10n ** 18n;
    const { a, snap } = await ask("what's my biggest position?", w);
    expect(a.text).toContain("Your biggest position is roxUSDC (RockawayX vault): $5,050.00");
    expect(a.text).toContain("Ranked #2: USDC in wallet $1,000.00");
    expect(a.cites).toContain(snap.positions.find((p) => p.kind === "vault" && p.symbol === "roxUSDC")!.kind === "vault" ? (snap.positions.find((p) => p.kind === "vault") as any).assets.id : "");
    expect(uncited(a)).toEqual([]);
  });

  it("a Morpho position in 'biggest' and 'total' is shown with its parts; several wallets say 'across these wallets'", async () => {
    const w = base();
    w.collateral = () => 20_000n * 10n ** 18n;
    w.borrowShares = () => 10n ** 15n; // debt 1,000 USDC
    const book = new FactBook();
    const s1 = await readSnapshot(fakeChain(w), ME, book);
    const a1 = await answerQuestion("what's my biggest position?", reads([s1], book, w));
    expect(a1.text).toContain("Your biggest position is Morpho Blue syzUSD/USDC (collateral + supply − debt): $19,000.00 = 20,000.00 USDC collateral + 0.00 USDC supplied − 1,000.00 USDC debt [F");
    const OTHER = getAddress("0x2222222222222222222222222222222222222222");
    const s2 = await readSnapshot(fakeChain(base()), OTHER, book);
    const a2 = await answerQuestion("what's my biggest position?", reads([s1, s2], book, w));
    expect(a2.text).toContain("The biggest position across these wallets is 0x1111…1111 · Morpho Blue");
    const idm = await answerQuestion("apa posisi terbesar saya?", reads([s1, s2], book, w));
    expect(idm.text).toContain("Posisi terbesar di dompet-dompet ini adalah");
    expect(idm.text).toContain("20,000.00 USDC jaminan + 0.00 USDC disuplai − 1,000.00 USDC utang");
    const tot = await answerQuestion("what is my total portfolio value?", reads([s1], book, w));
    expect(tot.text).toMatch(/Morpho Blue syzUSD\/USDC \(collateral \+ supply − debt\): \$19,000\.00 = 20,000\.00 USDC collateral/);
    expect(uncited(a1)).toEqual([]);
  });

  it("total value sums priced positions only and names the unpriced", async () => {
    const w = base();
    const { a } = await ask("what is my total portfolio value?", w);
    // 1,000 USDC + 5,050 roxUSDC + 100 WPROS × 0.5 + 2 PROS × 0.5
    expect(a.text).toContain("Total value: $6,101.00");
    expect(uncited(a)).toEqual([]);
  });

  it("debt: amount, collateral, health factor and the fall that would liquidate", async () => {
    const w = base();
    w.collateral = () => 1_200n * 10n ** 18n; // worth 1,200 USDC at the fake oracle
    w.borrowShares = () => 10n ** 15n; // debt 1,000 USDC → health 1,200 × 0.915 / 1,000
    const { a } = await ask("do I owe anything?", w);
    expect(a.text).toMatch(/Morpho Blue syzUSD\/USDC: debt [\d,.]+ USDC, collateral 1,200\.0000 syzUSD \[F\d+, F\d+\]; health factor 1\.0980 \(collateral 1,200\.00 USDC \[F\d+\]; may fall 8\.9% before liquidation\)/);
    expect(a.text).toMatch(/may fall [\d.]+% before liquidation/);
    expect(uncited(a)).toEqual([]);
  });

  it("no debt says so with the number of reads behind it", async () => {
    const { a } = await ask("do I owe anything?");
    expect(a.text).toMatch(/No debt in Morpho Blue \(6 position\(\) reads, block 1000000\)/);
  });

  it("earning: share-price growth over the window, APY, and the yearly amount, all cited", async () => {
    const { a, book } = await ask("what am I earning?");
    expect(a.text).toMatch(/roxUSDC \(RockawayX vault\): 1 share grew 1\.000% over 7\.0 days \(1\.000000 USDC → 1\.010000 USDC\) \[F\d+, F\d+\]/);
    expect(a.text).toMatch(/APY annualised/);
    expect(a.text).toContain("$5,050.00");
    const then = a.cites.map((id) => book.facts.get(id)!).find((f) => f.label.includes("earlier"))!;
    expect(then.source.block).toBe(HEAD - 7n * 86_400n);
    expect(uncited(a)).toEqual([]);
  });

  it("what changed since a block: value moves split into balance moves and price moves, summing to the total", async () => {
    const w = base();
    w.rox = (b) => (b >= HEAD ? 5_000n * 10n ** 18n : 4_000n * 10n ** 18n); // deposited 1,000 shares since
    const book = new FactBook();
    const snap = await readSnapshot(fakeChain(w), ME, book);
    const a = await answerQuestion("what changed since block 913600?", reads([snap], book, w));
    // before: 4,000 × 1.00 = 4,000 ; after: 5,000 × 1.01 = 5,050 ; moves 1,000 × 1.00 ; market 5,000 × 0.01 = 50
    expect(a.text).toMatch(/roxUSDC \(RockawayX vault\): 4,000\.0000 → 5,000\.0000 roxUSDC; \$4,000\.00 → \$5,050\.00 \(\+\$1,050\.00\): \+\$1,000\.00 from balances moving, \+\$50\.00 from prices\/rates moving/);
    expect(a.text).toMatch(/Net change in valued positions: \+\$1,050\.00/);
    expect(uncited(a)).toEqual([]);
  });

  it("what changed: a position that appeared or disappeared is labelled", async () => {
    const w = base();
    const book = new FactBook();
    const before = await readSnapshot(fakeChain({ ...w, jtrsy: () => 0n }), ME, book, EARLIER);
    const after = await readSnapshot(fakeChain({ ...w, jtrsy: () => 1_000_000n }), ME, book);
    const d = diffSnapshots(before, after);
    expect(d.rows.map((r) => r.key)).toContain("vault:JTRSY");
    const row = d.rows.find((r) => r.key === "vault:JTRSY")!;
    expect(row.amountBefore?.raw).toBe(0n); // the zero read is cited, not a bare 0
    expect(row.amountBefore?.source.block).toBe(EARLIER);
    expect(row.moves).toBeCloseTo(1.12, 6);
  });

  it("a Morpho row words its 'moves' part as amounts incl. accrued interest, not as balances moving", async () => {
    const w = base();
    w.collateral = (b) => (b >= HEAD ? 2_000n * 10n ** 18n : 1_500n * 10n ** 18n);
    w.borrowShares = () => 5n * 10n ** 14n;
    const book = new FactBook();
    const snap = await readSnapshot(fakeChain(w), ME, book);
    const a = await answerQuestion("what changed since block 913600?", reads([snap], book, w));
    expect(a.text).toMatch(/Morpho Blue syzUSD\/USDC: 1,500\.0000 → 2,000\.0000 syzUSD;.*from amounts changing \(including interest accrued on the debt\).*from the collateral price moving/);
    const id = await answerQuestion("apa yang berubah sejak blok 913600?", reads([snap], book, w));
    expect(id.text).toContain("termasuk bunga yang bertambah pada utang");
  });

  it("a vault row's USD figures are the same ones 'hold' shows, and moves + market add up to the change exactly", async () => {
    const w = base();
    w.rox = (b) => (b >= HEAD ? 5_000n * 10n ** 18n + 123_456_789_012_345n : 4_000n * 10n ** 18n);
    const book = new FactBook();
    const now = await readSnapshot(fakeChain(w), ME, book);
    const before = await readSnapshot(fakeChain(w), ME, book, EARLIER);
    const d = diffSnapshots(before, now);
    const row = d.rows.find((r) => r.key === "vault:roxUSDC")!;
    const vNow = now.positions.find((p) => p.kind === "vault")!;
    if (vNow.kind !== "vault") throw new Error();
    expect(row.usdAfter).toBe(vNow.usd); // not shares × price recomputed in floating point
    expect(row.moves! + row.market!).toBeCloseTo(row.usdAfter! - row.usdBefore!, 9);
  });

  it("a Morpho row where only the debt moved says so (interest accrued, or a borrow/repay)", async () => {
    const w = base();
    w.collateral = () => 2_000n * 10n ** 18n;
    w.borrowShares = (b) => (b >= HEAD ? 6n * 10n ** 14n : 5n * 10n ** 14n);
    const book = new FactBook();
    const snap = await readSnapshot(fakeChain(w), ME, book);
    const a = await answerQuestion("what changed since block 913600?", reads([snap], book, w));
    expect(a.text).toMatch(/Morpho Blue syzUSD\/USDC: 2,000\.0000 → 2,000\.0000 syzUSD;.*from the debt changing \(interest accrued, or a borrow\/repay\)/);
  });

  it("nothing changed → says so", async () => {
    const w = { ...base(), roxPrice: () => 1_000_000n };
    const book = new FactBook();
    const snap = await readSnapshot(fakeChain(w), ME, book);
    const a = await answerQuestion("what changed since block 913600?", reads([snap], book, w));
    expect(a.text).toContain("Nothing changed");
  });

  it("Bahasa Indonesia questions get Bahasa Indonesia answers with the same cited numbers", async () => {
    const { a } = await ask("berapa saldo USDC saya?");
    expect(a.lang).toBe("id");
    expect(a.text).toMatch(/^Dompet 0x1111/);
    expect(a.text).toContain("1,000.0000 USDC di dompet");
    const e = await ask("apa yang menghasilkan bunga?");
    expect(e.a.text).toContain("tumbuh");
    expect(e.a.text).toContain("disetahunkan");
    expect(e.a.text).toContain("setahun");
    expect(uncited(e.a)).toEqual([]);
    const c = await ask("apa yang berubah sejak kemarin?");
    expect(c.a.lang).toBe("id");
  });

  it("Bahasa answers carry no English fragments for debt, where and total", async () => {
    const w = base();
    w.collateral = () => 1_200n * 10n ** 18n;
    w.borrowShares = () => 10n ** 15n;
    const d = await ask("apakah saya punya utang?", w);
    expect(d.a.text).toMatch(/utang 1,000\.00 USDC, jaminan 1,200\.0000 syzUSD.*faktor kesehatan 1\.0980 \(jaminan 1,200\.00 USDC.*boleh turun 8\.9% sebelum likuidasi\)/);
    expect(d.a.text).not.toMatch(/may fall|before liquidation|collateral/);
    const wh = await ask("di mana USDC saya?", w);
    expect(wh.a.text).toContain("USDC dipinjam, tidak dipegang");
    expect(wh.a.text).not.toMatch(/in wallet|borrowed/);
    const tot = await ask("berapa total nilai portofolio saya?", w);
    expect(tot.a.text).toContain("USDC di dompet: $1,000.00");
    expect(tot.a.text).toContain("jaminan + suplai − utang");
    expect(tot.a.text).not.toMatch(/in wallet|collateral/);
  });

  it("a change too small to see is shown as +$0.00, never −$0.00", async () => {
    const w = base();
    w.native = (b) => (b >= HEAD ? 2n * 10n ** 18n - 1n : 2n * 10n ** 18n);
    const book = new FactBook();
    const snap = await readSnapshot(fakeChain(w), ME, book);
    const a = await answerQuestion("what changed since block 913600?", reads([snap], book, w));
    expect(a.text).toMatch(/PROS in wallet: 2\.0000 → 2\.0000 PROS/);
    expect(a.text).not.toContain("−$0.00");
  });

  it("says plainly when it cannot read a source, and does not guess its figure", async () => {
    const w = base();
    w.broken.add(`${JT.share}.balanceOf`);
    const { a } = await ask("what do I hold?", w);
    expect(a.text).toMatch(/I could not read Fund vault: JTRSY share balance for 0x1111…1111 at block 1000000: execution reverted/);
    expect(a.text).toContain("I will not guess it.");
  });

  it("declines what it does not read (protocol, advice, unknown token) and cites nothing", async () => {
    for (const [q, re] of [
      ["what is my Harbor position?", /I don't read Harbor/],
      ["will PROS go up next week?", /don't predict prices or give advice/],
      ["how much DOGE do I have?", /I don't read the token "DOGE"/],
      ["sing me a song", /I didn't understand that/],
    ] as const) {
      const { a } = await ask(q);
      expect(a.text).toMatch(re);
      expect(a.refused).toBeTruthy();
      expect(a.cites).toEqual([]);
    }
    const { a } = await ask("what is my Harbor position?");
    expect(a.text).toContain("RockawayX and JTRSY/HYB fund vaults, and Morpho Blue markets");
    const id = await ask("apa posisi Harbor saya?");
    expect(id.a.text).toMatch(/Saya tidak bisa menjawab itu: saya tidak membaca Harbor/);
  });

  it("several wallets: each line says whose position it is", async () => {
    const book = new FactBook();
    const s1 = await readSnapshot(fakeChain(base()), ME, book);
    const OTHER = getAddress("0x2222222222222222222222222222222222222222");
    const s2 = await readSnapshot(fakeChain({ ...base(), usdc: () => 5n * 10n ** 6n }), OTHER, book);
    const a = await answerQuestion("where is my USDC?", reads([s1, s2], book));
    expect(a.text).toContain("0x1111…1111 · 1,000.0000 USDC in wallet");
    expect(a.text).toContain("0x2222…2222 · 5.0000 USDC in wallet");
  });

  it("source table: one row per cited id with contract, call and block", async () => {
    const { a, book } = await ask("where is my USDC?");
    const t = sourceTable(book, a.cites);
    expect(t.split("\n")[0]).toBe("id | figure | contract | call | block");
    expect(t).toContain(`${USDC.address} | balanceOf(wallet) | block ${HEAD}`);
    expect(t).toContain(`${ROX.vault} | convertToAssets(shares) | block ${HEAD}`);
  });

  it("five different question types are answered with figures (requirement 2) — all cited", async () => {
    const qs = ["How much USDC do I have?", "where is my USDC?", "what's my biggest position?", "what am I earning?", "what is my total portfolio value?", "what changed since block 913600?", "do I owe anything?", "what do I hold?"];
    const types = new Set<string>();
    for (const q of qs) {
      const { a } = await ask(q);
      types.add(a.intent.type);
      expect(a.refused).toBeUndefined();
      expect(a.cites.length).toBeGreaterThanOrEqual(0);
      expect(uncited(a), q).toEqual([]);
    }
    expect(types.size).toBe(qs.length);
  });
});

// ---------------------------------------------------------------- the CLI and the read-only promise

describe("CLI input checks (no network is touched)", () => {
  const ctx = { onExit() {}, signal: new AbortController().signal };
  const bad = (argv: string[], re: RegExp) => expect(main(ctx, argv)).rejects.toThrow(re);
  it("rejects a missing command, wallet, question or bad option", async () => {
    await bad(["ask", "what do I hold?"], /--wallet is required/);
    await bad(["ask", "q", "--wallet", "nope"], /--wallet must be an address/);
    await bad(["ask", "--wallet", "0x1111111111111111111111111111111111111111"], /expected 1 to 40|at least one question/);
    await bad(["report", "extra", "--wallet", "0x1111111111111111111111111111111111111111"], /report takes no question/);
    await bad(["ask", "q", "--wallet", "0x1111111111111111111111111111111111111111", "--window-days", "0"], /--window-days/);
    await bad(["ask", "q", "--wallet", "0x1111111111111111111111111111111111111111", "--block", "abc"], /--block must be a block number/);
    await bad(["swap", "--wallet", "0x1111111111111111111111111111111111111111"], /command/);
    await expect(main(ctx, ["ask", "q"])).rejects.toBeInstanceOf(UsageError);
    expect(REPORT_QUESTION).toBe("what do I hold?");
  });
});

describe("read-only by construction (requirement 5)", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "proof" || e.name === "state" ? [] : files(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  const src = [...files("src/portfolio"), ...files("tasks/portfolio-assistant")];
  it("imports no signer and names no send tool", () => {
    expect(src.length).toBeGreaterThanOrEqual(4);
    for (const f of src) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/signer|send_raw_transaction|sendTransaction|PRIVATE_KEY|broadcast|privateKeyToAccount/);
    }
  });
  it("opens the Chain MCP on mainnet only and without broadcast", () => {
    const text = readFileSync("tasks/portfolio-assistant/index.ts", "utf8");
    expect(text).toMatch(/chainMcp\("pharos"\)/);
    expect(text).not.toMatch(/atlantic|broadcast/);
  });
});
