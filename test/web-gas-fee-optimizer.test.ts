// The Gas Fee Optimizer demo endpoint: input validation and the streamed hold, on a fake Atlantic RPC (never sends).
import { describe, expect, it } from "vitest";
import type { Rpc } from "../src/lib/atlantic-call.js";
import { handle, holdParams, runHold, runSample } from "../tasks/gas-fee-optimizer/web.js";

const rpc = (methods: string[] = []): Rpc => ({
  async request({ method }) {
    methods.push(method);
    if (method === "eth_getBlockByNumber") return { number: "0x10", baseFeePerGas: "0x3b9aca00" };
    if (method === "eth_gasPrice") return "0x3b9aca00";
    if (method === "eth_maxPriorityFeePerGas") return "0x0";
    throw new Error(`unexpected ${method}`);
  },
});

describe("gas-fee-optimizer web", () => {
  it("rejects bad input with a 400", async () => {
    for (const qs of ["action=hold&target=x", "action=hold&deadline=5", "action=hold&deadline=600", "action=hold&target=p:0", "action=hold&target=gwei:0", "action=sample&count=99", "action=send"]) {
      const res = await handle(new Request(`http://x/api/gas-fee-optimizer?${qs}`));
      expect(res.status, qs).toBe(400);
    }
  });

  it("parses targets and applies the CLI's default lead", () => {
    expect(holdParams(new URLSearchParams("target=gwei:1.5&deadline=30"))).toMatchObject({ deadlineS: 30, leadS: 8, intervalS: 3, target: { kind: "price", wei: 1_500_000_000n } });
    expect(holdParams(new URLSearchParams("target=p:25&deadline=10"))).toMatchObject({ leadS: 5, target: { kind: "percentile", p: 25, window: 20 } });
  });

  it("a price at or below target decides on the first reading and reports request vs decision price", async () => {
    const ev: any[] = [];
    const methods: string[] = [];
    await runHold((e) => ev.push(e), { deadlineS: 10, leadS: 5, intervalS: 2, target: { kind: "price", wei: 1_500_000_000n } }, rpc(methods));
    expect(ev.map((e) => e.type)).toEqual(["start", "sample", "done"]);
    expect(ev.at(-1)).toMatchObject({ reason: "gas at or below target", requestGwei: "1", decisionGwei: "1", wouldPayPHRS: "0.000021", savedPct: "0.00" });
    expect(methods.some((m) => /send/i.test(m))).toBe(false);
  });

  it("a target below the price holds until the send-by time", async () => {
    const ev: any[] = [];
    await runHold((e) => ev.push(e), { deadlineS: 2, leadS: 1, intervalS: 1, target: { kind: "price", wei: 500_000_000n } }, rpc());
    expect(ev.at(-1)).toMatchObject({ type: "done", reason: "deadline reached" });
    expect(ev.filter((e) => e.type === "sample").length).toBeGreaterThanOrEqual(1);
  });

  it("sample streams one event per reading", async () => {
    const ev: any[] = [];
    await runSample((e) => ev.push(e), 2, new AbortController().signal, rpc(), 0);
    expect(ev.map((e) => e.type)).toEqual(["start", "sample", "sample", "done"]);
    expect(ev.at(-1)).toMatchObject({ minGwei: "1", maxGwei: "1" });
  });
});
