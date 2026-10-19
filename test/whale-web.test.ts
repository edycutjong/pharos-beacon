import { encodeFunctionResult, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";
import { handle, parseRun, type Deps } from "../tasks/whale-watching-agent/web.js";
import { events, fakeRaw, req } from "./web-helpers.js";

const watchlist = {
  network: "pharos", source: "test list",
  addresses: [1, 2, 3, 4, 5].map((i) => ({ address: `0x${String(i).repeat(40)}`, label: `w-${i}` })),
  tokens: [{ address: "0xc879c018db60520f4355c26ed1a6d572cdac1815", threshold: "25000" }],
  labels: {},
};
const deps: Deps = {
  fetch: fakeRaw({ "watchlist.json": watchlist }),
  connect: async () => ({
    chainId: 1672, endpoint: "fake", close: async () => {},
    call: (async (name: string, args: { transaction?: { data?: string } }) => {
      if (name === "get_block_number") return { blockNumber: "5000" };
      if (name === "get_code") return { code: "0x" };
      if (name === "get_logs") return [];
      if (name === "eth_call") {
        const sel = args.transaction?.data?.slice(0, 10);
        return { result: sel === "0x313ce567" ? encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 6 }) : encodeFunctionResult({ abi: erc20Abi, functionName: "symbol", result: "USDC" }) };
      }
      throw new Error(`unexpected ${name}`);
    }) as never,
  }),
};

describe("whale-watching-agent web endpoint", () => {
  it("validates the query", () => {
    expect(parseRun(new URL("http://x/?window=pinned")).window).toBe("pinned");
    expect(() => parseRun(new URL("http://x/?blocks=99999"))).toThrow(/blocks must be one of/);
    expect(() => parseRun(new URL("http://x/?usdc=-5"))).toThrow(/positive number/);
    expect(() => parseRun(new URL("http://x/?window=all"))).toThrow(/window/);
    expect(parseRun(new URL("http://x/?usdc=100.5")).thresholds.USDC).toBe("100.5");
  });

  it("answers 400 for a bad action or input", async () => {
    expect((await handle(req("action=nope"), deps)).status).toBe(400);
    const r = await handle(req("action=run&blocks=7"), deps);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/blocks/);
  });

  it("info returns the committed watchlist and the limits", async () => {
    const body = await (await handle(req("action=info"), deps)).json();
    expect(body.watchlist.addresses).toHaveLength(5);
    expect(body.limits.blocks).toEqual([1000, 2000, 4000]);
    expect(body.deploy).toHaveProperty("commit");
  });

  it("streams the lamps and a summary as NDJSON", async () => {
    const res = await handle(req("action=run&window=recent&blocks=1000&usdc=10"), deps);
    expect(res.headers.get("content-type")).toMatch(/ndjson/);
    const ev = await events(res);
    const ok = ev.filter((e) => e.type === "step" && e.state !== "running").map((e) => e.id);
    expect(ok).toEqual(["connect", "watchlist", "scan-usdc", "explain", "summary"]);
    const start = ev.find((e) => e.type === "start")!;
    expect(start.range).toEqual({ from: "4001", to: "5000", blocks: "1000" });
    expect(start.thresholds[0]).toMatchObject({ symbol: "USDC", threshold: "10" });
    const done = ev.find((e) => e.type === "done")!;
    expect(done).toMatchObject({ transfers: 0, significant: 0, reports: [] });
    expect(done.rows).toHaveLength(5);
  });
});
