// Invoice (JSON, plain text or PDF text) → payee, amount, currency, reference, with every gap or disagreement FLAGGED, never
// guessed. The result feeds the same preparer as the Natural-Language Payment Agent (src/pay/prepare.ts). A duplicate guard
// keeps one invoice from being paid twice.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";
import type { LlmJson } from "./llm.js";
import { SYMBOLS, parseAmount, type Draft } from "./parse.js";

export type Format = "json" | "text" | "pdf";
export interface Extracted {
  format: Format;
  number?: string;
  issuer?: string;
  payee?: string;
  amount?: string;
  currency?: string;
  /** Problems that stop the payment from being prepared. */
  flags: string[];
  /** Things worth saying that do not stop it (an assumption the user chose with --pay-in). */
  notes: string[];
  via: string;
}

const NUM = "(\\d[\\d.,]*\\d|\\d)";
const AMOUNT_LABEL = new RegExp(`(?<![A-Za-z]|sub[\\s-])(?:grand\\s+total|total\\s+due|amount\\s+due|balance\\s+due|total\\s+tagihan|jumlah\\s+tagihan|total|amount|jumlah)\\s*[:\\-]?\\s*(?:[$]\\s*)?${NUM}\\s*([A-Za-z$]{1,6})?`, "gi");

export function detectFormat(path: string, text: string): Format {
  if (/\.pdf$/i.test(path)) return "pdf";
  return /^\s*[{[]/.test(text) ? "json" : "text";
}

export function pdfToText(path: string): string {
  try {
    return execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8", maxBuffer: 4_000_000 });
  } catch (e) {
    throw new Error(`could not read the PDF with pdftotext (${(e as Error).message.split("\n")[0]}): is poppler installed?`);
  }
}

/** The value under the first alias that is present; `conflicts` collects other aliases that hold a different value. */
const pick = (o: Record<string, unknown>, keys: string[], conflicts?: string[]): string | undefined => {
  const found: string[] = [];
  for (const k of keys) for (const [ok, v] of Object.entries(o)) if (ok.toLowerCase().replace(/[\s_-]/g, "") === k && (typeof v === "string" || typeof v === "number") && String(v).trim()) found.push(String(v).trim());
  if (conflicts && new Set(found.map((v) => v.toLowerCase())).size > 1) conflicts.push(`the fields disagree: ${[...new Set(found)].join(" vs ")}`);
  return found[0];
};

function amountFrom(raw: string, label: string, flags: string[]): string | undefined {
  const a = parseAmount(raw);
  if (!a) return void flags.push(`${label} "${raw}" is not a readable number`);
  if ("ask" in a) return void flags.push(`${label} "${raw}" is ambiguous (one thousand, or one point zero?): the invoice must be re-issued or confirmed`);
  return a.value;
}

function fromJson(text: string): Extracted {
  const flags: string[] = [];
  let o: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    o = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
    if (!o || typeof o !== "object") throw new Error("not an object");
  } catch (e) {
    return { format: "json", flags: [`the JSON does not parse: ${(e as Error).message}`], notes: [], via: "json" };
  }
  if (Array.isArray(JSON.parse(text)) && JSON.parse(text).length > 1) flags.push("the file holds several invoices: pay them one file at a time");
  const x: Extracted = { format: "json", flags, notes: [], via: "json fields" };
  x.number = pick(o, ["invoicenumber", "invoiceno", "invoiceid", "number", "id", "reference", "ref"], flags);
  x.issuer = pick(o, ["issuer", "vendor", "supplier", "from", "billedby", "seller"]);
  x.payee = pick(o, ["payee", "payto", "wallet", "walletaddress", "address", "recipient"], flags);
  x.currency = pick(o, ["currency", "token", "asset"], flags)?.toUpperCase();
  const total = pick(o, ["total", "amountdue", "amount", "totaldue", "balancedue"], flags);
  if (total) x.amount = amountFrom(total, "the total", flags);
  const items = (o.line_items ?? o.items ?? o.lineItems) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(items) && items.length && x.amount !== undefined) {
    const sum = items.reduce((s, it) => s + Number(it.amount ?? Number(it.qty ?? it.quantity ?? 1) * Number(it.unit_price ?? it.price ?? Number.NaN)), 0);
    if (!Number.isFinite(sum)) flags.push("a line item has no readable amount, so the total cannot be checked");
    else if (Math.abs(sum - Number(x.amount)) > 1e-9) flags.push(`the line items add up to ${sum} but the invoice total says ${x.amount}`);
  }
  return x;
}

const LABELLED = (re: string) => new RegExp(`^\\s*(?:${re})\\s*[:#]\\s*(.+?)\\s*$`, "im");

function fromText(text: string, format: Format): Extracted {
  const flags: string[] = [];
  const x: Extracted = { format, flags, notes: [], via: "labelled lines" };
  const num = text.match(/invoice\s*(?:no\.?|number|#|id)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-_/]*\d[A-Za-z0-9\-_/]*)/i) ?? text.match(LABELLED("reference|ref|nomor faktur|no\\.? faktur"));
  x.number = num?.[1];
  x.issuer = text.match(LABELLED("from|issuer|vendor|supplier|billed by|seller|dari|penerbit"))?.[1];
  const addrs = [...new Set(text.match(/0x[0-9a-fA-F]{20,}/g) ?? [])];
  if (addrs.length > 1) flags.push(`the invoice names ${addrs.length} different payee addresses (${addrs.map((a) => `${a.slice(0, 8)}…`).join(", ")}): which one is right?`);
  x.payee = text.match(LABELLED("pay\\s*to|payee|wallet(?: address)?|send to|bayar ke"))?.[1]?.match(/0x\S+/)?.[0] ?? addrs[0];
  const found = [...text.matchAll(AMOUNT_LABEL)];
  const vals = new Map<string, string>();
  for (const m of found) {
    const v = amountFrom(m[1], "the amount", flags);
    if (v !== undefined) vals.set(v, (m[2] ?? "").toUpperCase());
  }
  const distinct = [...vals.keys()];
  if (distinct.length > 1) flags.push(`the invoice states different totals (${distinct.join(" vs ")}): refusing to pick one`);
  else if (distinct.length === 1) x.amount = distinct[0];
  const labelled = text.match(LABELLED("currency|token|asset|mata uang"))?.[1]?.trim().toUpperCase();
  const suffix = vals.get(distinct[0] ?? "")?.trim().toUpperCase();
  if (labelled && suffix && labelled !== suffix) flags.push(`the invoice says ${labelled} in its currency line but ${suffix} next to the amount: which one is right?`);
  const cur = labelled ?? suffix;
  if (cur) x.currency = cur;
  return x;
}

const SYSTEM = `You read ONE invoice or payment request (any layout, English or Bahasa Indonesia) and reply with JSON only:
{"number": string|null, "issuer": string|null, "payee": string|null, "amount": string|null, "currency": string|null}
payee is the wallet address to pay, copied exactly. amount is the total due as a plain decimal string. number is the invoice number or reference.
Use null for anything not clearly stated. Never invent a value.`;

/** Rules first; the LLM only fills gaps, and a value it returns must appear in the document. */
export async function extractInvoice(text: string, format: Format, llm?: LlmJson): Promise<Extracted> {
  const x = format === "json" ? fromJson(text) : fromText(text, format);
  const gaps = (["number", "payee", "amount", "currency"] as const).filter((k) => !x[k]);
  if (llm && format !== "json" && gaps.length && !x.flags.length) {
    try {
      const { json, model } = await llm(SYSTEM, text.slice(0, 12_000));
      const j = (json ?? {}) as Record<string, unknown>;
      for (const k of gaps) {
        const v = typeof j[k] === "string" ? (j[k] as string).trim() : typeof j[k] === "number" ? String(j[k]) : "";
        if (!v || !text.toLowerCase().includes(v.toLowerCase().replace(/^0+(?=\d)/, ""))) continue;
        // an amount must stand alone in the text ("10" is not found inside "100.00")
        if (k === "amount" && !new RegExp(`(?<![\\d.,])${v.replace(/\./g, "\\.")}(?![\\d.,]*\\d)`).test(text)) continue;
        if (k === "amount") x.amount = amountFrom(v, "the amount", x.flags);
        else x[k] = k === "currency" ? v.toUpperCase() : v;
      }
      x.via = `labelled lines + ${model}`;
    } catch {
      x.notes.push("LLM unavailable: only the labelled lines were read");
    }
  }
  return x;
}

/** Extracted fields → a payment draft, or the reasons there is none. `payIn` is the human's choice for a non-token currency. */
export function toDraft(x: Extracted, payIn?: string): { draft?: Draft; flags: string[]; notes: string[] } {
  const flags = [...x.flags], notes = [...x.notes];
  for (const [k, label] of [["number", "invoice number / reference"], ["payee", "payee address"], ["amount", "amount"], ["currency", "currency"]] as const) {
    if (!x[k] && !flags.some((f) => f.includes(label) || (k === "amount" && /total|amount/.test(f)))) flags.push(`missing field: ${label}`);
  }
  let token = x.currency;
  if (token && !SYMBOLS.includes(token as never)) {
    if (payIn && SYMBOLS.includes(payIn.toUpperCase() as never)) {
      notes.push(`the invoice is in ${token}; paid as ${payIn.toUpperCase()} at 1:1 because --pay-in ${payIn.toUpperCase()} was given (an assumption, not a price)`);
      token = payIn.toUpperCase();
    } else flags.push(`currency ${token} is not a token on Atlantic (${SYMBOLS.join(", ")}): pass --pay-in <token> to settle it, I will not guess a rate`);
  }
  if (flags.length) return { flags, notes };
  return { draft: { amount: x.amount, token, recipient: x.payee, reference: x.number }, flags, notes };
}

// Duplicate guard: invoice number + issuer + amount + currency → one fingerprint, remembered with the tx that paid it.
export const fingerprint = (x: Pick<Extracted, "number" | "issuer" | "amount" | "currency">) =>
  createHash("sha256")
    .update([(x.number ?? "").trim().toLowerCase(), (x.issuer ?? "").trim().toLowerCase().replace(/\s+/g, " "), x.amount ? String(Number(x.amount)) : "", (x.currency ?? "").toUpperCase()].join("|"))
    .digest("hex").slice(0, 16);

export interface PaidRecord { fingerprint: string; number: string; issuer?: string; amount: string; token: string; hash: Hex; url: string; at: string }

export function loadPaid(file: string): PaidRecord[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8").trim();
  return text ? (JSON.parse(text) as PaidRecord[]) : [];
}
export function findPaid(file: string, fp: string): PaidRecord | undefined {
  return loadPaid(file).find((r) => r.fingerprint === fp);
}
export function recordPaid(file: string, rec: PaidRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify([...loadPaid(file), rec], null, 2)}\n`);
  renameSync(tmp, file);
}
