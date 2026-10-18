import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, erc20Abi, parseEther, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { BroadcastError, type PreparedTx, type Receipt, type SignedTx } from "../src/lib/signer.js";
import { dueAt, duePeriods, historyRows, historyTable, loadLedger, nextScheduled, parsePlan, runDue, type Plan, type Port } from "../src/recurring/agent.js";

const PAYER = "0x1111111111111111111111111111111111111111" as Hex;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Hex;
const TOKEN = "0x3333333333333333333333333333333333333333" as Hex;
const plan = (over: Record<string, unknown> = {}): Plan =>
  parsePlan({ id: "rent", frequency: "weekly", start: "2026-11-01T09:00:00Z", amount: "0.5", token: "PHRS", recipient: RECIPIENT, ...over });
const tmp = () => join(mkdtempSync(join(tmpdir(), "rec-")), "ledger.json");
const D = (s: string) => new Date(s);

interface Fake { port: Port; sent: SignedTx[]; prepares: number; native: bigint; token: bigint; mined: Map<Hex, Receipt>; script: { broadcast?: (s: SignedTx, n: number) => Promise<void>; reverted?: boolean } }
function fake(native = parseEther("5")): Fake {
  const f: Fake = { sent: [], prepares: 0, native, token: 0n, mined: new Map(), script: {}, port: undefined as unknown as Port };
  let nonce = 0, broadcasts = 0;
  f.port = {
    address: PAYER,
    nativeBalance: async () => f.native,
    tokenBalance: async () => f.token,
    receipt: async (h) => f.mined.get(h) ?? null,
    signer: {
      async prepare(intent) {
        f.prepares++;
        return { chainId: 688689, to: intent.to, value: intent.value ?? 0n, ...(intent.data ? { data: intent.data } : {}), nonce: intent.nonce ?? nonce++, gas: 21_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n } satisfies PreparedTx;
      },
      async sign(tx) {
        const hash = `0x${(f.prepares * 1000 + tx.nonce).toString(16).padStart(64, "0")}` as Hex;
        return { hash, raw: `0x${hash.slice(2)}aa` as Hex, tx };
      },
      async broadcast(s) {
        await f.script.broadcast?.(s, broadcasts++);
        f.sent.push(s);
        f.mined.set(s.hash, { status: f.script.reverted ? "reverted" : "success", blockNumber: 100n + BigInt(f.sent.length), gasUsed: 21_000n });
        return s.hash;
      },
      async waitForReceipt(h) {
        const r = f.mined.get(h);
        if (!r) throw new Error("no receipt");
        return r;
      },
    },
  };
  return f;
}
const opts = (p: Plan, file: string, f: Fake, now: string, extra = {}) => ({ plan: p, file, port: f.port, now: D(now), sleep: async () => {}, backoffMs: 0, ...extra });

describe("schedule", () => {
  it("weekly: every 7 days from the start", () => {
    expect(dueAt(plan(), 1).toISOString()).toBe("2026-11-01T09:00:00.000Z");
    expect(dueAt(plan(), 3).toISOString()).toBe("2026-11-15T09:00:00.000Z");
  });
  it("monthly: same day each month, clamped in a short month, back to the start day after", () => {
    const m = plan({ frequency: "monthly", start: "2026-01-31T09:00:00Z" });
    expect([1, 2, 3, 13].map((n) => dueAt(m, n).toISOString().slice(0, 10))).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2027-01-31"]);
  });
  it("lists the periods due at a clock, and the next one after it", () => {
    expect(duePeriods(plan(), D("2026-11-08T08:59:59Z"))).toEqual([1]);
    expect(duePeriods(plan(), D("2026-11-08T09:00:00Z"))).toEqual([1, 2]);
    expect(nextScheduled(plan(), D("2026-11-08T09:00:00Z"))?.period).toBe(3);
    expect(nextScheduled(plan({ periods: 2 }), D("2026-11-08T09:00:00Z"))).toBeUndefined();
  });
  it("rejects a bad plan", () => {
    expect(() => plan({ frequency: "daily" })).toThrow(/weekly/);
    expect(() => plan({ amount: "0" })).toThrow(/greater than zero/);
    expect(() => plan({ recipient: "nope" })).toThrow(/recipient/);
    expect(() => plan({ id: "Bad Id" })).toThrow(/plan.id/);
  });
});

describe("paying", () => {
  it("pays period 1, then period 2 at a later clock, and a re-run pays nothing", async () => {
    const f = fake(), file = tmp(), p = plan();
    const e1 = await runDue(opts(p, file, f, "2026-11-01T09:00:00Z"));
    expect(e1.map((e) => e.action)).toEqual(["paid"]);
    const e2 = await runDue(opts(p, file, f, "2026-11-08T09:00:00Z"));
    expect(e2.map((e) => e.action)).toEqual(["already-paid", "paid"]);
    const e3 = await runDue(opts(p, file, f, "2026-11-08T09:00:00Z"));
    expect(e3.map((e) => e.action)).toEqual(["already-paid", "already-paid"]);
    expect(f.sent).toHaveLength(2);
    expect(f.sent.every((s) => s.tx.to === RECIPIENT && s.tx.value === parseEther("0.5"))).toBe(true);
    expect(new Set(f.sent.map((s) => s.tx.nonce)).size).toBe(2);
  });

  it("nothing is due before the first date", async () => {
    const f = fake();
    expect(await runDue(opts(plan(), tmp(), f, "2026-10-31T00:00:00Z"))).toEqual([]);
    expect(f.prepares).toBe(0);
  });

  it("insufficient balance: failed with the reason, nothing prepared or sent; funded later it pays once", async () => {
    const f = fake(parseEther("0.2")), file = tmp(), p = plan();
    const [ev] = await runDue(opts(p, file, f, "2026-11-01T09:00:00Z"));
    expect(ev).toMatchObject({ action: "failed" });
    expect(ev!.detail).toMatch(/insufficient PHRS balance|insufficient PHRS/);
    expect(f.prepares).toBe(0);
    expect(f.sent).toHaveLength(0);
    expect(historyRows(p, loadLedger(file, p), D("2026-11-01T10:00:00Z")).rows[0]!.status).toBe("failed");
    f.native = parseEther("5");
    expect((await runDue(opts(p, file, f, "2026-11-01T10:00:00Z"))).map((e) => e.action)).toEqual(["paid"]);
    expect((await runDue(opts(p, file, f, "2026-11-01T11:00:00Z"))).map((e) => e.action)).toEqual(["already-paid"]);
    expect(f.sent).toHaveLength(1);
  });

  it("enough for the amount but not for the gas: failed, nothing sent", async () => {
    const f = fake(parseEther("0.5")); // 0.5 + 21000*10 wei of gas does not fit
    const [ev] = await runDue(opts(plan(), tmp(), f, "2026-11-01T09:00:00Z"));
    expect(ev!.action).toBe("failed");
    expect(ev!.detail).toMatch(/gas/);
    expect(f.sent).toHaveLength(0);
  });

  it("a crash between recording and broadcasting: the re-run re-sends the SAME transaction, never a new one", async () => {
    const f = fake(), file = tmp(), p = plan();
    f.script.broadcast = async () => { throw new Error("process killed"); };
    await expect(runDue(opts(p, file, f, "2026-11-01T09:00:00Z"))).rejects.toThrow(/killed/);
    const rec = loadLedger(file, p).periods[0]!;
    expect(rec.status).toBe("sent");
    const hash = rec.tx!.hash;
    expect(f.sent).toHaveLength(0);
    f.script.broadcast = undefined;
    const ev = await runDue(opts(p, file, f, "2026-11-01T09:30:00Z"));
    expect(ev[0]).toMatchObject({ action: "reconciled-paid", tx: hash });
    expect(f.prepares).toBe(1); // no second payment was ever built
    expect(f.sent.map((s) => s.hash)).toEqual([hash]);
  });

  it("a crash AFTER the node took it: the re-run finds the receipt and sends nothing", async () => {
    const f = fake(), file = tmp(), p = plan();
    f.script.broadcast = async (s) => {
      f.mined.set(s.hash, { status: "success", blockNumber: 7n, gasUsed: 21_000n });
      throw new Error("killed after the node accepted it");
    };
    await expect(runDue(opts(p, file, f, "2026-11-01T09:00:00Z"))).rejects.toThrow(/killed/);
    f.script.broadcast = undefined;
    const ev = await runDue(opts(p, file, f, "2026-11-01T09:30:00Z"));
    expect(ev[0]!.action).toBe("reconciled-paid");
    expect(f.sent).toHaveLength(0);
    expect(f.prepares).toBe(1);
  });

  it("the node refuses once: one retry on the same nonce, then paid, still once", async () => {
    const f = fake(), file = tmp(), p = plan();
    f.script.broadcast = async (s, n) => { if (n === 0) throw new BroadcastError(s, new Error("underpriced")); };
    const [ev] = await runDue(opts(p, file, f, "2026-11-01T09:00:00Z"));
    expect(ev!.action).toBe("paid");
    expect(f.prepares).toBe(2);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.tx.nonce).toBe(0);
    const rec = loadLedger(file, p).periods[0]!;
    expect(rec.attempts.map((a) => a.outcome).join("|")).toMatch(/refused by the node: underpriced/);
  });

  it("the node refuses twice: failed, nothing paid; a later run can still pay it", async () => {
    const f = fake(), file = tmp(), p = plan();
    f.script.broadcast = async (s) => { throw new BroadcastError(s, new Error("down")); };
    const [ev] = await runDue(opts(p, file, f, "2026-11-01T09:00:00Z"));
    expect(ev!.action).toBe("failed");
    expect(f.sent).toHaveLength(0);
    f.script.broadcast = undefined;
    expect((await runDue(opts(p, file, f, "2026-11-01T10:00:00Z")))[0]!.action).toBe("paid");
    expect(f.sent).toHaveLength(1);
  });

  it("a mined revert is failed with the reason and may be retried with a new transaction", async () => {
    const f = fake(), file = tmp(), p = plan();
    f.script.reverted = true;
    expect((await runDue(opts(p, file, f, "2026-11-01T09:00:00Z")))[0]).toMatchObject({ action: "failed" });
    f.script.reverted = false;
    expect((await runDue(opts(p, file, f, "2026-11-01T10:00:00Z")))[0]!.action).toBe("paid");
    expect(f.sent).toHaveLength(2);
  });

  it("an ERC-20 period checks the token balance and sends transfer(recipient, amount) to the token", async () => {
    const p = plan({ token: { address: TOKEN, symbol: "TST", decimals: 6 }, amount: "12.5" });
    const poor = fake(); poor.token = 1_000_000n;
    expect((await runDue(opts(p, tmp(), poor, "2026-11-01T09:00:00Z")))[0]!.detail).toMatch(/insufficient TST balance: has 1, needs 12.5/);
    const f = fake(); f.token = 100_000_000n;
    expect((await runDue(opts(p, tmp(), f, "2026-11-01T09:00:00Z")))[0]!.action).toBe("paid");
    const tx = f.sent[0]!.tx;
    expect(tx.to).toBe(TOKEN);
    expect(tx.value).toBe(0n);
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(call.functionName).toBe("transfer");
    expect(call.args).toEqual([RECIPIENT, 12_500_000n]);
  });

  it("a Discord receipt per payment; a failing notifier changes nothing about what was paid", async () => {
    const sentMsgs: string[] = [];
    const f = fake(), file = tmp(), p = plan();
    const notifier = { name: "discord", send: async (t: string) => (sentMsgs.push(t), { id: "m1", timestamp: "", content: t }) };
    await runDue(opts(p, file, f, "2026-11-01T09:00:00Z", { notifier }));
    expect(sentMsgs).toHaveLength(1);
    expect(sentMsgs[0]).toMatch(/#1.*0\.5 PHRS paid to 0x2222/);
    await runDue(opts(p, file, f, "2026-11-01T09:10:00Z", { notifier }));
    expect(sentMsgs).toHaveLength(1); // a re-run sends no second receipt
    const f2 = fake(), p2 = plan({ id: "other" });
    const bad = { name: "discord", send: async () => { throw new Error("webhook down"); } };
    expect((await runDue(opts(p2, tmp(), f2, "2026-11-01T09:00:00Z", { notifier: bad })))[0]!.action).toBe("paid");
  });

  it("refuses a ledger written for a different plan, and a self payment", async () => {
    const f = fake(), file = tmp();
    await runDue(opts(plan(), file, f, "2026-11-01T09:00:00Z"));
    await expect(runDue(opts(plan({ amount: "9" }), file, f, "2026-11-08T09:00:00Z"))).rejects.toThrow(/different plan/);
    await expect(runDue(opts(plan({ recipient: PAYER }), tmp(), f, "2026-11-01T09:00:00Z"))).rejects.toThrow(/yourself/);
  });
});

describe("history", () => {
  it("shows paid / pending / failed per period and the next scheduled payment", async () => {
    const f = fake(), file = tmp(), p = plan();
    await runDue(opts(p, file, f, "2026-11-01T09:00:00Z"));
    f.native = 0n;
    await runDue(opts(p, file, f, "2026-11-08T09:00:00Z"));
    const table = historyTable(p, loadLedger(file, p), D("2026-11-15T10:00:00Z"));
    const lines = table.split("\n");
    expect(lines.find((l) => l.startsWith("1 "))).toMatch(/paid/);
    expect(lines.find((l) => l.startsWith("2 "))).toMatch(/failed.*insufficient/);
    expect(lines.find((l) => l.startsWith("3 "))).toMatch(/pending.*not yet processed/);
    expect(lines.at(-1)).toBe("next payment: period 4 on 2026-11-22 (09:00Z), 0.5 PHRS to " + RECIPIENT);
    expect(JSON.parse(readFileSync(file, "utf8")).periods).toHaveLength(2);
  });
});
