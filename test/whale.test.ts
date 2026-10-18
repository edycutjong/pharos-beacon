import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, pad, type Hex, type RpcLog } from "viem";
import { describe, expect, it } from "vitest";
import { main, parseBlock } from "../tasks/whale-watching-agent/index.js";
import { explain, isSignificant, kindResolver, loadTokens, makeNamer, parseWatchlist, reportText, scanMoves, summarise, summaryTable, ZERO } from "../src/whale/scan.js";

const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815" as Hex;
const WATCH = ["0x0000000000000000000000000000000000000a01", "0x0000000000000000000000000000000000000a02", "0x0000000000000000000000000000000000000a03", "0x0000000000000000000000000000000000000a04", "0x0000000000000000000000000000000000000a05"].map((a) => getAddress(a));
const OUTSIDER = getAddress("0x00000000000000000000000000000000000000b1");
const POOL = getAddress("0x00000000000000000000000000000000000000c1");
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}` as Hex;
const U = 10n ** 6n;
const wl = (over: Record<string, unknown> = {}) => ({ network: "pharos", source: "test", addresses: WATCH.map((address, i) => ({ address, label: `w${i + 1}` })), tokens: [{ address: USDC, threshold: "1000" }], labels: {}, ...over });

function log(block: number, index: number, tx: number, value: bigint, from: Hex, to: Hex, topics3 = true): RpcLog {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as Hex[];
  return { address: USDC, blockNumber: hex(block), logIndex: hex(index), transactionHash: pad(hex(tx), { size: 32 }), topics: topics3 ? topics : [...topics, pad("0x1", { size: 32 })], data: encodeAbiParameters([{ type: "uint256" }], [value]) } as RpcLog;
}

/** A fake Chain MCP: balances are looked up per (holder, block) so the before/after context is controllable. */
function chain(logs: RpcLog[], balance: (holder: string, block: number) => bigint = () => 5000n * U, contracts: string[] = [POOL]) {
  const calls: { tool: string; args: any }[] = [];
  const call = (async (tool: string, args: any = {}) => {
    calls.push({ tool, args });
    if (tool === "get_block_number") return { blockNumber: "2000" };
    if (tool === "get_block") return { number: hex(Number(args.block)), timestamp: hex(1_760_000_000 + Number(args.block)) };
    if (tool === "get_code") return { code: contracts.map((c) => c.toLowerCase()).includes(String(args.address).toLowerCase()) ? "0x6080" : "0x" };
    if (tool === "get_logs") {
      const [t0, t1, t2] = args.topics ?? [];
      const ok = (t: Hex | undefined, want: any) => want == null || [].concat(want).map((x: string) => x.toLowerCase()).includes(String(t).toLowerCase());
      return logs.filter((l) => Number(BigInt(l.blockNumber!)) >= Number(args.fromBlock) && Number(BigInt(l.blockNumber!)) <= Number(args.toBlock) && ok(l.topics[0], t0) && ok(l.topics[1], t1) && ok(l.topics[2], t2));
    }
    if (tool === "eth_call") {
      const data: string = args.transaction.data;
      if (data.startsWith("0x313ce567")) return { result: pad(hex(6), { size: 32 }) };
      if (data.startsWith("0x95d89b41")) return { result: encodeAbiParameters([{ type: "string" }], ["USDC"]) };
      if (data.startsWith("0x70a08231")) return { result: pad(hex(balance(`0x${data.slice(34)}`, Number(args.block))), { size: 32 }) };
    }
    throw new Error(`unexpected call ${tool}`);
  }) as any;
  return Object.assign(call, { calls });
}
const tokenOf = async (call: any) => (await loadTokens(call, [{ address: USDC, threshold: "1000" }]))[0]!;

describe("watchlist", () => {
  it("accepts a good list and lower-cases label keys", () => {
    const w = parseWatchlist(wl({ labels: { [POOL]: "Test pool" } }));
    expect(w.addresses).toHaveLength(5);
    expect(w.labels[POOL.toLowerCase()]).toBe("Test pool");
  });
  it("needs 5+ addresses, no repeats, a label each, a positive threshold", () => {
    expect(() => parseWatchlist(wl({ addresses: wl().addresses.slice(0, 4) }))).toThrow(/at least 5/);
    expect(() => parseWatchlist(wl({ addresses: [...wl().addresses.slice(0, 4), wl().addresses[0]] }))).toThrow(/repeats/);
    expect(() => parseWatchlist(wl({ addresses: [...wl().addresses.slice(0, 4), { address: OUTSIDER }] }))).toThrow(/needs a label/);
    expect(() => parseWatchlist(wl({ tokens: [{ address: USDC, threshold: "0" }] }))).toThrow(/positive/);
    expect(() => parseWatchlist(wl({ tokens: [{ address: "nope", threshold: "5" }] }))).toThrow(/0x address/);
  });
});

describe("parseBlock", () => {
  it("reads N, head and head-N", () => {
    expect(parseBlock("--x", "12", 100n)).toBe(12n);
    expect(parseBlock("--x", "head", 100n)).toBe(100n);
    expect(parseBlock("--x", "head-30", 100n)).toBe(70n);
    expect(() => parseBlock("--x", "head-200", 100n)).toThrow(/below block 0/);
    expect(() => parseBlock("--x", "soon", 100n)).toThrow(/must be a block number/);
  });
});

describe("scanMoves and thresholds", () => {
  it("finds moves in and out, counts a watched→watched move once, skips 4-topic (NFT) logs and keeps chain order", async () => {
    const logs = [
      log(30, 0, 3, 5000n * U, OUTSIDER, WATCH[0]!),
      log(10, 1, 1, 100n * U, WATCH[1]!, OUTSIDER),
      log(20, 0, 2, 2500n * U, WATCH[0]!, WATCH[1]!),
      log(25, 0, 4, 9n, OUTSIDER, WATCH[2]!, false),
      log(26, 0, 5, 7n * U, OUTSIDER, POOL), // touches nobody we watch
    ];
    const call = chain(logs);
    const moves = await scanMoves(call, await tokenOf(call), WATCH, 0n, 100n);
    expect(moves.map((m) => m.block)).toEqual([10n, 20n, 30n]);
    expect(moves.filter(isSignificant).map((m) => m.amountRaw)).toEqual([2500n * U, 5000n * U]);
  });
  it("pins the range: nothing outside it is read", async () => {
    const call = chain([log(500, 0, 1, 9999n * U, OUTSIDER, WATCH[0]!)]);
    expect(await scanMoves(call, await tokenOf(call), WATCH, 0n, 100n)).toEqual([]);
    expect(call.calls.filter((c: { tool: string; args: any }) => c.tool === "get_logs").every((c: { args: any }) => Number(c.args.toBlock) <= 100)).toBe(true);
  });
  it("applies the token's decimals to the threshold", async () => {
    const call = chain([]);
    expect((await tokenOf(call)).thresholdRaw).toBe(1000n * U);
  });
});

describe("explain", () => {
  const setup = async (balance: (h: string, b: number) => bigint, logs: RpcLog[]) => {
    const call = chain(logs, balance);
    const token = await tokenOf(call);
    const w = parseWatchlist(wl({ labels: { [POOL]: "Test pool" } }));
    const kindOf = kindResolver(call);
    const namer = makeNamer(w, "pharos", [token], kindOf);
    const [m] = await scanMoves(call, token, WATCH, 0n, 100n);
    return { call, m: m!, w, namer, kindOf };
  };
  it("labels watched and known counterparts; the rest print as unlabelled wallet or contract", async () => {
    const { call, m, w, namer, kindOf } = await setup(() => 9000n * U, [log(10, 0, 1, 3000n * U, WATCH[0]!, OUTSIDER)]);
    const r = await explain(call, m, w, namer, kindOf, { largest: m.amountRaw });
    expect(r.fromName).toBe("w1");
    expect(r.toName).toBe("unlabelled wallet");
    expect(r.toKnown).toBe(false);
    const pool = await setup(() => 9000n * U, [log(10, 0, 1, 3000n * U, WATCH[0]!, POOL)]);
    expect((await explain(pool.call, pool.m, pool.w, pool.namer, pool.kindOf, { largest: 0n })).toName).toBe("Test pool");
    const anon = await setup(() => 9000n * U, [log(10, 0, 1, 3000n * U, WATCH[0]!, getAddress("0x00000000000000000000000000000000000000c2"))]);
    expect((await explain(anon.call, anon.m, anon.w, anon.namer, anon.kindOf, { largest: 0n })).toName).toBe("unlabelled wallet");
  });
  it("calls out an exit, a new position and a pass-through from the balances around the block", async () => {
    const exit = await setup((_h, b) => (b < 10 ? 3000n * U : 0n), [log(10, 0, 1, 3000n * U, WATCH[0]!, OUTSIDER)]);
    expect((await explain(exit.call, exit.m, exit.w, exit.namer, exit.kindOf, { largest: 0n })).why.join(";")).toContain("EXIT");
    const fresh = await setup((_h, b) => (b < 10 ? 0n : 3000n * U), [log(10, 0, 1, 3000n * U, OUTSIDER, WATCH[0]!)]);
    expect((await explain(fresh.call, fresh.m, fresh.w, fresh.namer, fresh.kindOf, { largest: 0n })).why.join(";")).toContain("NEW POSITION");
    const pass = await setup(() => 0n, [log(10, 0, 1, 3000n * U, OUTSIDER, WATCH[0]!)]);
    expect((await explain(pass.call, pass.m, pass.w, pass.namer, pass.kindOf, { largest: 0n })).why.join(";")).toContain("pass-through");
  });
  it("prints the amount with decimals, the multiple of the threshold and the explorer link", async () => {
    const { call, m, w, namer, kindOf } = await setup((_h, b) => (b < 10 ? 9000n * U : 6000n * U), [log(10, 0, 1, 3000n * U, WATCH[0]!, OUTSIDER)]);
    const r = await explain(call, m, w, namer, kindOf, { largest: m.amountRaw });
    const text = reportText(r, (tx) => `https://x/${tx}`, 1);
    expect(text).toContain("OUT 3,000 USDC · block 10");
    expect(text).toContain("3× the 1,000 USDC threshold");
    expect(text).toContain("33.3% of its USDC balance");
    expect(text).toContain("the largest USDC move touching the watchlist in this range");
    expect(text).toContain("9,000 USDC → 6,000 USDC");
    expect(text).toContain("https://x/0x");
  });
  it("a mint is described as a mint", async () => {
    const { call, m, w, namer, kindOf } = await setup(() => 0n, [log(10, 0, 1, 3000n * U, ZERO, WATCH[0]!)]);
    const r = await explain(call, m, w, namer, kindOf, { largest: 0n });
    expect(r.fromName).toBe("null address (mint or burn)");
    expect(r.why.join(";")).toContain("a mint into the watched address");
  });
});

describe("summary", () => {
  it("has one row per watched address and token, with in/out of the significant moves only", async () => {
    const call = chain([log(10, 0, 1, 5000n * U, OUTSIDER, WATCH[0]!), log(11, 0, 2, 10n * U, OUTSIDER, WATCH[0]!), log(12, 0, 3, 2000n * U, WATCH[1]!, OUTSIDER)]);
    const token = await tokenOf(call);
    const rows = summarise(parseWatchlist(wl()), [token], await scanMoves(call, token, WATCH, 0n, 100n));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ transfers: 2, significant: 1, inRaw: 5000n * U, outRaw: 0n });
    expect(rows[1]).toMatchObject({ transfers: 1, significant: 1, outRaw: 2000n * U });
    expect(rows[4]).toMatchObject({ transfers: 0, significant: 0 });
    expect(summaryTable(rows)).toMatch(/w1 0x0000…0a01\s+USDC\s+2\s+1\s+5,000/);
  });
});

describe("CLI", () => {
  const ctx = () => ({ onExit: () => {}, signal: new AbortController().signal });
  const run = async (args: string[], c: any, notifier?: any) => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => void lines.push(String(s));
    try {
      const code = await main(ctx(), args, async () => ({ call: c, close: async () => {}, endpoint: "fake", network: "pharos", chainId: 1672, server: undefined }) as any, notifier);
      return { code, out: lines.join("\n") };
    } finally {
      console.log = orig;
    }
  };
  const dir = mkdtempSync(join(tmpdir(), "whale-"));
  const list = join(dir, "wl.json");
  writeFileSync(list, JSON.stringify(wl()));

  it("reports, summarises and writes nothing but the state file; a second run resumes after the pinned range", async () => {
    const c = chain([log(1500, 0, 1, 4000n * U, OUTSIDER, WATCH[0]!), log(1990, 0, 2, 50n * U, OUTSIDER, WATCH[0]!)]);
    const state = join(dir, "state.json");
    const a = await run(["--watchlist", list, "--from-block", "1000", "--to-block", "head", "--state", state], c);
    expect(a.code).toBe(0);
    expect(a.out).toContain("blocks 1000–2000");
    expect(a.out).toContain("2 transfers touch a watched address · 1 at or above");
    expect(a.out).toContain("IN 4,000 USDC");
    expect(a.out).toContain("summary across all watched addresses");
    expect(JSON.parse(readFileSync(state, "utf8"))).toEqual({ next: "2001" });
    const b = await run(["--watchlist", list, "--state", state], c);
    expect(b.out).toContain("nothing to scan");
  });
  it("--compact prints three short lines per report and only the rows that moved", async () => {
    const c = chain([log(1500, 0, 1, 4000n * U, OUTSIDER, WATCH[0]!), log(1600, 0, 2, 9000n * U, WATCH[1]!, POOL)]);
    const a = await run(["--watchlist", list, "--from-block", "1000", "--compact"], c);
    expect(a.out).toContain("[1] IN 4,000 USDC · blk 1500");
    expect(a.out).toContain("  unlabelled wallet → w1\n  4× threshold");
    expect(a.out).toContain("w2 USDC: 1 sig, in 0, out 9,000");
    expect(a.out).toContain("3 quiet rows (no significant move) hidden");
    expect(a.out).not.toContain("watching 0x");
    expect(a.out.split("\n").filter((l) => l.length > 55 && !l.startsWith("blocks") && !l.startsWith("whale watch"))).toEqual([]);
  });
  it("sends significant moves to the notifier once, largest first, capped, and not again on a rerun", async () => {
    const c = chain([log(1500, 0, 1, 4000n * U, OUTSIDER, WATCH[0]!), log(1600, 0, 2, 9000n * U, OUTSIDER, WATCH[1]!), log(1700, 0, 3, 2000n * U, OUTSIDER, WATCH[2]!)]);
    const sent: string[] = [];
    const notifier = { name: "discord", send: async (t: string) => (sent.push(t), { id: String(sent.length), timestamp: "t", content: t }) };
    const sentFile = join(dir, "sent.json");
    const args = ["--watchlist", list, "--from-block", "1000", "--notify", "discord", "--discord-max", "2", "--sent", sentFile];
    const a = await run(args, c, () => notifier);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("9,000 USDC");
    expect(a.out).toContain("notify discord: 2 sent");
    const b = await run(args, c, () => notifier);
    expect(sent).toHaveLength(2);
    expect(b.out).toContain("0 sent");
    expect(b.out).toContain("2 already sent earlier");
  });
  it("rejects a bad flag and a bad watchlist with a usage error", async () => {
    const c = chain([]);
    await expect(run(["--watchlist", list, "--from-block", "never"], c)).rejects.toThrow(/must be a block number/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify(wl({ addresses: [] })));
    await expect(run(["--watchlist", bad], c)).rejects.toThrow(/at least 5/);
    await expect(run(["--watchlist", list, "--notify", "sms"], c)).rejects.toThrow();
  });
});
