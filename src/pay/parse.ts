// Free text → a payment draft (amount, token, recipient[, reference]) or follow-up questions. English and Bahasa Indonesia.
// Two parsers share one contract: the deterministic rules below, and an LLM that only EXTRACTS. Whatever the LLM says is
// cross-checked against the user's own words before it counts (its recipient must appear in the text, its amount must
// agree with the rules' reading, an ambiguous number stays ambiguous): the model proposes, code disposes.
import { TOKENS } from "../lib/networks.js";
import type { LlmJson } from "./llm.js";

export const SYMBOLS = ["PHRS", ...Object.keys(TOKENS.atlantic)] as const;
export type Lang = "en" | "id";

export interface Draft { amount?: string; token?: string; recipient?: string; reference?: string }
export interface Parsed { draft: Draft; questions: string[]; parser: string; lang: Lang }

type Amount = { value: string } | { ask: "thousands-or-decimal"; raw: string };

/** "0.5" "0,5" "1,234.56" "1.234,56" "1.000.000" → plain decimal; "1.000" / "1,000" is ambiguous (English 1, Indonesian 1000). */
export function parseAmount(raw: string): Amount | undefined {
  const s = raw.trim();
  if (!/^\d[\d.,]*\d$|^\d$/.test(s)) return undefined;
  const dots = s.split(".").length - 1, commas = s.split(",").length - 1;
  if (dots && commas) {
    const dec = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const thou = dec === "." ? "," : ".";
    const [int, frac, ...rest] = s.split(dec);
    if (rest.length || !frac || !/^\d+$/.test(frac) || !/^\d{1,3}(?:[.,]\d{3})*$/.test(int) || int.includes(dec)) return undefined;
    return { value: `${int.split(thou).join("")}.${frac}` };
  }
  const sep = dots ? "." : commas ? "," : "";
  if (!sep) return { value: s };
  const parts = s.split(sep);
  if (parts.length > 2) return parts.slice(1).every((p) => p.length === 3) && parts[0].length <= 3 && parts[0] !== "0" ? { value: parts.join("") } : undefined;
  if (parts[1].length === 3 && parts[0] !== "0") return { ask: "thousands-or-decimal", raw: s };
  return { value: `${parts[0]}.${parts[1]}` };
}

const ID_WORDS = /\b(kirim|kirimkan|bayar|bayarkan|tolong|sebesar|sebanyak|dompet|alamat|ke alamat|kepada|untuk)\b/i;
export const detectLang = (text: string): Lang => (ID_WORDS.test(text) ? "id" : "en");

const Q = {
  en: {
    amount: "How much do you want to send?",
    token: `Which token? Atlantic has ${SYMBOLS.join(", ")} (PHRS is the native coin).`,
    recipient: "Which address should receive it? Send a 0x… address (names like alice.eth cannot be resolved on Pharos).",
    usd: (t: string) => `"${t}" is not a token on Atlantic. Do you mean USDC or USDT?`,
    thousands: (a: string) => `Is "${a}" one thousand or one point zero? Write it as 1000 or 1.0 so I do not guess.`,
    several: "I see more than one payment in that message. Which single payment should I prepare?",
  },
  id: {
    amount: "Berapa jumlah yang mau dikirim?",
    token: `Token apa? Atlantic punya ${SYMBOLS.join(", ")} (PHRS adalah koin native).`,
    recipient: "Ke alamat mana? Tulis alamat 0x… (nama seperti alice.eth tidak bisa diresolusi di Pharos).",
    usd: (t: string) => `"${t}" bukan token di Atlantic. Maksudnya USDC atau USDT?`,
    thousands: (a: string) => `"${a}" itu seribu atau satu koma nol? Tulis 1000 atau 1.0 supaya saya tidak menebak.`,
    several: "Ada lebih dari satu pembayaran di pesan itu. Pembayaran mana yang harus saya siapkan?",
  },
} as const;

const FIAT = /^(usd|dollars?|dolar|\$|rupiah|idr|eur|euro)$/i;
const ADDR = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
// An amount followed directly by a word or symbol: "0.5 PHRS", "100 usdc", "$20".
const PAIR = /(\d[\d.,]*\d|\d)\s*([A-Za-z$]{1,10})\b/g;

interface Fields { amount?: Amount; token?: string; fiat?: string; recipient?: string; several?: boolean }

function readRules(text: string): Fields {
  const f: Fields = {};
  const pairs = [...text.matchAll(PAIR)].filter((m) => !/^0x/i.test(m[0]) && (SYMBOLS.includes(m[2].toUpperCase() as never) || FIAT.test(m[2])));
  const distinct = new Set(pairs.map((m) => `${m[1]}|${m[2].toUpperCase()}`));
  if (distinct.size > 1) f.several = true;
  // A number glued to digits, a minus sign or an exponent ("1 500", "-5", "1e3") is not read: ask instead of misreading it.
  if (pairs.some((m) => /(?:\d[.,]?\s?|-|\de)$/i.test(text.slice(Math.max(0, m.index! - 2), m.index!)))) f.several = true;
  if (pairs[0]) {
    f.amount = parseAmount(pairs[0][1]);
    const w = pairs[0][2];
    if (SYMBOLS.includes(w.toUpperCase() as never)) f.token = w.toUpperCase();
    else f.fiat = w;
  } else {
    const bare = text.match(/(?<![\w.])(\d[\d.,]*\d|\d)(?![\w.,]*[a-wyzA-WYZ])/);
    if (bare && !/0x[0-9a-fA-F]*$/.test(text.slice(0, bare.index! + bare[0].length))) f.amount = parseAmount(bare[1]);
    const tok = text.match(new RegExp(`\\b(${SYMBOLS.join("|")})\\b`, "i"));
    if (tok) f.token = tok[1].toUpperCase();
  }
  const addrs = [...new Set(text.match(ADDR) ?? [])];
  if (addrs.length > 1) f.several = true;
  if (addrs[0]) f.recipient = addrs[0];
  else {
    const to = text.match(/\b(?:to|ke|kepada|untuk)\s+(?:alamat\s+)?(\S+)/i);
    if (to) f.recipient = to[1].replace(/[.,;!?]+$/, "");
  }
  return f;
}

function toDraft(f: Fields, lang: Lang): Omit<Parsed, "parser"> {
  const q = Q[lang];
  const questions: string[] = [];
  const draft: Draft = {};
  if (f.several) questions.push(q.several);
  if (f.amount && "value" in f.amount) draft.amount = f.amount.value;
  else if (f.amount) questions.push(q.thousands(f.amount.raw));
  else questions.push(q.amount);
  if (f.token) draft.token = f.token;
  else if (f.fiat) questions.push(q.usd(f.fiat));
  else questions.push(q.token);
  if (f.recipient) draft.recipient = f.recipient;
  else questions.push(q.recipient);
  return { draft, questions, lang };
}

/** Later turns override earlier ones field by field, so "USDC" answered to "which token?" fills the gap. */
export function parseRules(turns: string[]): Parsed {
  const merged: Fields = {};
  for (const t of turns) {
    const f = readRules(t);
    if (f.amount) merged.amount = f.amount;
    if (f.token) { merged.token = f.token; delete merged.fiat; }
    else if (f.fiat && !merged.token) merged.fiat = f.fiat;
    if (f.recipient) merged.recipient = f.recipient;
    merged.several = f.several;
  }
  const lang = detectLang(turns.join(" "));
  const out = toDraft(merged, lang);
  return { ...out, parser: "rules" };
}

const SYSTEM = `You extract ONE payment instruction from a chat (English or Bahasa Indonesia). Reply with JSON only:
{"amount": string|null, "token": string|null, "recipient": string|null, "reference": string|null}
Rules: copy the recipient EXACTLY as written (0x address or name), never invent one. amount is the number as a plain decimal string.
token is the symbol as written (PHRS, USDC, USDT, WBTC, WETH, WPHRS, or whatever the user wrote). Later chat turns override earlier ones.
Use null for anything not stated. Do not guess.`;

/** The LLM parses; the rules check it. Disagreement or ambiguity becomes a question, never a guess. */
export async function parseWithLlm(turns: string[], llm: LlmJson): Promise<Parsed> {
  const text = turns.join(" ");
  const rules = parseRules(turns);
  const lang = rules.lang;
  const { json, model } = await llm(SYSTEM, turns.map((t, i) => `Turn ${i + 1}: ${t}`).join("\n"));
  const j = (json ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const merged: Fields = {};
  const amountRaw = str(j.amount) ?? (typeof j.amount === "number" ? String(j.amount) : undefined);
  const lastRules = readRules(text); // the whole conversation, for the ambiguity check
  const ruleAmount = rules.draft.amount;
  if (lastRules.amount && "ask" in lastRules.amount && !ruleAmount) merged.amount = lastRules.amount;
  else if (ruleAmount && amountRaw && /^\d+(\.\d+)?$/.test(amountRaw)) {
    // The LLM may not turn "1.000" into 1000 on its own: when the rules read a different number, ask.
    merged.amount = Number(ruleAmount) !== Number(amountRaw) ? { ask: "thousands-or-decimal", raw: amountRaw } : { value: amountRaw };
  } // no amount the rules can find in the text: whatever number the model offers is dropped and the user is asked
  const tok = str(j.token);
  if (tok && SYMBOLS.includes(tok.toUpperCase() as never) && new RegExp(`\\b${tok}\\b`, "i").test(text)) {
    // The rules saw a different token next to the amount: do not let the model swap it.
    if (rules.draft.token && rules.draft.token !== tok.toUpperCase()) merged.token = rules.draft.token;
    else merged.token = tok.toUpperCase();
  }
  else if (tok && FIAT.test(tok)) merged.fiat = tok;
  else if (tok && text.toLowerCase().includes(tok.toLowerCase())) merged.token = tok.toUpperCase(); // unknown symbol: validation names it
  const rec = str(j.recipient);
  if (rec && text.toLowerCase().includes(rec.toLowerCase())) merged.recipient = rec; // an address the user never typed is dropped
  merged.several = rules.questions.includes(Q[lang].several);
  const out = toDraft(merged, lang);
  const ref = str(j.reference);
  if (ref && text.includes(ref)) out.draft.reference = ref;
  return { ...out, parser: model };
}
