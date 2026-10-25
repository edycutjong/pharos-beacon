// The six wave 3 demo endpoints (tasks/<task>/web.ts), run against fakes: no network, no key.
import { describe, expect, it } from "vitest";
import { handle as skill, parseRun as skillParse } from "../tasks/skill-chain-mcp-flow/web.js";
import { handle as audit } from "../tasks/audit-log-agent/web.js";
import { handle as weekly } from "../tasks/weekly-digest-agent/web.js";
import { handle as nl, parseRun as nlParse } from "../tasks/natural-language-payment-agent/web.js";
import { handle as invoice, parseRun as invoiceParse } from "../tasks/invoice-to-payment-agent/web.js";
import { handle as buyer } from "../tasks/x402-agent-buyer/web.js";
import { parseWindow } from "../src/web/activity-live.js";
import { fakeWorld, W, world } from "./helpers/fake-activity.js";
import { events, req } from "./web-helpers.js";

const H = `0x${"ab".repeat(32)}`;
const YOU = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B";
const done = async (res: Response) => (await events(res)).at(-1)!;

describe("skill-chain-mcp-flow web", () => {
  const conn = (tx: unknown, receipt: unknown, head = 100) => ({
    connect: async () => ({ endpoint: "fake", close: async () => {}, call: (async (t: string, a: any) => {
      if (t === "get_transaction") return tx;
      if (t === "get_transaction_receipt") return receipt;
      if (t === "get_block_number") return { blockNumber: String(head) };
      if (t === "get_block") return { timestamp: `0x${(1_700_000_000 + Number(a.block)).toString(16)}`, transactions: [] };
      throw new Error(`unexpected ${t}`);
    }) as never }),
  });
  it("validates the query", () => {
    expect(() => skillParse(new URL("http://x/"))).toThrow(/hash/);
    expect(() => skillParse(new URL(`http://x/?hash=${H}&latest=1`))).toThrow(/not both/);
    expect(() => skillParse(new URL("http://x/?hash=0x12"))).toThrow(/transaction hash/);
    expect(() => skillParse(new URL(`http://x/?hash=${H}&expectTo=0x1`))).toThrow(/expectTo/);
    expect(skillParse(new URL(`http://x/?hash=${H}&minValue=0.5`))).toMatchObject({ hash: H, minValue: "0.5" });
  });
  it("NOT_FOUND ends after two calls and says no", async () => {
    const d = await done(await skill(req(`action=run&hash=${H}`), conn(null, null)));
    expect(d.view).toMatchObject({ tone: "bad", verdict: "NOT_FOUND" });
    expect(d.view.evidence[0][1]).toBe("get_transaction → get_block_number");
  });
  it("SETTLED when mined deep enough, WAIT when not", async () => {
    const tx = { hash: H, from: YOU, to: YOU, value: "0x0" };
    const rc = { blockNumber: "0x5", status: "0x1", gasUsed: "0x5208", logs: [] };
    expect((await done(await skill(req(`action=run&hash=${H}`), conn(tx, rc, 100)))).view.verdict).toBe("SETTLED");
    const wait = await done(await skill(req(`action=run&hash=${H}`), conn(tx, rc, 5)));
    expect(wait.view).toMatchObject({ tone: "warn", verdict: "WAIT" });
  });
  it("MISMATCH when the expected recipient differs; a bad request is a 400", async () => {
    const tx = { hash: H, from: YOU, to: YOU, value: "0x0" };
    const rc = { blockNumber: "0x5", status: "0x1", gasUsed: "0x5208", logs: [] };
    expect((await done(await skill(req(`action=run&hash=${H}&expectTo=0x000000000000000000000000000000000000dEaD`), conn(tx, rc)))).view.verdict).toBe("MISMATCH");
    expect((await skill(req("action=run"))).status).toBe(400);
    expect((await skill(req("action=info"))).status).toBe(200);
  });
});

describe("audit-log-agent and weekly-digest-agent web", () => {
  const deps = { connect: async () => ({ endpoint: "fake", close: async () => {}, call: fakeWorld(world(), 400) as never }) };
  it("validates wallet, network, window and toBlock", () => {
    expect(parseWindow(new URL(`http://x/?wallet=${W}&blocks=30000&toBlock=123`))).toMatchObject({ wallet: W, network: "pharos", blocks: 30000, toBlock: 123n });
    expect(() => parseWindow(new URL("http://x/?wallet=0x12"))).toThrow(/wallet/);
    expect(() => parseWindow(new URL(`http://x/?wallet=${W}&network=sepolia`))).toThrow(/network/);
    expect(() => parseWindow(new URL(`http://x/?wallet=${W}&blocks=7`))).toThrow(/blocks/);
    expect(() => parseWindow(new URL(`http://x/?wallet=${W}&toBlock=abc`))).toThrow(/toBlock/);
  });
  it("audit: categories, notable transactions and the full Markdown report", async () => {
    const d = await done(await audit(req(`action=run&wallet=${W}&network=atlantic&blocks=1000`), deps));
    expect(d.type).toBe("done");
    expect(d.view.tables[0].head).toEqual(["Category", "Items"]);
    expect(d.view.tables[0].rows.map((r: string[]) => r[0])).toEqual(["transfer-in", "transfer-out", "swap", "approval", "contract-call"]);
    expect(d.view.text).toContain("# Wallet activity report");
    expect(d.view.download).toMatchObject({ name: expect.stringMatching(/^audit-0x317bca-\d+-\d+\.md$/), text: d.view.text });
    expect(d.view.evidence.find((e: string[]) => e[0] === "Wallet")[1]).toBe(W);
  });
  it("audit: a pinned toBlock ends the window there", async () => {
    const d = await done(await audit(req(`action=run&wallet=${W}&network=atlantic&blocks=1000&toBlock=250`), deps));
    expect(d.view.evidence.find((e: string[]) => e[0] === "Window")[1]).toContain("block 250 (a pinned sample)");
  });
  it("weekly: this period against the one before, three highlights at most", async () => {
    const long = { connect: async () => ({ endpoint: "fake", close: async () => {}, call: fakeWorld(world(), 3000) as never }) };
    const d = await done(await weekly(req(`action=run&wallet=${W}&network=atlantic&blocks=1000&toBlock=2000`), long));
    expect(d.type).toBe("done");
    expect(d.view.evidence.find((e: string[]) => e[0] === "Previous")[1]).toBe("blocks 1–1000");
    expect(d.view.tables[0].head).toEqual(["Metric", "This period", "Previous", "Change"]);
    expect(d.view.tables[1].rows.length).toBeLessThanOrEqual(3);
    expect(d.view.evidence.some((e: string[]) => e[0] === "Schedule (CLI)")).toBe(true);
  });
  it("weekly: a chain too short for two windows is an error line, not a half digest", async () => {
    const d = await done(await weekly(req(`action=run&wallet=${W}&network=atlantic&blocks=1000`), deps));
    expect(d).toMatchObject({ type: "error" });
    expect(d.message).toContain("not enough for two windows");
  });
});

describe("pay web endpoints never sign", () => {
  const call = (async (t: string) => {
    if (t === "get_balance") return { balanceWei: "10000000000000000000" };
    if (t === "get_transaction_count") return { nonce: "7" };
    if (t === "estimate_gas") return { gas: "21000" };
    if (t === "get_block") return { baseFeePerGas: "0x3b9aca00" };
    if (t === "get_gas_price") return { maxPriorityFeePerGasWei: "1000000000" };
    throw new Error(`unexpected ${t}`);
  }) as never;
  it("NL: a complete instruction is prepared, unsigned, with the sign lamp skipped", async () => {
    const evs = await events(await nl(req(`action=run&text=${encodeURIComponent(`send 0.0001 PHRS to ${YOU}`)}`), { call }));
    const d = evs.at(-1)!;
    expect(d.view).toMatchObject({ tone: "ok", verdict: "PREPARED, NOT SIGNED" });
    expect(d.view.note).toContain("NOT SIGNED");
    expect(evs.find((e) => e.id === "sign" && e.state === "skip")).toBeTruthy();
    expect(d.view.text).toContain("eth_sendTransaction");
    expect(JSON.stringify(evs)).not.toMatch(/privateKey|signature/i);
  });
  it("NL: a missing token asks a question and prepares nothing; the follow-up completes it", async () => {
    const q = `text=${encodeURIComponent(`pay 0.0001 to ${YOU}`)}`;
    const askedEvents = await events(await nl(req(`action=run&${q}`), { call }));
    expect(askedEvents.find((e) => e.id === "sign" && e.state === "skip")).toBeTruthy();
    const asked = askedEvents.at(-1)!;
    expect(asked.view.verdict).toBe("NEEDS ONE MORE THING");
    expect(asked.view.tables[0].rows.length).toBe(1);
    expect((await done(await nl(req(`action=run&${q}&followup=PHRS`), { call }))).view.verdict).toBe("PREPARED, NOT SIGNED");
  });
  it("NL: query limits", () => {
    expect(() => nlParse(new URL("http://x/"))).toThrow(/text is required/);
    expect(() => nlParse(new URL(`http://x/?text=${"a".repeat(301)}`))).toThrow(/300/);
    expect(() => nlParse(new URL("http://x/?text=send&from=0x12"))).toThrow(/from/);
  });
  it("Invoice: flags a currency it cannot settle, prepares a clean invoice", async () => {
    const post = (text: string) => new Request("http://x/api/i?action=run", { method: "POST", body: JSON.stringify({ text }) });
    const usd = await done(await invoice(post(JSON.stringify({ invoice_number: "US-1", issuer: "Hudson", pay_to: YOU, currency: "USD", total: "120.00" })), { call }));
    expect(usd.view).toMatchObject({ tone: "bad", verdict: "FLAGGED: needs a human" });
    const ok = await done(await invoice(post(JSON.stringify({ invoice_number: "INV-1", issuer: "Acme", pay_to: YOU, currency: "PHRS", total: "0.005" })), { call }));
    expect(ok.view).toMatchObject({ tone: "ok", verdict: "PREPARED, NOT SIGNED" });
    expect(ok.view.evidence.find((e: string[]) => e[0] === "Number")[1]).toBe("INV-1");
  });
  it("Invoice: body limits", async () => {
    await expect(invoiceParse(new Request("http://x/?action=run", { method: "POST", body: "nope" }))).rejects.toThrow(/JSON/);
    await expect(invoiceParse(new Request("http://x/?action=run", { method: "POST", body: JSON.stringify({ text: "a".repeat(4001) }) }))).rejects.toThrow(/4,000/);
    await expect(invoiceParse(new Request("http://x/?action=run", { method: "POST", body: JSON.stringify({ text: "x", payIn: "EUR" }) }))).rejects.toThrow(/payIn/);
  });
});

describe("x402-agent-buyer web plan", () => {
  const price = (path: string) => (path.startsWith("gas") ? 1000n : path.startsWith("whale-brief") ? 10000n : 5000n * BigInt(Math.ceil(Number(new URLSearchParams(path.split("?")[1]).get("blocks")) / 1000)));
  const ask = async (path: string) => ({ amount: price(path), asset: "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B", network: "eip155:688689" });
  it("the budget task stops at the answer that would go over the budget, and pays nothing", async () => {
    const d = await done(await buyer(req("action=run&task=budget"), { ask }));
    expect(d.view.verdict).toContain('STOPS at "history"');
    expect(d.view.tone).toBe("warn");
    expect(d.view.note).toContain("Nothing was signed or paid");
  });
  it("the cap task refuses the dear answer and still buys the cheap ones", async () => {
    const d = await done(await buyer(req("action=run&task=cap"), { ask }));
    expect(d.view.tables[0].rows.map((r: string[]) => r[3])).toEqual(["WOULD BUY", "REFUSED", "WOULD BUY"]);
  });
  it("finish: a repeated gas question is redundant, a second whale route is checked first", async () => {
    const d = await done(await buyer(req("action=run&task=finish"), { ask }));
    const dec = Object.fromEntries(d.view.tables[0].rows.map((r: string[]) => [r[0], r[3]]));
    expect(dec["gas-again"]).toBe("REFUSED");
    expect(dec["whales-1k"]).toBe("CHECK FIRST");
    expect(d.view.verdict).toMatch(/^PLAN COMPLETES/);
  });
  it("a bad task is a 400", async () => {
    expect((await buyer(req("action=run&task=partner"))).status).toBe(400);
  });
});
