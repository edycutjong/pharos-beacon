import { describe, expect, it } from "vitest";
import { handle, parseRun, type Deps } from "../tasks/trend-watcher/web.js";
import { events, fakeRaw, req } from "./web-helpers.js";

const ADDR = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const values: Record<string, string> = { "100": "50", "200": "40", "300": "45", "400": "44", "500": "43", "600": "42" };
const state = { metric: { kind: "balance", network: "pharos", address: ADDR }, observations: Object.entries(values).map(([block, value]) => ({ block, value, at: "2026-10-18T00:00:00.000Z" })), acted: ["600"] };
const deps = (vals = values): Deps => ({
  fetch: fakeRaw({ "state/mainnet-balance.json": state }),
  connect: async () => ({
    endpoint: "fake", close: async () => {},
    call: (async (name: string, args: { block?: string }) => {
      if (name === "get_block_number") return { blockNumber: "600" };
      if (name === "get_balance") return { balanceWei: vals[args.block!] ?? "1" };
      throw new Error(`unexpected ${name}`);
    }) as never,
  }),
});

describe("trend-watcher web endpoint", () => {
  it("validates the query", () => {
    expect(parseRun(new URL("http://x/?mode=replay&history=spike&steps=4&direction=rise"))).toMatchObject({ mode: "replay", history: "spike", rule: { steps: 4, direction: "rise" } });
    expect(() => parseRun(new URL("http://x/?steps=1"))).toThrow(/at least|from 2/);
    expect(() => parseRun(new URL("http://x/?steps=9"))).toThrow(/steps/);
    expect(() => parseRun(new URL("http://x/?history=../../etc"))).toThrow(/history/);
    expect(() => parseRun(new URL("http://x/?mode=sample&gap=7"))).toThrow(/gap/);
    expect(() => parseRun(new URL("http://x/?mode=sample&metric=balance&address=0xzz"))).toThrow(/address/);
  });

  it("replays a stored history: re-reads each block, checks it, and marks where the rule is met", async () => {
    const ev = await events(await handle(req("action=run&mode=replay&history=mainnet"), deps()));
    const done = ev.find((e) => e.type === "done")!;
    expect(done.allMatch).toBe(true);
    expect(done.evaluation.triggers).toEqual([5]); // the dip at #2 reversed at #3; #4..#6 are three falls
    expect(done.alerts[0].message).toMatch(/TREND MET/);
    expect(ev.filter((e) => e.type === "step" && e.state === "ok").map((e) => e.id)).toContain("obs-6");
  });

  it("flags a stored value the chain does not confirm", async () => {
    const ev = await events(await handle(req("action=run&mode=replay&history=mainnet"), deps({ ...values, "300": "46" })));
    expect(ev.find((e) => e.type === "done")!.allMatch).toBe(false);
    expect(ev.find((e) => e.id === "obs-3" && e.state === "failed")).toBeTruthy();
  });

  it("samples steps + 1 blocks ending at the head", async () => {
    const ev = await events(await handle(req("action=run&mode=sample&metric=balance&gap=100&steps=2"), deps()));
    expect(ev.find((e) => e.type === "start")!.blocks).toEqual(["400", "500", "600"]);
    expect(ev.find((e) => e.type === "done")!.evaluation.state).toBe("triggered");
  });
});
