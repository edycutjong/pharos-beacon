import { describe, expect, it } from "vitest";
import { handle, parseStatus, type Deps } from "../tasks/recurring-payment-agent/web.js";
import { events, fakeRaw, req } from "./web-helpers.js";

const PAYER = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975";
const TO = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B";
const HASH = `0x${"ab".repeat(32)}`;
const plan = { id: "rent-demo", frequency: "weekly", start: "2026-11-01T09:00:00Z", amount: "0.001", token: "PHRS", recipient: TO, periods: 4 };
const parsed = { id: "rent-demo", frequency: "weekly", start: "2026-11-01T09:00:00.000Z", amount: "0.001", token: { symbol: "PHRS", decimals: 18 }, recipient: TO, periods: 4 };
const ledger = { plan: parsed, payer: PAYER, periods: [{ period: 1, due: "2026-11-01T09:00:00.000Z", status: "paid", attempts: [], tx: { hash: HASH, nonce: 1, raw: "0x", prepared: {} }, block: "10" }] };
const deps = (balance = "5000000000000000000", value = "0x38d7ea4c68000"): Deps => ({
  fetch: fakeRaw({ "plans/rent.json": plan, "state/rent-demo.json": ledger }),
  call: () => (async (name: string) => {
    if (name === "get_transaction_receipt") return { status: "0x1", blockNumber: "0xa", gasUsed: "0x5208", logs: [] };
    if (name === "get_transaction") return { from: PAYER, to: TO, value };
    if (name === "get_balance") return { balanceWei: balance };
    if (name === "estimate_gas") return { gas: "21000" };
    throw new Error(`unexpected ${name}`);
  }) as never,
});

describe("recurring-payment-agent web endpoint", () => {
  it("validates the query", () => {
    expect(parseStatus(new URL("http://x/?plan=rent&clock=2026-11-22")).clock?.toISOString()).toBe("2026-11-22T12:00:00.000Z");
    expect(parseStatus(new URL("http://x/?plan=wphrs&clock=now")).clock).toBeUndefined();
    expect(() => parseStatus(new URL("http://x/?plan=../x"))).toThrow(/plan/);
    expect(() => parseStatus(new URL("http://x/?clock=tomorrow"))).toThrow(/clock/);
    expect(() => parseStatus(new URL("http://x/?clock=1999-01-01"))).toThrow(/between/);
  });

  it("shows the history at the clock, confirms the paid tx and dry-runs the next payment", async () => {
    const ev = await events(await handle(req("action=status&plan=rent&clock=2026-11-08"), deps()));
    const done = ev.find((e) => e.type === "done")!;
    expect(done.rows.map((r: { status: string }) => r.status)).toEqual(["paid", "pending"]);
    expect(done.checks[0]).toMatchObject({ period: 1, ok: true });
    expect(done.would).toMatchObject({ period: 2, action: "pay now", gas: "21000" });
    expect(done.next).toMatchObject({ period: 3 });
  });

  it("says a run would fail on funds and sends nothing", async () => {
    const ev = await events(await handle(req("action=status&plan=rent&clock=2026-11-08"), deps("10")));
    const done = ev.find((e) => e.type === "done")!;
    expect(done.would.action).toBe("fail");
    expect(done.would.reason).toMatch(/insufficient PHRS.*nothing would be sent/);
    expect(ev.find((e) => e.id === "funds" && e.state === "refused")).toBeTruthy();
  });

  it("does not confirm a tx that pays the wrong amount", async () => {
    const ev = await events(await handle(req("action=status&plan=rent&clock=2026-11-08"), deps(undefined, "0x1")));
    expect(ev.find((e) => e.type === "done")!.checks[0].ok).toBe(false);
  });
});
