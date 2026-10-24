import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { detectFormat, extractInvoice, findPaid, fingerprint, recordPaid, toDraft } from "../src/pay/invoice.js";
import { main as invMain } from "../tasks/invoice-to-payment-agent/index.js";

const FROM = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975" as Hex;
const TO = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B";
const ctx = { onExit() {}, signal: new AbortController().signal };

describe("invoices", () => {
  const json = (o: object) => JSON.stringify({ invoice_number: "A-1", issuer: "Acme", pay_to: TO, currency: "PHRS", total: "0.5", ...o });
  it("reads JSON, text and PDF-style text", async () => {
    const j = await extractInvoice(json({}), "json");
    expect(j).toMatchObject({ number: "A-1", issuer: "Acme", payee: TO, amount: "0.5", currency: "PHRS", flags: [] });
    const t = await extractInvoice(`INVOICE #NV-17\nFrom: Nova\nPay to: ${TO}\nTotal due: 0.001 WPHRS\n`, "text");
    expect(t).toMatchObject({ number: "NV-17", issuer: "Nova", payee: TO, amount: "0.001", currency: "WPHRS", flags: [] });
    const id = await extractInvoice(`Nomor Faktur: BM/2026/10/088\nDari: CV Bumi\nBayar ke: ${TO}\nTotal tagihan: 0,002 PHRS`, "pdf");
    expect(id).toMatchObject({ number: "BM/2026/10/088", amount: "0.002", currency: "PHRS", flags: [] });
    expect(detectFormat("x.pdf", "")).toBe("pdf");
    expect(detectFormat("x.txt", " {}")).toBe("json");
  });
  it("flags instead of guessing", async () => {
    expect(toDraft(await extractInvoice(json({ invoice_number: undefined }), "json")).flags.join()).toMatch(/missing field: invoice number/);
    expect(toDraft(await extractInvoice(json({ line_items: [{ amount: 0.1 }, { amount: 0.1 }] }), "json")).flags.join()).toMatch(/add up to 0\.2/);
    expect(toDraft(await extractInvoice(`INVOICE #Q-9\nPay to: ${TO}\nSubtotal: 20 USDC\nTotal due: 25 USDC`, "text")).flags.join()).toMatch(/different totals/);
    expect(toDraft(await extractInvoice(`INVOICE #Q-9\nPay to: ${TO}\nTotal due: 1.000 USDC`, "text")).flags.join()).toMatch(/ambiguous/);
    expect(toDraft(await extractInvoice(`INVOICE #Q-9\nPay to: ${TO}\nPay to: ${FROM}\nTotal due: 5 USDC`, "text")).flags.join()).toMatch(/2 different payee addresses/);
    expect(toDraft(await extractInvoice("{not json", "json")).flags.join()).toMatch(/does not parse/);
  });
  it("USD is settled only when the human says --pay-in", async () => {
    const x = await extractInvoice(json({ currency: "USD" }), "json");
    expect(toDraft(x).draft).toBeUndefined();
    expect(toDraft(x).flags.join()).toMatch(/--pay-in/);
    const ok = toDraft(x, "usdc");
    expect(ok.draft).toMatchObject({ token: "USDC", reference: "A-1" });
    expect(ok.notes.join()).toMatch(/1:1/);
  });
  it("only fills a gap from the LLM with a value the document contains", async () => {
    const text = `Invoice 77\nPay to: ${TO}\nPlease remit 0.5 PHRS`;
    const llm = async () => ({ json: { number: "77", payee: null, amount: "0.5", currency: "PHRS" }, model: "fake" });
    expect(await extractInvoice(text, "text", llm)).toMatchObject({ amount: "0.5", currency: "PHRS" });
    const liar = async () => ({ json: { amount: "999", currency: "EUR" }, model: "fake" });
    const l = await extractInvoice(text, "text", liar);
    expect([l.amount, l.currency]).toEqual([undefined, undefined]);
  });
  it("fingerprints and remembers paid invoices", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-"));
    const file = join(dir, "paid.json");
    const x = { number: "A-1", issuer: "Acme  Corp", amount: "0.5", currency: "PHRS" };
    expect(fingerprint(x)).toBe(fingerprint({ ...x, issuer: "acme corp" }));
    expect(fingerprint(x)).not.toBe(fingerprint({ ...x, amount: "0.6" }));
    writeFileSync(file, "");
    expect(findPaid(file, fingerprint(x))).toBeUndefined(); // an empty (mktemp) file is an empty ledger
    recordPaid(file, { fingerprint: fingerprint(x), number: "A-1", amount: "0.5", token: "PHRS", hash: "0xabc" as Hex, url: "u", at: "now" });
    expect(findPaid(file, fingerprint(x))?.hash).toBe("0xabc");
  });
});

describe("Invoice CLI (no chain needed for these paths)", () => {
  afterEach(() => vi.restoreAllMocks());
  const run = async (fn: () => Promise<number>) => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    const code = await fn();
    return { code, out: out.join("\n") };
  };
  it("Invoice: flags a bad invoice (exit 1) before touching the chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-"));
    const f = join(dir, "i.json");
    writeFileSync(f, JSON.stringify({ issuer: "X", pay_to: TO, currency: "PHRS", total: "1" }));
    const r = await run(() => invMain(ctx, [f, "--parser", "rules", "--state", join(dir, "s.json")]));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FLAGGED/);
  });
  it("Invoice: refuses a duplicate with the first tx hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-"));
    const f = join(dir, "i.json"), state = join(dir, "s.json");
    writeFileSync(f, JSON.stringify({ invoice_number: "D-1", issuer: "Dup Co", pay_to: TO, currency: "PHRS", total: "0.5" }));
    recordPaid(state, { fingerprint: fingerprint({ number: "D-1", issuer: "Dup Co", amount: "0.5", currency: "PHRS" }), number: "D-1", amount: "0.5", token: "PHRS", hash: "0xfeed" as Hex, url: "https://x/tx/0xfeed", at: "t" });
    const r = await run(() => invMain(ctx, [f, "--parser", "rules", "--state", state]));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/DUPLICATE.*0xfeed/s);
    expect(readFileSync(state, "utf8")).toMatch(/0xfeed/);
  });
});
