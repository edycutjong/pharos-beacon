import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORACLE_PRICE_SCALE } from "../src/liq/morpho.js";
import { InputError } from "../src/web/live.js";
import type { Deps } from "../src/web/mainnet-live.js";
import { parseRun, run, viewOf, handle } from "../tasks/liquidation-watchdog/web.js";
import { SEED } from "../tasks/liquidation-watchdog/seed.js";

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

/** A fake Chain MCP for Morpho Blue: one market (loan USDC/6, collateral syzUSD/18); `collateral` sets every position's collateral. */
function fakeChain(opts: { collateral: bigint; noBlock?: boolean }) {
  const calls: string[] = [];
  const call = (async (tool: string, args: any) => {
    calls.push(tool);
    if (tool === "get_block_number") return { blockNumber: "1000" };
    if (tool === "get_block") return opts.noBlock ? null : { timestamp: "90000" };
    const { functionName } = decodeFunctionData({ abi, data: args.transaction.data });
    const enc = (v: unknown) => ({ result: encodeFunctionResult({ abi, functionName, result: v as never } as never) });
    switch (functionName) {
      case "idToMarketParams": return enc([A(1), A(2), A(3), A(4), 915_000_000_000_000_000n]);
      case "market": return enc([2_000_000n, 2_000_000_000_000n, 1_000_000n, 1_000_000_000_000n, 1_000n, 0n]);
      case "position": return enc([0n, 1_000_000_000_000n, opts.collateral]);
      case "price": return enc([ORACLE_PRICE_SCALE]);
      case "symbol": return enc([args.transaction.to === A(1) ? "USDC" : "syzUSD"]);
      case "decimals": return enc([args.transaction.to === A(1) ? 6 : 18]);
      case "borrowRateView": return enc([0n]);
    }
    throw new Error(`unexpected ${functionName}`);
  }) as never;
  const closed = { n: 0 };
  const deps: Deps = { connect: async () => ({ call, endpoint: "fake", close: async () => void closed.n++ }) };
  return { deps, calls, closed };
}

const lines = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
const q = (s: string) => new URL(`http://x/api?${s}`);

describe("liquidation web: parameters", () => {
  it("defaults to the 1.3 / 1.1 thresholds and no shock", () => {
    expect(parseRun(q("action=run"))).toEqual({ shock: 0, warn: 1.3, critical: 1.1 });
  });
  it("refuses critical at or above warn", () => {
    expect(() => parseRun(q("warn=1.2&critical=1.2"))).toThrow(InputError);
    expect(() => parseRun(q("warn=1.2&critical=1.2"))).toThrow("critical must be below warn");
  });
});

describe("liquidation web: run", () => {
  it("reads every seeded position, ranks them and ends with a view", async () => {
    const { deps, closed, calls } = fakeChain({ collateral: 1_000_000_000_000_000_000n });
    const out: any[] = [];
    await run({ shock: 0, warn: 1.3, critical: 1.1 }, (e) => out.push(e), deps);
    expect(out[0]).toEqual({ type: "start", network: "pharos", endpoint: "fake" });
    const steps = out.filter((e) => e.type === "step" && e.state !== "running").map((e) => e.id);
    expect(steps).toEqual(["head", "markets", "positions", "rank"]);
    const done = out.at(-1);
    expect(done.type).toBe("done");
    expect(done.view.tables[0].rows).toHaveLength(SEED.length);
    expect(done.view.tone).toBe("ok");
    expect(done.view.summary).toMatch(/^0 alerts of 13 positions/);
    expect(done.view.evidence[0][1]).toMatch(new RegExp(`${SEED.length} positions in ${new Set(SEED.map(([m]) => m)).size} markets`));
    expect(closed.n).toBe(1);
    expect(calls.filter((c) => c === "get_block_number")).toHaveLength(1);
  });

  it("flags positions at the edge: bad tone, an alert text and the shock in the verdict", async () => {
    const { deps } = fakeChain({ collateral: 1_000_000n }); // far below the debt: health well under 1
    const out: any[] = [];
    await run({ shock: 0.1, warn: 1.3, critical: 1.1 }, (e) => out.push(e), deps);
    const v = out.at(-1).view;
    expect(v.tone).toBe("bad");
    expect(v.verdict).toMatch(/^13 of 13 positions at or below 1.30 after a .* collateral drop/);
    expect(v.text).toEqual(expect.any(String));
    expect(v.summary).toMatch(/^13 alerts of 13/);
    expect(v.evidence[1][1]).toMatch(/scenario: collateral −/);
  });

  it("fails the current step, rethrows and still closes when the chain returns no block", async () => {
    const { deps, closed } = fakeChain({ collateral: 1n, noBlock: true });
    const out: any[] = [];
    await expect(run({ shock: 0, warn: 1.3, critical: 1.1 }, (e) => out.push(e), deps)).rejects.toThrow("returned no block 1000");
    expect(out.find((e) => e.type === "step" && e.state === "failed")).toMatchObject({ id: "head" });
    expect(closed.n).toBe(1);
  });

  it("serves info and the NDJSON run through handle()", async () => {
    const info = await handle(new Request("http://x/api?action=info"));
    expect((await info.json()).task).toBe("liquidation-watchdog");
    const { deps } = fakeChain({ collateral: 1_000_000_000_000_000_000n });
    const res = await handle(new Request("http://x/api?action=run"), deps);
    const out = await lines(res);
    expect(out.at(-1).type).toBe("done");
    const bad = await handle(new Request("http://x/api?action=run&warn=9"), deps);
    expect(bad.status).toBe(400);
  });
});

describe("liquidation web: viewOf", () => {
  it("says none / n/a on an empty list", () => {
    const v = viewOf([], 5n, { shock: 0, warn: 1.3, critical: 1.1 });
    expect(v.summary).toBe("0 alerts of 0 positions; closest n/a.");
    expect(v.evidence.at(-1)).toEqual(["Closest to the edge", "none"]);
  });
});
