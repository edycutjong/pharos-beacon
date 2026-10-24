import { dropToLiquidation } from "../liq/morpho.js";
import { fmtHf, fmtToken, pct, short } from "../liq/alert.js";
import { VAULTS, WALLET_TOKENS, type Fact, type FactBook, type Position, type Snapshot, type Yield } from "./read.js";
import { diffSnapshots, explainChange } from "./change.js";

// Natural-language questions → intents by rules (English and Bahasa Indonesia), intents → answers built ONLY from facts that were
// read from the chain. No model writes a number: every figure is printed through `fig()`/`usd()` with the ids of the reads it
// came from ("[F3]" or "[F3, F7]" for a derived figure), and `sourceTable` lists contract, call and block for each id.

export type Lang = "en" | "id";

export type Intent =
  | { type: "balance"; token: string }
  | { type: "where"; token: string }
  | { type: "biggest" }
  | { type: "earning" }
  | { type: "debt" }
  | { type: "total" }
  | { type: "changed"; sinceBlock?: bigint; sinceDays?: number }
  | { type: "list" }
  | { type: "unsupported"; reason: "protocol" | "advice" | "token"; name: string }
  | { type: "unknown" };

/** Protocols people ask about that this assistant has no reader for. It says so instead of guessing. */
const UNREAD_PROTOCOLS = ["harbor", "termmax", "prosper", "aave", "compound", "curve", "pendle", "lido", "uniswap", "faroswap", "gmx", "balancer", "yearn"];

const KNOWN_TOKENS = [...WALLET_TOKENS.map((t) => t.symbol), "PROS", ...VAULTS.map((v) => v.key)];

export function detectLang(q: string): Lang {
  return /\b(berapa|saya|aku|saldo|dimana|di mana|apa|punya|utang|hutang|terbesar|menghasilkan|sejak|berubah|posisi|dompet|nilai|bunga|pinjaman|keseluruhan)\b/i.test(q) ? "id" : "en";
}

function findToken(q: string): string | undefined {
  const hit = KNOWN_TOKENS.find((t) => new RegExp(`\\b${t}\\b`, "i").test(q));
  return hit;
}

/** A token symbol the question names that we do not read (so the answer can say so). */
function unknownTokenIn(q: string): string | undefined {
  const m = q.match(/\b(?:my|saya|aku|of|punya|saldo)\s+\$?([A-Za-z][A-Za-z0-9]{1,9})\b/) ?? q.match(/\bhow much\s+\$?([A-Za-z][A-Za-z0-9]{1,9})\s+(?:do|am|are)\b/i) ?? q.match(/\bberapa\s+(?:saldo\s+)?\$?([A-Za-z][A-Za-z0-9]{1,9})\s+(?:saya|aku)\b/i);
  const cand = m?.[1];
  if (!cand || /^(portfolio|wallet|money|funds|assets|tokens|balance|positions|position|dompet|saldo|uang|aset|total|net|investments|holdings|much|many|money|do|have)$/i.test(cand)) return undefined;
  return KNOWN_TOKENS.some((t) => t.toLowerCase() === cand.toLowerCase()) ? undefined : cand.toUpperCase();
}

export function classify(question: string): Intent {
  const q = question.trim().toLowerCase();
  const prot = UNREAD_PROTOCOLS.find((p) => new RegExp(`\\b${p}\\b`).test(q));
  if (prot) return { type: "unsupported", reason: "protocol", name: prot[0]!.toUpperCase() + prot.slice(1) };
  if (/\b(price|forecast|predict|will .* (go|rise|fall)|harga .* (besok|nanti)|prediksi|should i (buy|sell))\b/.test(q) && !/\bpriced?\b.*\b(my|saya)\b/.test(q)) return { type: "unsupported", reason: "advice", name: "" };

  const blk = q.match(/\b(?:block|blok)\s*#?(\d{5,10})\b/);
  const days = q.match(/\b(\d+(?:\.\d+)?)\s*(day|days|hari|d)\b/) ?? (/\b(yesterday|kemarin)\b/.test(q) ? ["", "1"] : /\b(last week|minggu lalu|seminggu)\b/.test(q) ? ["", "7"] : null);
  if (/\b(change|changed|changes|since|berubah|perubahan|sejak|different|moved)\b/.test(q)) {
    return { type: "changed", sinceBlock: blk ? BigInt(blk[1]!) : undefined, sinceDays: days ? Number(days[1]) : undefined };
  }
  const token = findToken(question);
  const where = q.match(/\bwhere\s+(?:is|are)\s+my\s+\$?([a-z0-9]+)|\b(?:di\s?mana)\s+\$?([a-z0-9]+)\s+(?:saya|aku)/);
  if (where) {
    const t = findToken(where[1] ?? where[2] ?? "");
    return t ? { type: "where", token: t.toUpperCase() === "PROS" ? "PROS" : t } : { type: "unsupported", reason: "token", name: (where[1] ?? where[2])!.toUpperCase() };
  }
  if (/\b(biggest|largest|top|terbesar|paling besar|terbanyak)\b/.test(q)) return { type: "biggest" };
  if (/\b(earn|earning|earnings|yield|yields|apy|apr|interest|income|menghasilkan|penghasilan|bunga|imbal|untung|cuan)\b/.test(q)) return { type: "earning" };
  if (/\b(owe|debt|debts|borrow|borrowed|liquidat\w*|health|collateral|utang|hutang|pinjam\w*|pinjaman|likuidasi|jaminan)\b/.test(q)) return { type: "debt" };
  if (/\b(total|net worth|worth|how much (money|do i have in total)|portfolio value|keseluruhan|kekayaan|total nilai|nilai (portofolio|total))\b/.test(q) && !token) return { type: "total" };
  if (/\bwhat (do|am) i (hold|have|own|holding)\b|\bapa (saja )?yang (saya|aku) (punya|pegang)\b|\bapa saja\b|\bshow (me )?(my )?(positions|portfolio|holdings)\b/.test(q)) return { type: "list" };
  if (/\b(how much|balance|saldo|berapa|holding|do i have|do i hold|punya)\b/.test(q)) {
    if (token) return { type: "balance", token };
    const u = unknownTokenIn(question);
    return u ? { type: "unsupported", reason: "token", name: u } : { type: "total" };
  }
  if (/\b(what do i (hold|have|own)|positions?|protocols?|apa saja|posisi|list|show|holdings|portfolio|portofolio|dompet|wallet)\b/.test(q)) return { type: "list" };
  return { type: "unknown" };
}

// ---------------------------------------------------------------- figures with citations

export interface Answer {
  question: string;
  lang: Lang;
  intent: Intent;
  /** Plain text; every line that carries a number also carries its [F…] ids. */
  text: string;
  /** Ids of every fact the text cites. */
  cites: string[];
  /** Set when the assistant declined or could not read something: the honest "I don't know". */
  refused?: string;
}

export interface Reads {
  snapshots: Snapshot[];
  book: FactBook;
  /** Snapshots of the same wallets at an earlier block (for "what changed"). */
  earlier(sinceBlock?: bigint, sinceDays?: number): Promise<Snapshot[]>;
  /** Share-price growth of one vault position over `days` (for "what am I earning"). */
  yieldOf(pos: Extract<Position, { kind: "vault" }>, wallet: Snapshot, days: number): Promise<Yield>;
}

class Cites {
  readonly ids = new Set<string>();
  ref(...f: Fact[]): string {
    const ids = [...new Set(f.map((x) => x.id))];
    ids.forEach((id) => this.ids.add(id));
    return `[${ids.join(", ")}]`;
  }
}

const amt = (f: Fact, dp = 2) => `${fmtToken(f.raw, f.decimals, dp)} ${f.symbol}`;
export const usdText = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** USD value of a position plus the facts it was computed from (null when no price source was read for it). */
export function valueOf(p: Position): { usd: number; from: Fact[] } | null {
  if (p.kind === "token") return p.usd === null ? null : { usd: p.usd, from: p.priceFact ? [p.amount, p.priceFact] : [p.amount] };
  if (p.kind === "vault") return { usd: p.usd, from: [p.assets] };
  return p.netUsd === null ? null : { usd: p.netUsd, from: [p.supplied, p.collateralValue, p.debt] };
}

const label = (p: Position): string =>
  p.kind === "token" ? `${p.symbol} in wallet` : p.kind === "vault" ? `${p.symbol} (${p.protocol})` : `Morpho Blue ${p.pair} (collateral + supply − debt)`;

const MSG = {
  en: {
    noAny: "I read this wallet at block",
    nothing: "no positions found",
    blockLine: (b: bigint, w: string) => `Wallet ${w} at block ${b}:`,
    cantRead: (what: string, why: string) => `I could not read ${what}: ${why}. I will not guess it.`,
    unpriced: "not valued (no price source was read for it)",
    refusal: (what: string) => `I can't answer that: ${what}. I only read wallet token balances (SkillEngine list + PROS), the RockawayX and Centrifuge (JTRSY, HYB) vaults, and Morpho Blue markets on Pharos mainnet.`,
    unknown: "I didn't understand that. I can answer: how much of a token you hold, where a token is, your biggest position, what you earn, what you owe, your total, what you hold, and what changed since a block or N days ago.",
  },
  id: {
    noAny: "Saya membaca dompet ini pada blok",
    nothing: "tidak ada posisi",
    blockLine: (b: bigint, w: string) => `Dompet ${w} pada blok ${b}:`,
    cantRead: (what: string, why: string) => `Saya tidak bisa membaca ${what}: ${why}. Saya tidak akan menebaknya.`,
    unpriced: "tidak dinilai (tidak ada sumber harga yang dibaca)",
    refusal: (what: string) => `Saya tidak bisa menjawab itu: ${what}. Saya hanya membaca saldo token dompet (daftar SkillEngine + PROS), vault RockawayX dan Centrifuge (JTRSY, HYB), serta pasar Morpho Blue di Pharos mainnet.`,
    unknown: "Saya tidak mengerti. Saya bisa menjawab: berapa token yang Anda punya, di mana sebuah token berada, posisi terbesar, penghasilan, utang, total, apa yang Anda pegang, dan apa yang berubah sejak sebuah blok atau N hari lalu.",
  },
} as const;

/** What each answer type calls itself in each language (the lines that are not numbers). */
const W = {
  en: { in: "in", wallet: "wallet", vault: "vault", worth: "worth", none: (t: string) => `You hold no ${t} here`, total: "Total value", of: "of", debt: "debt", collateral: "collateral", health: "health factor", noDebt: "No debt", earns: "grew", perYear: "a year", on: "on", about: "that is about", apy: "annualised", over: "over", days: "days", biggest: "Your biggest position is", ranked: "Ranked", changedSince: "Since block", before: "before", after: "after", flows: "from balance moves", priceMove: "from price/rate moves", nothingChanged: "Nothing changed", walletTokens: "wallet tokens", where: "Your" },
  id: { in: "di", wallet: "dompet", vault: "vault", worth: "senilai", none: (t: string) => `Anda tidak punya ${t} di sini`, total: "Total nilai", of: "dari", debt: "utang", collateral: "jaminan", health: "faktor kesehatan", noDebt: "Tidak ada utang", earns: "tumbuh", perYear: "setahun", on: "dari", about: "itu sekitar", apy: "disetahunkan", over: "selama", days: "hari", biggest: "Posisi terbesar Anda adalah", ranked: "Peringkat", changedSince: "Sejak blok", before: "sebelum", after: "sesudah", flows: "dari perpindahan saldo", priceMove: "dari perubahan harga/imbal hasil", nothingChanged: "Tidak ada yang berubah", walletTokens: "token dompet", where: "Milik Anda" },
} as const;

function unreadableNotes(snaps: Snapshot[], lang: Lang, only?: (u: { protocol: string; what: string }) => boolean): string[] {
  return snaps.flatMap((s) => s.unreadable.filter((u) => (only ? only(u) : true)).map((u) => MSG[lang].cantRead(`${u.protocol}: ${u.what} for ${short(s.wallet)} at block ${s.block}`, u.reason)));
}

/** Add a line; the caller guarantees any digit in it is followed by a citation. */
type Lines = string[];

export async function answerQuestion(question: string, reads: Reads, windowDays = 7): Promise<Answer> {
  const lang = detectLang(question);
  const intent = classify(question);
  const m = MSG[lang];
  const w = W[lang];
  const c = new Cites();
  const out: Lines = [];
  const snaps = reads.snapshots;
  const finish = (refused?: string): Answer => ({ question, lang, intent, text: out.join("\n"), cites: [...c.ids], ...(refused ? { refused } : {}) });
  const header = () => snaps.forEach((s) => out.push(m.blockLine(s.block, s.wallet)));
  const all = (): { s: Snapshot; p: Position }[] => snaps.flatMap((s) => s.positions.map((p) => ({ s, p })));
  const who = (s: Snapshot) => (snaps.length > 1 ? `${short(s.wallet)} · ` : "");

  switch (intent.type) {
    case "unsupported": {
      const why = {
        en: { protocol: `I don't read ${intent.name}`, advice: "I only report what I read on chain; I don't predict prices or give advice", token: `I don't read the token "${intent.name}" (it is not in the SkillEngine token list or the vault list)` },
        id: { protocol: `saya tidak membaca ${intent.name}`, advice: "saya hanya melaporkan apa yang dibaca dari chain; saya tidak memprediksi harga atau memberi saran", token: `saya tidak membaca token "${intent.name}" (tidak ada di daftar token SkillEngine atau daftar vault)` },
      }[lang][intent.reason];
      out.push(m.refusal(why));
      return finish(`cannot answer: ${why}`);
    }
    case "unknown": {
      out.push(m.unknown);
      return finish("question not understood");
    }
    case "balance": {
      header();
      const sym = intent.token;
      let found = false;
      for (const { s, p } of all()) {
        if (p.kind === "token" && p.symbol.toLowerCase() === sym.toLowerCase()) { out.push(`${who(s)}${amt(p.amount, 4)} ${w.in} ${w.wallet} ${c.ref(p.amount)}`); found = true; }
        if (p.kind === "vault" && p.symbol.toLowerCase() === sym.toLowerCase()) { out.push(`${who(s)}${amt(p.shares, 4)} (${w.worth} ${amt(p.assets)}) ${c.ref(p.shares, p.assets)}`); found = true; }
      }
      if (!found) {
        const z = snaps.flatMap((s) => s.zeros).filter((f) => f.symbol.toLowerCase() === sym.toLowerCase());
        if (z.length) out.push(`${w.none(sym)}: balanceOf returned 0 ${c.ref(...z)}`);
        else out.push(`${w.none(sym)} (no read of ${sym} succeeded)`);
      }
      unreadableNotes(snaps, lang, (u) => u.what.toLowerCase().includes(sym.toLowerCase())).forEach((n) => out.push(n));
      return finish();
    }
    case "where": {
      header();
      const sym = intent.token.toUpperCase();
      const rows: string[] = [];
      for (const { s, p } of all()) {
        const pre = who(s);
        if (p.kind === "token" && p.symbol.toUpperCase() === sym) rows.push(`${pre}${amt(p.amount, 4)} ${w.in} ${w.wallet} ${c.ref(p.amount)}`);
        if (p.kind === "vault" && p.symbol.toUpperCase() === sym) rows.push(`${pre}${amt(p.shares, 4)} ${w.in} ${p.protocol} ${w.vault} ${c.ref(p.shares)}`);
        if (p.kind === "vault" && sym === "USDC") rows.push(`${pre}${amt(p.assets)} ${w.in} ${p.symbol} ${w.vault} (${p.protocol}) ${c.ref(p.assets)}`);
        if (p.kind === "morpho") {
          if (p.loanSymbol.toUpperCase() === sym && p.supplied.raw > 0n) rows.push(`${pre}${amt(p.supplied)} supplied ${w.in} Morpho Blue ${p.pair} ${c.ref(p.supplied)}`);
          if (p.collateral.symbol.toUpperCase() === sym && p.collateral.raw > 0n) rows.push(`${pre}${amt(p.collateral, 4)} ${w.collateral} ${w.in} Morpho Blue ${p.pair} ${c.ref(p.collateral)}`);
          if (p.loanSymbol.toUpperCase() === sym && p.debt.raw > 0n) rows.push(`${pre}${w.debt}: ${amt(p.debt)} ${w.in} Morpho Blue ${p.pair} (${sym} borrowed, not held) ${c.ref(p.debt)}`);
        }
      }
      if (!rows.length) out.push(`${w.none(sym)}: ${snaps.flatMap((s) => s.zeros).filter((f) => f.symbol.toUpperCase() === sym).map((f) => `balanceOf ${c.ref(f)}`).join(", ") || "no position read"}`);
      else rows.forEach((r) => out.push(`${sym}: ${r}`));
      unreadableNotes(snaps, lang).forEach((n) => out.push(n));
      return finish();
    }
    case "list": {
      header();
      const ps = all();
      if (!ps.length) out.push(`${m.nothing} ${c.ref(...snaps.flatMap((s) => s.zeros).slice(0, 3))}`);
      for (const { s, p } of ps) {
        const pre = who(s);
        if (p.kind === "token") out.push(`${pre}${p.protocol}: ${amt(p.amount, 4)} ${c.ref(p.amount)}`);
        else if (p.kind === "vault") out.push(`${pre}${p.protocol} ${p.symbol}: ${amt(p.shares, 4)} = ${amt(p.assets)} ${c.ref(p.shares, p.assets)}`);
        else out.push(`${pre}Morpho Blue ${p.pair}: ${w.collateral} ${amt(p.collateral, 4)}, ${w.debt} ${amt(p.debt)}, supplied ${amt(p.supplied)} ${c.ref(p.collateral, p.debt, p.supplied)}`);
      }
      unreadableNotes(snaps, lang).forEach((n) => out.push(n));
      return finish();
    }
    case "total":
    case "biggest": {
      header();
      const valued: { label: string; usd: number; from: Fact[] }[] = [];
      const skipped: string[] = [];
      for (const { s, p } of all()) {
        const v = valueOf(p);
        if (v) valued.push({ label: who(s) + label(p), ...v });
        else skipped.push(`${who(s)}${label(p)}: ${m.unpriced}`);
      }
      valued.sort((a, b) => b.usd - a.usd);
      if (!valued.length) out.push(`${m.nothing}`);
      else if (intent.type === "biggest") {
        const top = valued[0]!;
        out.push(`${w.biggest} ${top.label}: ${usdText(top.usd)} ${c.ref(...top.from)}`);
        valued.slice(1, 5).forEach((v, i) => out.push(`${w.ranked} #${i + 2}: ${v.label} ${usdText(v.usd)} ${c.ref(...v.from)}`));
      } else {
        const sum = valued.reduce((a, v) => a + v.usd, 0);
        out.push(`${w.total}: ${usdText(sum)} ${c.ref(...valued.flatMap((v) => v.from))}`);
        valued.forEach((v) => out.push(`  ${v.label}: ${usdText(v.usd)} ${c.ref(...v.from)}`));
      }
      skipped.forEach((s) => out.push(`  ${s}`));
      unreadableNotes(snaps, lang).forEach((n) => out.push(n));
      return finish();
    }
    case "debt": {
      header();
      let any = false;
      for (const { s, p } of all()) {
        if (p.kind !== "morpho" || p.debt.raw === 0n) continue;
        any = true;
        const hf = p.hf ?? Infinity;
        out.push(`${who(s)}${p.protocol} ${p.pair}: ${w.debt} ${amt(p.debt)}, ${w.collateral} ${amt(p.collateral, 4)} ${c.ref(p.debt, p.collateral)}; ${w.health} ${fmtHf(hf)} (collateral ${amt(p.collateralValue)} ${c.ref(p.collateralValue)}; may fall ${pct(dropToLiquidation(hf), 1)} before liquidation) ${c.ref(p.debt, p.collateralValue)}`);
      }
      if (!any) out.push(`${w.noDebt} ${w.in} Morpho Blue (${snaps.reduce((a, s) => a + s.marketsRead, 0)} position() reads, block ${snaps[0]?.block}) ${c.ref(...snaps.flatMap((s) => s.zeros).slice(0, 1))}`.replace(/ \[\]$/, ""));
      unreadableNotes(snaps, lang, (u) => u.protocol === "Morpho Blue").forEach((n) => out.push(n));
      return finish();
    }
    case "earning": {
      header();
      let any = false;
      for (const s of snaps) {
        for (const p of s.positions) {
          if (p.kind !== "vault") continue;
          any = true;
          try {
            const y = await reads.yieldOf(p, s, windowDays);
            const perYear = p.usd * y.apy;
            out.push(`${who(s)}${p.symbol} (${p.protocol}): 1 share ${w.earns} ${pct(y.growth, 3)} ${w.over} ${y.days.toFixed(1)} ${w.days} (${amt(y.priceThen, 6)} → ${amt(y.priceNow, 6)}) ${c.ref(y.priceThen, y.priceNow)}; ${pct(y.apy, 2)} APY ${w.apy} ${c.ref(y.priceThen, y.priceNow)}; ${w.on} ${usdText(p.usd)} ${c.ref(p.assets)} ${w.about} ${usdText(perYear)} ${w.perYear} ${c.ref(p.assets, y.priceThen, y.priceNow)}`);
          } catch (e) {
            out.push(m.cantRead(`${p.symbol} share price at the earlier block`, (e as Error).message.split("\n")[0]!.slice(0, 120)));
          }
        }
        for (const p of s.positions) if (p.kind === "morpho" && p.supplied.raw > 0n) {
          any = true;
          out.push(`${who(s)}Morpho Blue ${p.pair}: supplied ${amt(p.supplied)} ${c.ref(p.supplied)}; I did not compute its supply APY (only the position was read).`);
        }
      }
      if (!any) out.push(`Nothing here earns: wallet tokens pay no yield, and no vault shares or Morpho supply were found ${c.ref(...snaps.flatMap((s) => s.zeros).slice(0, 2))}`.replace(/ \[\]$/, ""));
      unreadableNotes(snaps, lang).forEach((n) => out.push(n));
      return finish();
    }
    case "changed": {
      const before = await reads.earlier(intent.sinceBlock, intent.sinceDays ?? (intent.sinceBlock ? undefined : windowDays));
      for (let i = 0; i < snaps.length; i++) {
        const a = before[i]!;
        const b = snaps[i]!;
        const d = diffSnapshots(a, b);
        out.push(`${w.changedSince} ${a.block} → ${b.block} (${short(b.wallet)}):`);
        for (const line of explainChange(d, lang, c)) out.push(line);
        if (!d.rows.length) out.push(w.nothingChanged);
      }
      unreadableNotes([...before, ...snaps], lang).forEach((n) => out.push(n));
      return finish();
    }
  }
}

/** Sources of every cited fact: figure id, what it is, contract, call, block. */
export function sourceTable(book: FactBook, ids: string[]): string {
  const rows = [...new Set(ids)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map((id) => {
    const f = book.facts.get(id)!;
    const where = f.source.contract === "native" ? "native balance" : f.source.contract;
    return `${f.id} | ${f.label} | ${where} | ${f.source.call} | block ${f.source.block}`;
  });
  return ["id | figure | contract | call | block", ...rows].join("\n");
}
