// The Event/Log Monitor demo endpoint (tasks/event-log-monitor/web.ts): input checks and the streamed run, on a fake chain.
import { describe, expect, it } from "vitest";
import { handle, parseRun, run, SCENARIOS } from "../tasks/event-log-monitor/web.js";
import { fakeChain, TOKEN, transferLog } from "./helpers/fake-logs.js";

const u = (q: string) => new URL(`http://x/api/event-log-monitor?${q}`);
const reader = (call: any) => async () => ({ network: "atlantic" as const, chainId: 688689, endpoint: "fake://rpc", via: "direct JSON-RPC" as const, call, close: async () => {} });

describe("event-log-monitor web", () => {
  it("checks its input", () => {
    expect(parseRun(u("scenario=mainnet-usdc")).network).toBe("pharos");
    expect(parseRun(u("scenario=atlantic-proof")).pins).toEqual([31555650n, 31555665n, 31555680n]);
    expect(() => parseRun(u("scenario=nope"))).toThrow(/scenario must be/);
    expect(() => parseRun(u("scenario=custom&contract=0x12"))).toThrow(/address/);
    expect(() => parseRun(u(`scenario=custom&contract=${TOKEN}&event=Swap`))).toThrow(/event must be/);
    expect(() => parseRun(u(`scenario=custom&contract=${TOKEN}&blocks=5000`))).toThrow(/1 to 1000/);
    expect(parseRun(u(`scenario=custom&contract=${TOKEN}&network=atlantic&blocks=50`))).toMatchObject({ network: "atlantic", blocks: 50, event: "Transfer" });
  });

  it("answers 400 / 404 / health without touching a chain", async () => {
    expect((await handle(new Request("http://x/api?action=run&scenario=custom&contract=bad"))).status).toBe(400);
    expect((await handle(new Request("http://x/api?action=nope"))).status).toBe(404);
    const h = await (await handle(new Request("http://x/api?action=health"))).json();
    expect(h).toMatchObject({ status: "ok", task: "event-log-monitor" });
    expect(Object.keys(h.scenarios)).toEqual(Object.keys(SCENARIOS));
  });

  it("streams three polls, prints each event once and counts no repeats", async () => {
    const chain = { head: 120, logs: [transferLog(105, 0, 1, 10n ** 16n), transferLog(110, 1, 2, 10n ** 14n)] };
    const call = fakeChain(chain);
    let n = 0;
    const live = (async (tool: string, a: any) => {
      if (tool === "get_block_number" && ++n === 3) {
        chain.head = 125; // a new event arrives between poll 1 and poll 2
        chain.logs.push(transferLog(122, 0, 3, 10n ** 16n));
      }
      return call(tool, a);
    }) as any;
    const events: any[] = [];
    await run({ network: "atlantic", contract: TOKEN, event: "Transfer", blocks: 30, pollMs: 0 }, (e) => events.push(e), reader(live) as any);
    const rows = events.filter((e) => e.type === "event");
    expect(rows.map((r) => [r.poll, r.block])).toEqual([[1, "105"], [1, "110"], [2, "122"]]);
    expect(rows[0]).toMatchObject({ amount: "0.01 WPHRS", explorer: expect.stringContaining("atlantic.pharosscan.xyz/tx/") });
    expect(events.filter((e) => e.type === "step").map((s) => s.id)).toEqual(["connect", "token", "poll1", "poll2", "restart"]);
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ events: 3, repeated: 0, polls: 3, range: { from: "90" }, topic0: expect.stringMatching(/^0xddf252ad/) });
    expect(done.state.next).toBe(String(Number(done.range.to) + 1));
  });
});
