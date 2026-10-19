// The Alert Bot demo endpoint (tasks/on-chain-alert-bot/web.ts): rules input, the committed rules files, alerts and no repeats.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handle, MAX_RULES, pageNotifier, parseRun, RULES_ATLANTIC, RULES_PHAROS, run } from "../tasks/on-chain-alert-bot/web.js";
import { depositLog, fakeChain, TOKEN, transferLog } from "./helpers/fake-logs.js";

const u = (q: string) => new URL(`http://x/api/on-chain-alert-bot?${q}`);
const reader = (call: any) => async () => ({ network: "atlantic" as const, chainId: 688689, endpoint: "fake://rpc", via: "direct JSON-RPC" as const, call, close: async () => {} });
const file = (name: string) => JSON.parse(readFileSync(new URL(`../tasks/on-chain-alert-bot/${name}`, import.meta.url), "utf8"));

describe("on-chain-alert-bot web", () => {
  it("uses the committed rules files verbatim", () => {
    expect(RULES_PHAROS).toEqual(file("rules.pharos.json"));
    expect(RULES_ATLANTIC).toEqual(file("rules.atlantic.json"));
  });

  it("checks custom rules before any chain call", () => {
    const rules = (r: unknown) => u(`scenario=custom&rules=${encodeURIComponent(JSON.stringify(r))}`);
    expect(() => parseRun(u("scenario=custom&rules=%7Bnot"))).toThrow(/not valid JSON/);
    expect(() => parseRun(rules({ network: "base", rules: [{}] }))).toThrow(/network/);
    expect(() => parseRun(rules({ network: "pharos", rules: [] }))).toThrow(/at least one rule/);
    expect(() => parseRun(rules({ network: "pharos", rules: Array(MAX_RULES + 1).fill({}) }))).toThrow(/at most/);
    expect(() => parseRun(u(`scenario=custom&rules=${"x".repeat(2001)}`))).toThrow(/2000 characters/);
    expect(parseRun(u("scenario=atlantic-proof"))).toMatchObject({ from: 31555660n, pin: 31555690n });
  });

  it("answers 400 / 404 / health", async () => {
    expect((await handle(new Request("http://x/api?action=run&scenario=zzz"))).status).toBe(400);
    expect((await handle(new Request("http://x/api?action=nope"))).status).toBe(404);
    expect(await (await handle(new Request("http://x/api?action=health"))).json()).toMatchObject({ status: "ok", task: "on-chain-alert-bot" });
  });

  it("alerts above the threshold, then holds every alert back on a rescan with the cursor lost", async () => {
    const chain = { head: 50, logs: [depositLog(42, 0, 1, 10n ** 16n), transferLog(43, 0, 2, 10n ** 16n), transferLog(44, 0, 3, 10n ** 14n)] };
    const events: any[] = [];
    await run({ file: structuredClone(RULES_ATLANTIC) as any, from: 40n }, (e) => events.push(e), reader(fakeChain(chain)) as any);
    const alerts = events.filter((e) => e.type === "alert");
    expect(alerts.map((a) => a.rule)).toEqual(["wphrs-deposit", "big-wphrs-transfer"]); // 0.0001 < 0.005: no alert
    expect(alerts[1].text).toMatch(/\*\*Value:\*\* 0\.01 WPHRS/);
    expect(alerts[1].text).toContain("https://atlantic.pharosscan.xyz/tx/");
    expect(events.filter((e) => e.type === "skipped")).toHaveLength(2);
    expect(events.find((e) => e.type === "done")).toMatchObject({ alerts: 2, heldBack: 2, repeated: 0, newOnRescan: 0 });
    expect(events.filter((e) => e.type === "step").map((s) => s.id)).toEqual(["connect", "rules", "scan", "deliver", "rescan"]);
  });

  it("refuses a bad rule with the compiler's message", async () => {
    const events: any[] = [];
    const bad = { network: "atlantic", rules: [{ id: "x", kind: "large-transfer", token: TOKEN, minAmount: "lots" }] };
    await expect(run({ file: bad as any, from: 1n }, (e) => events.push(e), reader(fakeChain({ head: 5, logs: [] })) as any)).rejects.toThrow(/minAmount/);
    expect(events.at(-1)).toMatchObject({ type: "step", id: "rules", state: "failed" });
  });

  it("delivers to the page, never anywhere else", async () => {
    const seen: any[] = [];
    const d = await pageNotifier((e) => seen.push(e)).send("hi");
    expect(d.content).toBe("hi");
    expect(d.id).toBeUndefined();
    expect(seen[0].type).toBe("delivered");
  });
});
