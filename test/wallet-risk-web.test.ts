import { describe, expect, it } from "vitest";
import { handle, parseCheck, riskPhase, type Deps } from "../tasks/wallet-risk-checker/web.js";
import { events, fakeRaw, req } from "./web-helpers.js";

const config = { youngDays: 7, flagged: [{ address: "0xf1a9000000000000000000000000000000000001", reason: "demo", source: "ours" }], trustedSpenders: [], extraTokens: [] };
const ADDR = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const deps: Deps = {
  fetch: fakeRaw({ "risk-config.json": config, "risk-config-no-list.json": { ...config, flagged: [] } }),
  // An address with no history at all: no code, nonce 0, balance 0, no logs.
  connect: async () => ({
    endpoint: "fake", close: async () => {},
    call: (async (name: string) => {
      if (name === "get_block_number") return { blockNumber: "100000" };
      if (name === "get_code") return { code: "0x" };
      if (name === "get_transaction_count") return { nonce: "0" };
      if (name === "get_balance") return { balanceWei: "0" };
      if (name === "get_block") return { timestamp: "0x0" };
      if (name === "get_logs") return [];
      throw new Error(`unexpected ${name}`);
    }) as never,
  }),
};

describe("wallet-risk-checker web endpoint", () => {
  it("validates the query", () => {
    const p = parseCheck(new URL(`http://x/?address=${ADDR.toLowerCase()}&network=atlantic&block=123&lookback=1000&list=empty`));
    expect(p).toMatchObject({ address: ADDR, network: "atlantic", block: 123n, lookback: 1000, list: "empty" });
    expect(() => parseCheck(new URL("http://x/?address=0x123"))).toThrow(/0x address/);
    expect(() => parseCheck(new URL(`http://x/?address=${ADDR}&network=sepolia`))).toThrow(/network/);
    expect(() => parseCheck(new URL(`http://x/?address=${ADDR}&block=12a`))).toThrow(/block/);
    expect(() => parseCheck(new URL(`http://x/?address=${ADDR}&lookback=30000`))).toThrow(/lookback/);
    expect(() => parseCheck(new URL(`http://x/?address=${ADDR}&list=theirs`))).toThrow(/list/);
  });

  it("names the phases of checkAddress in its fixed order", () => {
    const ph = riskPhase();
    const seq = [["get_block_number"], ["get_code"], ["get_transaction_count"], ["get_balance"], ["get_transaction_count"], ["get_block"], ["get_logs"], ["get_block"], ["get_code"]];
    let cur: string | undefined;
    const out = seq.map(([t]) => (cur = ph(t!, {}, cur)));
    expect(out).toEqual(["head", "reads", "reads", "reads", "age", "age", "logs", "logs", "logs"]);
  });

  it("answers 400 with the reason", async () => {
    const r = await handle(req("action=check&address=nope"), deps);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/address/);
  });

  it("streams the lamps and a report with a verdict", async () => {
    const ev = await events(await handle(req(`action=check&address=${ADDR}&network=pharos`), deps));
    const ok = ev.filter((e) => e.type === "step" && e.state !== "running").map((e) => e.id);
    expect(ok).toEqual(["head", "reads", "age", "logs", "verdict"]); // the age probe at the head finds no history
    const done = ev.find((e) => e.type === "done")!;
    expect(done.report.verdict).toBe("medium");
    expect(done.report.signals).toHaveLength(6);
    expect(done.report.block).toBe("100000");
    expect(done.reads).toBeGreaterThan(5);
  });
});
