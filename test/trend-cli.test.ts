import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/lib/cli.js";
import { main } from "../tasks/trend-watcher/index.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const h = vi.hoisted(() => ({ script: [] as { block: number; balance: number }[], network: "" as string, closed: 0, sent: [] as string[], i: -1 }));

vi.mock("../src/lib/mcp.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/mcp.js")>()),
  chainMcp: vi.fn(async (network: string) => {
    h.network = network;
    return {
      endpoint: "fake", network, chainId: 1, close: async () => void h.closed++,
      call: async (name: string, args?: { block?: string }) => {
        if (name === "get_block_number") return { blockNumber: String(h.script[Math.min(++h.i, h.script.length - 1)]!.block) };
        if (name === "get_balance") {
          const row = h.script.find((r) => String(r.block) === args?.block);
          if (!row) throw new Error(`no scripted balance at block ${args?.block}`);
          return { balanceWei: String(row.balance) };
        }
        if (name === "get_block") return { timestamp: "1700000000" };
        throw new Error(`unexpected ${name}`);
      },
    };
  }),
}));
vi.mock("../src/watch/discord.js", async (orig) => ({
  ...(await orig<typeof import("../src/watch/discord.js")>()),
  loadWebhook: () => new URL("https://discord.com/api/webhooks/1/x"),
  discordNotifier: () => ({ name: "discord", send: async (b: string) => (h.sent.push(b), { id: "d7", timestamp: "t" }) }),
}));

let logs: string[] = [];
const dirs: string[] = [];
const state = () => (dirs.push(mkdtempSync(join(tmpdir(), "trend-cli-"))), join(dirs.at(-1)!, "history.json"));
const ctx = () => ({ onExit: () => {}, signal: new AbortController().signal });
const out = () => logs.join("\n");
const observe = (file: string, extra: string[] = []) => main(ctx(), ["observe", "--address", WALLET, "--state", file, ...extra]);

beforeEach(() => {
  logs = [];
  h.script = [];
  h.i = -1;
  h.closed = 0;
  h.sent = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => void logs.push(String(s)));
});
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => rmSync(join(d), { recursive: true, force: true }));
});

describe("trend-watcher CLI: input checks", () => {
  const bad = (argv: string[], re: RegExp) => expect(main(ctx(), argv)).rejects.toThrow(re);
  it("rejects unknown commands and bad numbers", async () => {
    await bad(["watch"], /unknown command watch: use observe or history/);
    await bad(["observe", "--steps", "1"], /--steps must be a whole number ≥ 2/);
    await bad(["observe", "--steps", "2.5"], /--steps must be a whole number/);
    await bad(["observe", "--last", "0"], /--last must be a whole number ≥ 1/);
    await bad(["observe", "--block", "latest"], /--block must be a block number/);
    await bad(["observe", "--network", "mars"], /--network must be one of/);
    await bad(["observe", "--direction", "sideways"], /--direction must be one of fall, rise/);
  });
  it("turns a metric error into a usage error", async () => {
    await expect(main(ctx(), ["observe", "--metric", "balance"])).rejects.toBeInstanceOf(UsageError);
    await expect(main(ctx(), ["observe", "--metric", "nonsense", "--address", WALLET])).rejects.toBeInstanceOf(UsageError);
  });
});

describe("trend-watcher CLI: history", () => {
  it("prints an empty history without touching the chain", async () => {
    expect(await main(ctx(), ["history", "--address", WALLET, "--state", state()])).toBe(0);
    expect(out()).toBe("no observations yet");
    expect(h.network).toBe("");
  });
});

describe("trend-watcher CLI: observe", () => {
  it("stores one observation per run and acts only when the third fall in a row lands", async () => {
    const file = state();
    h.script = [100, 90, 80, 70].map((balance, i) => ({ block: 1000 + i * 10, balance }));
    await observe(file);
    expect(out()).toMatch(/observed .* at block 1000 — stored/);
    expect(out()).toMatch(/no action: only 1 of the 4 observations a 3-move trend needs/);
    for (let k = 0; k < 2; k++) await observe(file);
    expect(out()).not.toMatch(/acted/);
    logs = [];
    await observe(file);
    expect(out()).toMatch(/ACTION \[console\] /);
    expect(out()).toMatch(/acted 1× \(the trend was met\)/);
    expect(JSON.parse(readFileSync(file, "utf8")).observations).toHaveLength(4);
    expect(h.closed).toBe(0); // onExit is the runner's job: the stub context ignores it
  });

  it("a pinned block already in the history is de-duplicated, not stored twice", async () => {
    const file = state();
    h.script = [{ block: 500, balance: 10 }];
    await observe(file, ["--block", "500"]);
    logs = [];
    await observe(file, ["--block", "500"]);
    expect(out()).toMatch(/NOT stored: block already in the history \(de-duplicated\)/);
    expect(JSON.parse(readFileSync(file, "utf8")).observations).toHaveLength(1);
  });

  it("refuses to store an observation older than the newest one", async () => {
    const file = state();
    h.script = [{ block: 500, balance: 10 }, { block: 400, balance: 20 }];
    await observe(file, ["--block", "500"]);
    logs = [];
    await observe(file, ["--block", "400"]);
    expect(out()).toMatch(/NOT stored: older than the newest stored block/);
  });

  it("sends the action to Discord with --discord and reports a rising rule on the chosen network", async () => {
    const file = state();
    h.script = [10, 20, 30].map((balance, i) => ({ block: 100 + i, balance }));
    for (let k = 0; k < 3; k++) await observe(file, ["--direction", "rise", "--steps", "2", "--discord", "--network", "pharos"]);
    expect(h.network).toBe("pharos");
    expect(h.sent).toHaveLength(1);
    expect(out()).toMatch(/ACTION \[discord\] message d7: /);
    logs = [];
    h.i = 1; // same newest block again → de-duplicated, trend already acted on
    await observe(file, ["--direction", "rise", "--steps", "2", "--block", "102", "--discord", "--network", "pharos"]);
    expect(out()).toMatch(/no action: the trend was already acted on/);
  });

  it("refuses a history file that belongs to another network", async () => {
    const file = state();
    h.script = [{ block: 1, balance: 1 }];
    await observe(file);
    await expect(observe(file, ["--network", "pharos"])).rejects.toThrow(/holds history of a different metric .* use another --state file/);
  });

  it("reports a streak when the trend is building but not met", async () => {
    const file = state();
    h.script = [20, 30, 25].map((balance, i) => ({ block: 100 + i, balance }));
    for (let k = 0; k < 3; k++) await observe(file, ["--steps", "2"]);
    expect(out()).toMatch(/no action: streak 1 of 2/);
  });
});
