import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { QuoteResult, Side, Venue } from "../src/arb/venues.js";
import { InputError } from "../src/web/live.js";
import type { Deps } from "../src/web/mainnet-live.js";

const h = vi.hoisted(() => ({ mids: [0.65, 0.665] as [number, number], reads: 0, fail: false }));
const POOL = "0x4c614696467128e14ba15e82dce543335184a271" as Hex;

/** A venue with a constant mid price and a 30 bps fee (no impact), as in the scanner's own tests. */
const venue = (id: string, mid: number): Venue => ({
  id, kind: "arb-pool", address: POOL, mid, feeBps: 30, raw: {},
  async quote(side: Side, amountIn: bigint): Promise<QuoteResult> {
    const inUnits = Number(amountIn) / (side === "base-in" ? 1e18 : 1e6);
    const gross = side === "base-in" ? inUnits * mid * 1e6 : (inUnits / mid) * 1e18;
    return { out: BigInt(Math.floor(gross * (1 - 30 / 1e4))), feeBps: 30 };
  },
});
vi.mock("../src/arb/venues.js", async (orig) => ({
  ...(await orig<typeof import("../src/arb/venues.js")>()),
  readUniV3: vi.fn(async () => (h.reads++, h.fail ? Promise.reject(new Error("pool read failed")) : venue("uni-style", h.mids[0]))),
  readDodo: vi.fn(async () => venue("faroswap", h.mids[1])),
}));

import { handle, parseRun, run } from "../tasks/arbitrage-scanner/web.js";

const q = (s: string) => new URL(`http://x/api?${s}`);
const fakeConn = () => {
  const tools: string[] = [];
  const closed = { n: 0 };
  const deps: Deps = {
    connect: async () => ({
      endpoint: "fake-mcp",
      close: async () => void closed.n++,
      call: (async (tool: string) => {
        tools.push(tool);
        if (tool === "get_gas_price") return { gasPriceWei: "10000000000" };
        if (tool === "get_block_number") return { blockNumber: "21134223" };
        throw new Error(`unexpected ${tool}`);
      }) as never,
    }),
  };
  return { deps, tools, closed };
};
const P = { minProfit: "0.001", slippageBps: 10, gasUnits: 350_000, sizes: "0.25,1" };

describe("arbitrage web: parameters", () => {
  it("defaults to five sizes, 0.001 USDC minimum profit, 10 bps and 350k gas", () => {
    expect(parseRun(q("action=run"))).toEqual({ minProfit: "0.001", sizes: "0.01,0.05,0.1,0.25,0.5", slippageBps: 10, gasUnits: 350_000 });
  });
  it("refuses more than six sizes, bad amounts and out-of-range numbers", () => {
    expect(() => parseRun(q("sizes=1,2,3,4,5,6,7"))).toThrow("sizes: at most 6 amounts");
    expect(() => parseRun(q("sizes=abc"))).toThrow(InputError);
    expect(() => parseRun(q("minProfit=0"))).toThrow(InputError);
    expect(() => parseRun(q("slippageBps=900"))).toThrow(/slippageBps must be a number between 0 and 500/);
    expect(() => parseRun(q("gasUnits=1"))).toThrow(/gasUnits/);
  });
});

describe("arbitrage web: run", () => {
  it("scans both pools at the head block and shows an unsigned plan when the spread pays", async () => {
    h.mids = [0.65, 0.68];
    const { deps, tools, closed } = fakeConn();
    const out: any[] = [];
    await run(P, (e) => out.push(e), deps);
    expect(out[0]).toEqual({ type: "start", network: "pharos", endpoint: "fake-mcp" });
    expect(tools).toEqual(["get_gas_price", "get_block_number"]);
    const done = out.at(-1);
    expect(done.type).toBe("done");
    expect(done.reads).toBe(2);
    const v = done.view;
    expect(v.tone).toBe("ok");
    expect(v.verdict).toMatch(/^ACT: best round trip nets [\d.]+ USDC after costs$/);
    expect(v.text).toContain("PLAN (mainnet is read-only: prepared, never signed)");
    expect(v.tables[0].rows.length).toBeGreaterThan(0);
    expect(v.tables[0].rows[0][0]).toMatch(/^(A→B|B→A)$/);
    expect(v.evidence.map((e: string[]) => e[0])).toEqual(["Sources", "Block", "Threshold", "Chain MCP reads", "Signed"]);
    expect(v.evidence[1][1]).toBe("21134223 (the head, read first)");
    expect(v.evidence[2][1]).toBe("net ≥ 0.001 USDC · slippage 10 bps · gas 350,000 units");
    expect(closed.n).toBe(1);
    const lamps = out.filter((e) => e.type === "step" && e.state !== "running").map((e) => e.id);
    expect(lamps).toEqual(["head", "decision"]); // the pool reads are mocked, so no "pools" call opens that lamp
  });

  it("skips when both pools quote alike, and says so", async () => {
    h.mids = [0.65, 0.65];
    const { deps } = fakeConn();
    const out: any[] = [];
    await run(P, (e) => out.push(e), deps);
    const v = out.at(-1).view;
    expect(v.tone).toBe("warn");
    expect(v.verdict.startsWith("SKIP")).toBe(true);
    expect(v.summary.startsWith("SKIP: ")).toBe(true);
    expect(out.find((e) => e.id === "decision" && e.state !== "running")).toMatchObject({ state: "skip" });
  });

  it("a failed pool read fails the open step, rethrows and still closes the connection", async () => {
    h.fail = true;
    const { deps, closed } = fakeConn();
    const out: any[] = [];
    try {
      await expect(run(P, (e) => out.push(e), deps)).rejects.toThrow("pool read failed");
      expect(out.some((e) => e.type === "step" && e.state === "failed" && /pool read failed/.test(e.label ?? ""))).toBe(true);
      expect(closed.n).toBe(1);
    } finally {
      h.fail = false;
    }
  });

  it("serves info, the NDJSON run and a 400 for a bad query through handle()", async () => {
    h.mids = [0.65, 0.68];
    expect((await (await handle(new Request("http://x/api?action=info"))).json()).task).toBe("arbitrage-scanner");
    const { deps } = fakeConn();
    const text = await (await handle(new Request("http://x/api?action=run&sizes=1"), deps)).text();
    expect(JSON.parse(text.trim().split("\n").at(-1)!).type).toBe("done");
    expect((await handle(new Request("http://x/api?action=run&sizes=zero"), deps)).status).toBe(400);
  });
});
