import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORACLE_PRICE_SCALE } from "../src/liq/morpho.js";
import { main } from "../tasks/liquidation-watchdog/index.js";

const h = vi.hoisted(() => ({ chain: undefined as undefined | { call: (tool: string, args: any) => Promise<unknown> }, closed: 0, sent: [] as string[] }));
vi.mock("../src/lib/mcp.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/mcp.js")>()),
  chainMcp: vi.fn(async () => ({ call: (t: string, a: any) => h.chain!.call(t, a), close: async () => void h.closed++, endpoint: "fake", network: "pharos", chainId: 1672 })),
}));
vi.mock("../src/lib/net.js", async (orig) => ({ ...(await orig<typeof import("../src/lib/net.js")>()), wait: vi.fn(async () => undefined) }));
vi.mock("../src/watch/discord.js", async (orig) => ({
  ...(await orig<typeof import("../src/watch/discord.js")>()),
  loadWebhook: () => new URL("https://discord.com/api/webhooks/1/x"),
  discordNotifier: () => ({ send: async (body: string) => (h.sent.push(body), { id: "m1", timestamp: "2026-10-25T00:00:00Z" }) }),
}));

const abi = parseAbi([
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)",
  "function price() view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)",
]);
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const ID = `0x${"ab".repeat(32)}` as Hex;
const USER = getAddress("0xA4A5000000000000000000000000000000003DCc");

function chain(collateral: () => bigint, borrowShares = 1_000_000_000_000n) {
  return {
    async call(tool: string, args: any) {
      if (tool === "get_block_number") return { blockNumber: "1000" };
      if (tool === "get_block") return { timestamp: String(100_000 + Number(args.block) * 2) };
      if (tool === "get_logs") return [];
      const { functionName } = decodeFunctionData({ abi, data: args.transaction.data });
      const enc = (v: unknown) => ({ result: encodeFunctionResult({ abi, functionName, result: v as never } as never) });
      switch (functionName) {
        case "idToMarketParams": return enc([A(1), A(2), A(3), A(4), 915_000_000_000_000_000n]);
        case "market": return enc([2_000_000n, 2_000_000_000_000n, 1_000_000n, 1_000_000_000_000n, 1_000n, 0n]);
        case "position": return enc([0n, borrowShares, collateral()]);
        case "price": return enc([ORACLE_PRICE_SCALE]);
        case "symbol": return enc([args.transaction.to === A(1) ? "USDC" : "syzUSD"]);
        case "decimals": return enc([args.transaction.to === A(1) ? 6 : 18]);
        case "borrowRateView": return enc([0n]);
      }
      throw new Error(`unexpected ${functionName}`);
    },
  };
}

let logs: string[] = [];
const dirs: string[] = [];
const tmp = () => (dirs.push(mkdtempSync(join(tmpdir(), "liq-cli-"))), dirs.at(-1)!);
const ctx = () => ({ onExit: (fn: () => unknown) => void fn(), signal: new AbortController().signal });
const out = () => logs.join("\n");
/** A borrower index that already covers every block, so a scan reads positions and no logs. */
const indexFile = (users: Hex[] = [USER]) => {
  const f = join(tmp(), "borrowers.json");
  writeFileSync(f, JSON.stringify({ morpho: "0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb", from: "0", to: "1000", markets: users.length ? { [ID]: users } : {} }));
  return f;
};

beforeEach(() => {
  logs = [];
  h.closed = 0;
  h.sent = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => void logs.push(String(s)));
});
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const HEALTHY = 5_000_000_000_000_000_000n; // plenty of collateral against a 1 USDC debt
const DANGER = 1_000_100n; // health just above liquidation

describe("liquidation-watchdog position", () => {
  it("reports a healthy position as ok", async () => {
    h.chain = chain(() => HEALTHY);
    expect(await main(ctx(), ["position", "--market", ID, "--user", USER])).toBe(0);
    expect(out()).toMatch(/Morpho .* LLTV 91\.50% · interest accrued/);
    expect(out()).toMatch(/ok: health .* is above the warn threshold 1\.30/);
  });

  it("alerts on a position under the threshold and applies a collateral shock to the verdict", async () => {
    h.chain = chain(() => DANGER);
    await main(ctx(), ["position", "--market", ID, "--user", USER, "--shock", "0.2"]);
    expect(out()).toMatch(/health at −20/);
    expect(out()).not.toMatch(/ok: health/);
    expect(out()).toMatch(/liquidat/i);
  });

  it("says a repaid account has nothing to liquidate", async () => {
    h.chain = chain(() => 1n, 0n);
    await main(ctx(), ["position", "--market", ID, "--user", USER]);
    expect(out()).toMatch(/has no debt in this market .* nothing to liquidate/);
  });

  it("delivers the alert to Discord when asked", async () => {
    h.chain = chain(() => DANGER);
    await main(ctx(), ["position", "--market", ID, "--user", USER, "--discord"]);
    expect(h.sent).toHaveLength(1);
    expect(out()).toContain("discord: delivered message m1 at 2026-10-25T00:00:00Z");
  });

  it("closes the MCP client on exit", async () => {
    h.chain = chain(() => HEALTHY);
    const exits: (() => unknown)[] = [];
    await main({ onExit: (fn) => void exits.push(fn), signal: new AbortController().signal }, ["position", "--market", ID, "--user", USER]);
    await Promise.all(exits.map((f) => f()));
    expect(h.closed).toBe(1);
  });
});

describe("liquidation-watchdog scan", () => {
  it("reads the indexed borrowers, ranks them and lists alerts", async () => {
    h.chain = chain(() => DANGER);
    const index = indexFile();
    expect(await main(ctx(), ["scan", "--index", index, "--top", "3"])).toBe(0);
    expect(out()).toMatch(/discovery: 0 new blocks scanned \(earlier ranges reused from the index\)/);
    expect(out()).toMatch(/block 1000: 1 open positions across 1 market/);
    expect(out()).toMatch(/LIQUIDATABLE Morpho syzUSD\/USDC .* health factor 0\.9151 .* Liquidatable now\. Act now: repay/);
  });

  it("sends no alert when everything is healthy, and treats dust as not alertable", async () => {
    h.chain = chain(() => HEALTHY);
    await main(ctx(), ["scan", "--index", indexFile()]);
    expect(out()).toMatch(/no position at or below the warn threshold 1\.30/);
    logs = [];
    h.chain = chain(() => DANGER);
    await main(ctx(), ["scan", "--index", indexFile(), "--min-debt", "100"]);
    expect(out()).toContain("(dust, no alert)");
    expect(out()).toMatch(/no position at or below the warn threshold/);
  });

  it("reports an empty index and filters to one market", async () => {
    h.chain = chain(() => DANGER);
    await main(ctx(), ["scan", "--index", indexFile([])]);
    expect(out()).toMatch(/borrowers ever seen per market: none/);
    expect(out()).toMatch(/closest: n\/a/);
    logs = [];
    await main(ctx(), ["scan", "--index", indexFile(), "--market", `0x${"cd".repeat(32)}`]);
    expect(out()).toMatch(/0 open positions/);
  });

  it("drops a repaid borrower from the table", async () => {
    h.chain = chain(() => 1n, 0n);
    await main(ctx(), ["scan", "--index", indexFile()]);
    expect(out()).toMatch(/0 open positions/);
  });

  it("stops at once when interrupted", async () => {
    h.chain = chain(() => DANGER);
    const ac = new AbortController();
    ac.abort();
    await expect(main({ onExit() {}, signal: ac.signal }, ["scan", "--index", indexFile()])).rejects.toThrow("interrupted");
  });
});

describe("liquidation-watchdog watch", () => {
  it("alerts when a position worsens, stays quiet when the level is unchanged, and clears it later", async () => {
    let collateral = HEALTHY;
    h.chain = chain(() => collateral);
    const index = indexFile();
    const levels = join(tmp(), "levels.json");
    // poll 1 healthy; poll 2 deteriorates (alert); the collateral is read per poll via the closure
    const c = h.chain;
    let polls = 0;
    h.chain = { call: async (t, a) => (t === "get_block_number" && ++polls === 2 && (collateral = DANGER), c.call(t, a)) };
    await main(ctx(), ["watch", "--index", index, "--levels", levels, "--max-polls", "3", "--interval-s", "1"]);
    expect(out()).toContain("--- poll 1 of 3 ---");
    expect(out()).toContain("--- poll 3 of 3 ---");
    expect(out()).toMatch(/block 1000: 1 open positions, closest .*, 0 new alert\(s\)/); // poll 1
    expect(out()).toMatch(/1 new alert\(s\)/); // poll 2 got worse
    const saved = JSON.parse(readFileSync(levels, "utf8"));
    expect(Object.values(saved.levels)).toEqual(["liquidatable"]);
    expect(out().match(/1 new alert\(s\)/g)).toHaveLength(1); // poll 3: same level, no repeat
  });

  it("remembers levels from the file and says so; reports a recovery as CLEARED", async () => {
    const index = indexFile();
    const levels = join(tmp(), "levels.json");
    h.chain = chain(() => HEALTHY);
    writeFileSync(levels, JSON.stringify({ levels: { [`${ID}:${USER}:shock=0`]: "liquidatable", gone: "warn" } }));
    await main(ctx(), ["watch", "--index", index, "--levels", levels, "--max-polls", "1"]);
    expect(out()).toMatch(/2 position level\(s\) remembered from /);
    expect(out()).toMatch(/CLEARED Morpho .*health factor/);
    const saved = JSON.parse(readFileSync(levels, "utf8"));
    expect(saved.levels).toEqual({ [`${ID}:${USER}:shock=0`]: "ok" }); // the repaid / vanished key was forgotten
    expect(existsSync(levels)).toBe(true);
  });
});
