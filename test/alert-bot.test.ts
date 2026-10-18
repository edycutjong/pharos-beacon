import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { consoleNotifier, discordNotifier, webhookUrl } from "../src/watch/discord.js";
import { main as monitorMain, parseFrom, formatEvent } from "../tasks/event-log-monitor/index.js";
import { main as botMain } from "../tasks/on-chain-alert-bot/index.js";
import { alertText, compileRules, match } from "../tasks/on-chain-alert-bot/rules.js";
import { decodeLog, parseEvent } from "../src/watch/decode.js";
import { depositLog, fakeChain, TOKEN, transferLog } from "./helpers/fake-logs.js";

const dir = () => mkdtempSync(join(tmpdir(), "alert-test-"));
const ctx = () => ({ onExit: () => {}, signal: new AbortController().signal });
const HOOK = "https://discord.com/api/webhooks/123456789/SECRET-token_abc";
const FILE = {
  network: "atlantic",
  rules: [
    { id: "big", kind: "large-transfer", token: TOKEN, minAmount: "0.005" },
    { id: "dep", kind: "contract-event", contract: TOKEN, event: "Deposit" },
  ],
};
const rulesOf = (f: unknown = FILE) => compileRules(f, () => 18).rules;
const E15 = 10n ** 15n;

describe("rules", () => {
  it("large-transfer fires at the threshold and above, not below; a deposit fires the event rule only", () => {
    const rules = rulesOf();
    expect(match(rules, transferLog(1, 0, 1, 5n * E15)).map((a) => a.rule.id)).toEqual(["big"]);
    expect(match(rules, transferLog(1, 0, 1, 5n * E15 - 1n))).toEqual([]);
    expect(match(rules, depositLog(1, 0, 1, 1n)).map((a) => a.rule.id)).toEqual(["dep"]);
  });
  it("an alert key is per rule and event, and names what, the value and an explorer link", () => {
    const [a] = match(rulesOf(), transferLog(77, 2, 9, 10n * E15));
    expect(a!.key).toMatch(/^big:0x0+9:2$/);
    const text = alertText(a!, "atlantic", 18, "WPHRS");
    expect(text).toContain("Large transfer");
    expect(text).toContain("0.01 WPHRS");
    expect(text).toContain("https://atlantic.pharosscan.xyz/tx/0x");
    expect(text).toContain("**Block:** 77");
  });
  it("involving narrows an event rule to one address", () => {
    const only = rulesOf({ network: "atlantic", rules: [{ id: "me", kind: "contract-event", contract: TOKEN, event: "Transfer", involving: "0x0000000000000000000000000000000000000001" }] });
    expect(match(only, transferLog(1, 0, 1, 1n))).toEqual([]);
  });
  it("rejects bad rules with a clear message", () => {
    const bad = (rules: unknown, re: RegExp, network: unknown = "atlantic") => expect(() => compileRules({ network, rules }, () => 18)).toThrow(re);
    bad([], /at least one rule/);
    bad([{ id: "a", kind: "nope" }], /kind must be/);
    bad([{ id: "a", kind: "large-transfer", token: "0x1", minAmount: "1" }], /token must be an address/);
    bad([{ id: "a", kind: "large-transfer", token: TOKEN, minAmount: "-1" }], /minAmount/);
    bad([{ id: "a", kind: "large-transfer", token: TOKEN, minAmount: "0" }], /above zero/);
    bad([{ id: "a", kind: "contract-event", contract: TOKEN, event: "Deposit" }, { id: "a", kind: "contract-event", contract: TOKEN, event: "Deposit" }], /duplicate/);
    bad([{ id: "a", kind: "contract-event", contract: TOKEN, event: "Deposit" }], /network/, "ethereum");
    expect(() => compileRules(FILE, () => undefined)).toThrow(/needs an ERC-20/);
  });
});

describe("discord", () => {
  const res = (status: number, body: unknown) => ({ status, ok: status < 300, json: async () => body }) as Response;
  it("validates the webhook shape without echoing it", () => {
    expect(webhookUrl(HOOK).hostname).toBe("discord.com");
    for (const bad of ["not a url", "http://discord.com/api/webhooks/1/x", "https://evil.example/api/webhooks/1/x", "https://discord.com/other"]) {
      try {
        webhookUrl(bad);
        throw new Error("accepted");
      } catch (e) {
        expect((e as Error).message).not.toContain("evil.example/api");
        expect((e as Error).message).toMatch(/webhook/);
      }
    }
  });
  it("posts with ?wait=true, no mentions, and returns the message id", async () => {
    const f = vi.fn(async () => res(200, { id: "555", timestamp: "2026-10-18T00:00:00Z", content: "hi" }));
    const d = await discordNotifier(webhookUrl(HOOK), { fetch: f as any }).send("hi @everyone");
    expect(d).toMatchObject({ id: "555" });
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get("wait")).toBe("true");
    expect(JSON.parse(init.body as string).allowed_mentions).toEqual({ parse: [] });
  });
  it("retries a 429 after retry_after, gives up on a 4xx, and never puts the URL in an error", async () => {
    const waits: number[] = [];
    const f = vi.fn().mockResolvedValueOnce(res(429, { retry_after: 1.2 })).mockResolvedValueOnce(res(200, { id: "1" }));
    expect((await discordNotifier(webhookUrl(HOOK), { fetch: f as any, sleep: async (ms) => void waits.push(ms) }).send("x")).id).toBe("1");
    expect(waits).toEqual([1200]);
    await expect(discordNotifier(webhookUrl(HOOK), { fetch: (async () => res(404, {})) as any }).send("x")).rejects.toThrow(/HTTP 404$/);
    const boom = new Error(`fetch failed for ${HOOK}`, { cause: { code: "ECONNRESET" } });
    await expect(discordNotifier(webhookUrl(HOOK), { fetch: (async () => { throw boom; }) as any, sleep: async () => {} }).send("x")).rejects.toThrow(/^Discord delivery failed: ECONNRESET$/);
  });
});

describe("event-log-monitor", () => {
  const conn = (call: any) => async () => ({ call, close: async () => {}, endpoint: "fake://mcp", network: "atlantic" as const, chainId: 688689, server: undefined }) as any;
  it("parses --from-block", () => {
    expect(parseFrom("head", 100n)).toBe("head");
    expect(parseFrom("42", 100n)).toBe(42n);
    expect(parseFrom("head-30", 100n)).toBe(70n);
    expect(() => parseFrom("soon", 1n)).toThrow(/--from-block/);
  });
  it("catches a live event once, and a restart prints nothing new", async () => {
    const chain = { head: 100, logs: [] as any[] };
    const state = join(dir(), "s.json");
    const log = join(dir(), "run.log");
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
    const argv = ["--contract", TOKEN, "--event", "Transfer", "--state", state, "--log", log, "--poll-ms", "200", "--max-polls", "3"];
    let n = 0;
    const call = fakeChain(chain);
    const live = (async (tool: string, a: any) => {
      if (tool === "get_block_number" && ++n === 3) {
        chain.head = 103;
        chain.logs.push(transferLog(102, 0, 7, 10n * E15));
      }
      return call(tool, a);
    }) as any;
    await monitorMain(ctx(), argv, conn(live), async () => {});
    const text = out.join("\n");
    expect(text).toContain("amount  0.01 WPHRS");
    expect(text).toContain("block 102");
    expect(text).toMatch(/1 new Transfer event;/);
    out.length = 0;
    await monitorMain(ctx(), argv, conn(call), async () => {});
    expect(out.join("\n")).toMatch(/0 new Transfer events;/);
    expect(out.join("\n")).not.toContain("amount");
    expect(readFileSync(log, "utf8")).toContain("block 102");
    spy.mockRestore();
  });
  it("formats from / to / amount / tx / block", () => {
    const e = decodeLog(parseEvent("Transfer"), transferLog(9, 1, 3, 10n * E15));
    const text = formatEvent(e, "atlantic", 18, "WPHRS");
    for (const w of ["from    ", "to      ", "amount  0.01 WPHRS", "tx      0x", "block 9", "pharosscan.xyz/tx/0x"]) expect(text).toContain(w);
  });
  it("rejects a missing contract and a bad poll interval", async () => {
    await expect(monitorMain(ctx(), ["--event", "Transfer"], conn(fakeChain({ head: 1, logs: [] })))).rejects.toThrow(/--contract/);
    await expect(monitorMain(ctx(), ["--contract", TOKEN, "--poll-ms", "5"], conn(fakeChain({ head: 1, logs: [] })))).rejects.toThrow(/--poll-ms/);
  });
});

describe("on-chain-alert-bot", () => {
  const conn = (call: any) => async () => ({ call, close: async () => {}, endpoint: "fake://mcp", network: "atlantic" as const, chainId: 688689, server: undefined }) as any;
  it("alerts once per event, skips below-threshold transfers, and a restart with a reset cursor does not repeat", async () => {
    const d = dir();
    const rules = join(d, "rules.json");
    writeFileSync(rules, JSON.stringify(FILE));
    const chain = { head: 50, logs: [transferLog(48, 0, 1, 10n * E15), transferLog(48, 1, 2, E15), depositLog(49, 0, 3, 20n * E15)] };
    const sentTexts: string[] = [];
    const notifier = { name: "fake", send: async (t: string) => (sentTexts.push(t), { id: String(sentTexts.length), timestamp: "t", content: t }) };
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
    const argv = ["--rules", rules, "--state", join(d, "c.json"), "--sent", join(d, "sent.json"), "--from-block", "40", "--max-polls", "2", "--poll-ms", "200"];
    await botMain(ctx(), argv, conn(fakeChain(chain)), () => notifier, async () => {});
    expect(sentTexts).toHaveLength(2); // the large transfer and the deposit; the 0.001 transfer is below 0.005
    expect(sentTexts[0]).toContain("Large transfer");
    expect(sentTexts[1]).toContain("Deposit event");
    expect(out.join("\n")).toMatch(/2 alerts sent, 0 already sent/);
    // restart on the same cursor: nothing scanned again
    await botMain(ctx(), argv, conn(fakeChain(chain)), () => notifier, async () => {});
    expect(sentTexts).toHaveLength(2);
    // cursor lost (state deleted) but the sent-set kept: the same events are seen again and not re-alerted
    await botMain(ctx(), argv.map((a) => (a === join(d, "c.json") ? join(d, "c2.json") : a)), conn(fakeChain(chain)), () => notifier, async () => {});
    expect(sentTexts).toHaveLength(2);
    expect(out.join("\n")).toMatch(/0 alerts sent, 2 already sent earlier \(not repeated\)/);
    expect(Object.keys(JSON.parse(readFileSync(join(d, "sent.json"), "utf8")))).toHaveLength(2);
    spy.mockRestore();
  });
  it("a failed delivery is retried on the next poll and the event is not lost", async () => {
    const d = dir();
    const rules = join(d, "rules.json");
    writeFileSync(rules, JSON.stringify(FILE));
    const chain = { head: 50, logs: [depositLog(49, 0, 3, 20n * E15)] };
    let fail = true;
    const sent: string[] = [];
    const notifier = { name: "fake", send: async (t: string) => { if (fail) { fail = false; throw new Error("Discord delivery failed: HTTP 500"); } sent.push(t); return { id: "1", timestamp: "t", content: t }; } };
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const argv = ["--rules", rules, "--state", join(d, "c.json"), "--sent", join(d, "sent.json"), "--from-block", "40", "--poll-ms", "200", "--max-polls", "1"];
    await expect(botMain(ctx(), argv, conn(fakeChain(chain)), () => notifier, async () => {})).rejects.toThrow(/HTTP 500/);
    await botMain(ctx(), argv, conn(fakeChain(chain)), () => notifier, async () => {});
    expect(sent).toHaveLength(1);
    spy.mockRestore();
  });
  it("--until-alerts stops once enough alerts went out; the console notifier prints", async () => {
    const d = dir();
    const rules = join(d, "rules.json");
    writeFileSync(rules, JSON.stringify(FILE));
    const chain = { head: 50, logs: [depositLog(49, 0, 3, 20n * E15)] };
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
    await botMain(ctx(), ["--rules", rules, "--notify", "console", "--state", join(d, "c.json"), "--sent", join(d, "s.json"), "--from-block", "40", "--until-alerts", "1", "--poll-ms", "200"], conn(fakeChain(chain)), undefined, async () => {});
    expect(out.join("\n")).toMatch(/stopped after 1 polls: 1 alert sent/);
    spy.mockRestore();
    const lines: string[] = [];
    await consoleNotifier((s) => lines.push(s)).send("x");
    expect(lines).toEqual(["x"]);
  });
  it("needs --rules and a readable file", async () => {
    await expect(botMain(ctx(), [], conn(fakeChain({ head: 1, logs: [] })))).rejects.toThrow(/--rules/);
    await expect(botMain(ctx(), ["--rules", "/nonexistent.json"], conn(fakeChain({ head: 1, logs: [] })))).rejects.toThrow(/cannot read the rules file/);
  });
});
