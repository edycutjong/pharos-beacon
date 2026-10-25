import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/lib/cli.js";
import { main } from "../tasks/recurring-payment-agent/index.js";

const PAYER = "0x1111111111111111111111111111111111111111" as Hex;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Hex;
const h = vi.hoisted(() => ({ balanceWei: "0", broadcastFlag: undefined as unknown, closed: 0, sent: [] as string[], revert: false }));

vi.mock("../src/lib/mcp.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/mcp.js")>()),
  chainMcp: vi.fn(async (_net: string, o: { broadcast?: boolean }) => {
    h.broadcastFlag = o?.broadcast;
    return {
      endpoint: "fake", network: "atlantic", chainId: 688689, close: async () => void h.closed++,
      call: async (tool: string) => {
        if (tool === "get_balance") return { balanceWei: h.balanceWei };
        if (tool === "get_transaction_receipt") return null;
        throw new Error(`unexpected ${tool}`);
      },
    };
  }),
}));
vi.mock("../src/lib/signer.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/signer.js")>()),
  testnetSigner: () => {
    let n = 0;
    return {
      address: PAYER,
      prepare: async (i: any) => ({ chainId: 688689, to: i.to, value: i.value ?? 0n, nonce: i.nonce ?? n++, gas: 21_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
      sign: async (tx: any) => ({ hash: `0x${(tx.nonce + 1).toString(16).padStart(64, "0")}`, raw: "0xaa", tx }),
      broadcast: async () => undefined,
      waitForReceipt: async () => ({ status: h.revert ? "reverted" : "success", blockNumber: 5n, gasUsed: 21_000n }),
    };
  },
}));
vi.mock("../src/watch/discord.js", async (orig) => ({
  ...(await orig<typeof import("../src/watch/discord.js")>()),
  loadWebhook: () => new URL("https://discord.com/api/webhooks/1/x"),
  discordNotifier: () => ({ name: "discord", send: async (b: string) => (h.sent.push(b), { id: "d1", timestamp: "t" }) }),
}));

let logs: string[] = [];
const dirs: string[] = [];
const tmp = () => (dirs.push(mkdtempSync(join(tmpdir(), "rec-cli-"))), dirs.at(-1)!);
const ctx = () => ({ onExit: () => {}, signal: new AbortController().signal });
const out = () => logs.join("\n");

function files(over: Record<string, unknown> = {}) {
  const d = tmp();
  const plan = join(d, "plan.json");
  writeFileSync(plan, JSON.stringify({ id: "cli-rent", frequency: "weekly", start: "2026-11-01T09:00:00Z", amount: "0.001", token: "PHRS", recipient: RECIPIENT, periods: 3, ...over }));
  return { plan, state: join(d, "ledger.json") };
}
const NOW = "2026-11-08T09:00:00Z"; // periods 1 and 2 are due

beforeEach(() => {
  logs = [];
  h.balanceWei = parseEther("1").toString();
  h.closed = 0;
  h.sent = [];
  h.revert = false;
  vi.spyOn(console, "log").mockImplementation((s: unknown) => void logs.push(String(s)));
});
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe("recurring-payment-agent CLI: input checks", () => {
  const bad = (argv: string[], re: RegExp) => expect(main(ctx(), argv)).rejects.toThrow(re);
  it("rejects unknown commands, a missing plan, bad clocks and plan files", async () => {
    await bad(["frobnicate"], /unknown command frobnicate: use status or run/);
    await bad(["status"], /--plan <file.json> is required/);
    const f = files();
    await bad(["status", "--plan", f.plan, "--now", "yesterday"], /--now must be a date/);
    await bad(["status", "--plan", join(tmp(), "none.json")], /none\.json: /);
    const broken = join(tmp(), "p.json");
    writeFileSync(broken, JSON.stringify({ id: "x", frequency: "daily" }));
    await bad(["status", "--plan", broken], /p\.json: .*weekly/);
    await expect(main(ctx(), ["status", "--plan", f.plan, "--bogus"])).rejects.toBeInstanceOf(UsageError);
  });

  it("validates the scheduler flags", async () => {
    const f = files();
    await bad(["status", "--plan", f.plan, "--every", "5"], /works with run/);
    await bad(["run", "--plan", f.plan, "--every", "0"], /works with run/);
    await bad(["run", "--plan", f.plan, "--every", "5", "--rounds", "0"], /--rounds must be >= 1/);
    await bad(["run", "--plan", f.plan, "--every", "5", "--now", NOW], /drop --now/);
  });
});

describe("recurring-payment-agent CLI: status and dry run", () => {
  it("status prints the history at the injected clock and touches no chain", async () => {
    const f = files();
    expect(await main(ctx(), ["status", "--plan", f.plan, "--state", f.state, "--now", NOW])).toBe(0);
    expect(out()).toContain(`clock: injected --now 2026-11-08T09:00:00.000Z (not the real time)`);
    expect(out()).toMatch(/pending/);
    expect(h.closed).toBe(0);
  });

  it("status --compact wraps lines to the narrow width", async () => {
    const f = files();
    await main(ctx(), ["status", "--plan", f.plan, "--state", f.state, "--now", NOW, "--compact"]);
    expect(Math.max(...logs.flatMap((l) => l.split("\n")).map((l) => l.length))).toBeLessThanOrEqual(62);
  });

  it("a run without --execute only says what it would do and never asks to broadcast", async () => {
    const f = files();
    expect(await main(ctx(), ["run", "--plan", f.plan, "--state", f.state, "--now", NOW])).toBe(0);
    expect(out()).toContain("would process 2 period(s): #1 (pending), #2 (pending) — add --execute to pay");
    expect(h.broadcastFlag).toBe(false);
    expect(() => readFileSync(f.state, "utf8")).toThrow(); // nothing written
  });

  it("a dry run before any period is due reports nothing to pay", async () => {
    const f = files();
    await main(ctx(), ["run", "--plan", f.plan, "--state", f.state, "--now", "2026-10-01T00:00:00Z"]);
    expect(out()).toContain("nothing to pay: every period due so far is already paid");
  });
});

describe("recurring-payment-agent CLI: execute", () => {
  it("pays each due period once, journals it and prints receipts to the console", async () => {
    const f = files();
    expect(await main(ctx(), ["run", "--plan", f.plan, "--state", f.state, "--now", NOW, "--execute"])).toBe(0);
    expect(h.broadcastFlag).toBe(true);
    expect(out()).toContain(`paying wallet ${PAYER} (Atlantic)`);
    expect(out()).toMatch(/RECEIPT \[console\] Recurring payment cli-rent #1: 0\.001 PHRS paid to /);
    const ledger = JSON.parse(readFileSync(f.state, "utf8"));
    expect(ledger.periods.map((p: any) => [p.period, p.status])).toEqual([[1, "paid"], [2, "paid"]]);
    // a second run at the same clock pays nothing again
    logs = [];
    expect(await main(ctx(), ["run", "--plan", f.plan, "--state", f.state, "--now", NOW, "--execute"])).toBe(0);
    expect(out()).not.toMatch(/RECEIPT/); // nothing was paid again
    expect(h.sent).toHaveLength(0);
    expect(JSON.parse(readFileSync(f.state, "utf8")).periods.every((p: any) => p.status === "paid")).toBe(true);
  });

  it("says nothing is due before the first period", async () => {
    const f = files();
    await main(ctx(), ["run", "--plan", f.plan, "--state", f.state, "--now", "2026-10-01T00:00:00Z", "--execute"]);
    expect(out()).toContain("nothing due at this clock");
  });

  it("exits 1 when a period fails for lack of funds, and 1 when the transaction reverts", async () => {
    const f = files();
    h.balanceWei = "0";
    expect(await main(ctx(), ["run", "--plan", f.plan, "--state", f.state, "--now", NOW, "--execute"])).toBe(1);
    expect(out()).toMatch(/insufficient PHRS balance: has 0, needs 0\.001; nothing was sent/);
    const g = files();
    h.balanceWei = parseEther("1").toString();
    h.revert = true;
    expect(await main(ctx(), ["run", "--plan", g.plan, "--state", g.state, "--now", "2026-11-01T09:00:00Z", "--execute"])).toBe(1);
    expect(out()).toMatch(/mined but reverted/);
  });

  it("sends receipts to Discord with --discord and shortens the wallet with --compact", async () => {
    const f = files();
    await main(ctx(), ["run", "--plan", f.plan, "--state", f.state, "--now", "2026-11-01T09:00:00Z", "--execute", "--discord", "--compact"]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/Recurring payment cli-rent #1/);
    expect(out()).toContain("paying wallet 0x111111…1111 (Atlantic)");
    expect(out()).not.toContain("RECEIPT [console]");
  });

  it("the scheduler runs --rounds times on the real clock and reports the worst exit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const f = files({ start: "2020-01-01T00:00:00Z", periods: 1 });
      const p = main(ctx(), ["run", "--plan", f.plan, "--state", f.state, "--execute", "--every", "1", "--rounds", "2"]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await p).toBe(0);
      expect(out()).toMatch(/--- round 1\/2 at .* ---/);
      expect(out()).toMatch(/--- round 2\/2 at .* ---/);
      expect(out().match(/RECEIPT/g)).toHaveLength(1); // round 2 finds the period paid and pays nothing
    } finally {
      vi.useRealTimers();
    }
  });
});
