import { describe, expect, it, vi } from "vitest";
import { InsufficientFunds } from "../src/aggregator/run.js";
import { InputError } from "../src/web/live.js";
import type { Deps } from "../src/web/mainnet-live.js";

const h = vi.hoisted(() => ({ requests: [] as any[], report: undefined as any, error: undefined as Error | undefined, sources: [] as any[] }));

vi.mock("../src/portfolio/read.js", async (orig) => ({
  ...(await orig<typeof import("../src/portfolio/read.js")>()),
  readProsPrice: vi.fn(async () => ({ price: 0.65 })),
}));
vi.mock("../src/yield/sources.js", async (orig) => ({
  ...(await orig<typeof import("../src/yield/sources.js")>()),
  morphoUsdcSources: vi.fn(async () => ({ sources: h.sources, skipped: [] })),
}));
vi.mock("../src/aggregator/adapters.js", () => ({ venuesFromSources: vi.fn(() => [{ id: "morpho-c79579" }, { id: "rockawayx-aaaaaa" }]) }));
vi.mock("../src/aggregator/format.js", () => ({ renderReport: vi.fn((r: any) => [`report at ${r.block}`, "second line"]) }));
vi.mock("../src/aggregator/run.js", async (orig) => ({
  ...(await orig<typeof import("../src/aggregator/run.js")>()),
  aggregate: vi.fn(async (o: any) => {
    h.requests.push(o);
    if (h.error) throw h.error;
    return h.report;
  }),
}));

import { SAMPLE_WALLET, handle, parseRun, run } from "../tasks/multi-protocol-aggregator/web.js";

const q = (s: string) => new URL(`http://x/api?${s}`);
const conn = () => {
  const closed = { n: 0 };
  const deps: Deps = {
    connect: async () => ({
      endpoint: "fake-mcp",
      close: async () => void closed.n++,
      call: (async (tool: string, args: any) => {
        if (tool === "get_block_number") return { blockNumber: "777" };
        if (tool === "get_block") return { timestamp: "1700000000", args };
        throw new Error(`unexpected ${tool}`);
      }) as never,
    }),
  };
  return { deps, closed };
};
const base = { kind: "rates" as const, wallet: SAMPLE_WALLET as never, down: [] as string[], holdDays: 30 };
const REPORT = {
  block: "777", down: [], views: [{}, {}, {}], route: undefined as any, plan: undefined as any,
};

describe("aggregator web: parameters", () => {
  it("defaults to a rates read of the sample wallet", () => {
    expect(parseRun(q("action=run"))).toMatchObject({ kind: "rates", down: [], holdDays: 30 });
  });
  it("a deposit or withdrawal needs a sane amount; 'all' is only for withdrawing; other kinds take none", () => {
    expect(() => parseRun(q("kind=deposit"))).toThrow("deposit needs amount (a USDC amount)");
    expect(() => parseRun(q("kind=withdraw"))).toThrow("withdraw needs amount (a USDC amount or all)");
    expect(() => parseRun(q("kind=deposit&amount=all"))).toThrow(/at most 6 decimals/);
    expect(() => parseRun(q("kind=withdraw&amount=0"))).toThrow(/positive USDC amount/);
    expect(() => parseRun(q("kind=rates&amount=5"))).toThrow("amount is for deposit and withdraw");
    expect(parseRun(q("kind=withdraw&amount=all")).amount).toBe("all");
    expect(parseRun(q("kind=deposit&amount=250.5")).amount).toBe("250.5");
  });
  it("checks kind, wallet, down and block", () => {
    expect(() => parseRun(q("kind=swap"))).toThrow("kind must be one of rates, positions, deposit, withdraw");
    expect(() => parseRun(q("wallet=0x12"))).toThrow(InputError);
    expect(() => parseRun(q("down=bogus"))).toThrow(/is not a protocol/);
    expect(parseRun(q("down=morpho, centrifuge,morpho-c79579")).down).toEqual(["morpho", "centrifuge", "morpho-c79579"]);
    expect(() => parseRun(q("block=abc"))).toThrow("block must be a block number");
    expect(parseRun(q("block=500")).block).toBe(500n);
  });
});

describe("aggregator web: run", () => {
  it("renders a rates read: no route, venues counted, nothing signed", async () => {
    h.requests = [];
    h.report = { ...REPORT };
    const { deps, closed } = conn();
    const out: any[] = [];
    await run(base, (e) => out.push(e), deps);
    const req = h.requests[0];
    expect(req.request).toEqual({ kind: "rates" });
    expect(req).toMatchObject({ network: "pharos", assetDecimals: 6, holdDays: 30, assumeFunded: false, down: [] });
    expect(req.nativeUsd.basis).toMatch(/^PROS in USDC from the WPROS\/USDC pool 0x.* at block 777$/);
    const v = out.at(-1).view;
    expect(out.at(-1).type).toBe("done");
    expect(v.tone).toBe("ok");
    expect(v.verdict).toBe("3 venues read at block 777");
    expect(v.text).toBe("report at 777\nsecond line");
    expect(v.tables).toEqual([]);
    expect(v.summary).toBe("3 venues read.");
    expect(v.evidence[1][1]).toBe("777 (the head, read first)");
    expect(v.evidence[2][1]).toBe("rates");
    expect(out.find((e) => e.id === "route" && e.state !== "running")).toMatchObject({ state: "skip", label: "no routing for a query" });
    expect(closed.n).toBe(1);
  });

  it("a deposit becomes an unsigned plan table, with the amount in USDC base units and the wallet assumed funded", async () => {
    h.requests = [];
    h.report = {
      ...REPORT,
      route: { allocations: [{}, {}], explanation: ["Put it all in morpho-c79579: best net APY."] },
      plan: { transactions: [{ step: 1, description: "approve USDC", venue: "morpho-c79579", gas: { units: 46_000, basis: "estimate_gas" } }] },
    };
    const out: any[] = [];
    await run({ ...base, kind: "deposit", amount: "250.5", block: 700n }, (e) => out.push(e), conn().deps);
    expect(h.requests[0].request).toEqual({ kind: "deposit", assets: 250_500_000n });
    expect(h.requests[0].assumeFunded).toBe(true);
    const v = out.at(-1).view;
    expect(v.verdict).toBe("Put it all in morpho-c79579: best net APY.");
    expect(v.tables[0].head).toEqual(["Step", "Action", "Venue", "Gas"]);
    expect(v.tables[0].rows).toEqual([["1", "approve USDC", "morpho-c79579", "46,000 (estimate_gas)"]]);
    expect(v.evidence[1][1]).toBe("777 (pinned)");
    expect(v.evidence[2][1]).toBe("deposit 250.5 USDC");
    expect(out.find((e) => e.id === "route" && e.state !== "running")).toMatchObject({ state: "ok", label: "2 venues" });
  });

  it("withdraw all passes 'all', and a drill marks the page as a warning", async () => {
    h.requests = [];
    h.report = { ...REPORT, down: ["morpho-c79579"], route: { allocations: [{}], explanation: [] } };
    const out: any[] = [];
    await run({ ...base, kind: "withdraw", amount: "all", down: ["morpho-c79579"] }, (e) => out.push(e), conn().deps);
    expect(h.requests[0].request).toEqual({ kind: "withdraw", assets: "all" });
    expect(h.requests[0].down).toEqual(["morpho-c79579"]);
    const v = out.at(-1).view;
    expect(v.tone).toBe("warn");
    expect(v.verdict).toBe("Routed");
    expect(v.note).toContain("A venue marked SIMULATED is a drill");
    expect(v.summary).toBe("Routed.");
    expect(out.find((e) => e.id === "route" && e.state !== "running")?.label).toBe("1 venue");
  });

  it("truncates a long explanation for the verdict", async () => {
    h.report = { ...REPORT, route: { allocations: [{}], explanation: ["x".repeat(300)] } };
    const out: any[] = [];
    await run(base, (e) => out.push(e), conn().deps);
    expect(out.at(-1).view.verdict).toBe(`${"x".repeat(219)}…`);
  });

  it("refuses a down venue that does not exist, naming the real ones", async () => {
    const { deps, closed } = conn();
    await expect(run({ ...base, down: ["morpho-ffffff"] }, () => {}, deps)).rejects.toThrow("down: no venue morpho-ffffff; venues: morpho-c79579, rockawayx-aaaaaa");
    expect(closed.n).toBe(1);
  });

  it("turns insufficient funds into a refusal the page shows, and rethrows other errors", async () => {
    h.error = new InsufficientFunds("the wallet holds 0 USDC; needs 250");
    try {
      await expect(run({ ...base, kind: "deposit", amount: "250" }, () => {}, conn().deps)).rejects.toThrow(new InputError("refused: the wallet holds 0 USDC; needs 250"));
      h.error = new Error("venue timed out");
      const out: any[] = [];
      await expect(run(base, (e) => out.push(e), conn().deps)).rejects.toThrow("venue timed out");
      expect(out.some((e) => e.type === "step" && e.state === "failed")).toBe(true);
    } finally {
      h.error = undefined;
    }
  });

  it("serves info and a run through handle()", async () => {
    h.report = { ...REPORT };
    expect((await (await handle(new Request("http://x/api?action=info"))).json()).protocols).toEqual(["rockawayx", "morpho", "centrifuge"]);
    const res = await handle(new Request("http://x/api?action=run"), conn().deps);
    expect(JSON.parse((await res.text()).trim().split("\n").at(-1)!).type).toBe("done");
    expect((await handle(new Request("http://x/api?action=run&kind=zz"), conn().deps)).status).toBe(400);
  });
});
