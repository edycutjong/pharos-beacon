import { fmtToken } from "../liq/alert.js";
import type { Fact, Position, Snapshot } from "./read.js";
import type { Lang } from "./ask.js";

// "What changed since block X?": the same wallet at two blocks, matched position by position. For every row the change in USD is split
// into what the owner DID (shares or balance moved in or out, priced at the earlier block's price) and what the market DID (share
// price, PROS price or oracle price moved, applied to the later amount). The two parts add up to the total change exactly.

export interface ChangeRow {
  key: string;
  /** The position the row is about (either snapshot's), for wording in the asker's language. */
  position: Position;
  /** USD before/after; null when the position has no price source (then only amounts are compared). */
  usdBefore: number | null;
  usdAfter: number | null;
  /** The part of the change caused by balances moving, and by prices/rates moving (USD); null when unpriced. */
  moves: number | null;
  market: number | null;
  /** Amount facts in the position's own unit, earlier then later (null = the position did not exist). */
  amountBefore: Fact | null;
  amountAfter: Fact | null;
  extra: Fact[];
  note?: string;
  /** Morpho rows: the "moves" part includes interest accrued on the debt, so it is worded differently. */
  morpho?: boolean;
  /** Morpho rows where collateral and supply did not move: the change is the debt alone (interest accrued, or a borrow/repay). */
  debtOnly?: boolean;
}

export interface Diff { rows: ChangeRow[]; before: Snapshot; after: Snapshot }

const num = (f: Fact) => Number(f.raw) / 10 ** f.decimals;

function keyOf(p: Position): string {
  return p.kind === "token" ? `token:${p.symbol}` : p.kind === "vault" ? `vault:${p.symbol}` : `morpho:${p.market}`;
}

const nameOf = (p: Position, lang: Lang): string => (p.kind === "token" ? `${p.symbol} ${lang === "id" ? "di dompet" : "in wallet"}` : p.kind === "vault" ? `${p.symbol} (${p.protocol})` : `Morpho Blue ${p.pair}`);

const mainAmount = (p: Position): Fact => (p.kind === "token" ? p.amount : p.kind === "vault" ? p.shares : p.collateral);

function unitPrice(p: Position): number | null {
  if (p.kind === "token") return p.usd === null ? null : p.symbol === "USDC" ? 1 : p.priceFact ? Number(p.priceFact.raw) / 10 ** p.priceFact.decimals : null;
  if (p.kind === "vault") return Number(p.sharePrice.raw) / 10 ** p.sharePrice.decimals;
  return null;
}

/** The zero read behind a position that did not exist in `snap` (so "0 →" cites its source), if the wallet token/vault was read as zero. */
function zeroFact(snap: Snapshot, p: Position): Fact | null {
  if (p.kind === "morpho") return null;
  return snap.zeros.find((f) => f.symbol === p.symbol) ?? null;
}

export function diffSnapshots(a: Snapshot, b: Snapshot): Diff {
  const A = new Map(a.positions.map((p) => [keyOf(p), p]));
  const B = new Map(b.positions.map((p) => [keyOf(p), p]));
  const rows: ChangeRow[] = [];
  for (const key of new Set([...A.keys(), ...B.keys()])) {
    const pa = A.get(key);
    const pb = B.get(key);
    const ref = (pb ?? pa)!;
    const row: ChangeRow = { key, position: ref, usdBefore: null, usdAfter: null, moves: null, market: null, amountBefore: pa ? mainAmount(pa) : zeroFact(a, ref), amountAfter: pb ? mainAmount(pb) : zeroFact(b, ref), extra: [] };
    if (ref.kind === "morpho") {
      const ma = pa as Extract<Position, { kind: "morpho" }> | undefined;
      const mb = pb as Extract<Position, { kind: "morpho" }> | undefined;
      row.morpho = true;
      row.debtOnly = !!ma && !!mb && ma.collateral.raw === mb.collateral.raw && ma.supplied.raw === mb.supplied.raw;
      row.extra = [ma?.debt, mb?.debt, ma?.supplied, mb?.supplied].filter((f): f is Fact => !!f);
      if (ref.usdPegged) {
        row.usdBefore = ma?.netUsd ?? 0;
        row.usdAfter = mb?.netUsd ?? 0;
        // collateral price effect: later collateral amount × change in the oracle's value of one unit
        const pA = ma && ma.collateral.raw > 0n ? num(ma.collateralValue) / num(ma.collateral) : null;
        const pB = mb && mb.collateral.raw > 0n ? num(mb.collateralValue) / num(mb.collateral) : null;
        row.market = pA !== null && pB !== null && mb ? num(mb.collateral) * (pB - pA) : 0;
        row.moves = row.usdAfter - row.usdBefore - row.market;
        row.note = "debt, supply and collateral changes are shown together with accrued interest (the position is read, not its history)";
      }
    } else {
      const pA = pa ? unitPrice(pa) : unitPrice(pb!);
      const pB = pb ? unitPrice(pb) : unitPrice(pa!);
      if (pA !== null && pB !== null) {
        const amtA = pa ? num(mainAmount(pa)) : 0;
        const amtB = pb ? num(mainAmount(pb)) : 0;
        // the same USD figure the "hold" answer shows (a vault's is the convertToAssets read), so both answers agree to the cent
        row.usdBefore = pa && (pa.kind === "token" || pa.kind === "vault") && pa.usd !== null ? pa.usd : amtA * pA;
        row.usdAfter = pb && (pb.kind === "token" || pb.kind === "vault") && pb.usd !== null ? pb.usd : amtB * pB;
        row.moves = (amtB - amtA) * pA;
        row.market = row.usdAfter - row.usdBefore - row.moves; // what is left after the owner's moves: the market's part, so the two add up exactly
        row.extra = [pa && ref.kind === "vault" ? (pa as Extract<Position, { kind: "vault" }>).sharePrice : pa && ref.kind === "token" ? (pa as Extract<Position, { kind: "token" }>).priceFact : undefined, pb && ref.kind === "vault" ? (pb as Extract<Position, { kind: "vault" }>).sharePrice : pb && ref.kind === "token" ? (pb as Extract<Position, { kind: "token" }>).priceFact : undefined].filter((f): f is Fact => !!f);
      } else {
        row.note = "no price source was read, so only the amounts are compared";
      }
    }
    const amtChanged = (row.amountBefore?.raw ?? 0n) !== (row.amountAfter?.raw ?? 0n);
    const valueChanged = row.usdBefore !== null && row.usdAfter !== null && Math.abs(row.usdAfter - row.usdBefore) >= 0.005;
    const extraChanged = ref.kind === "morpho" && ((A.get(key) as { debt?: Fact } | undefined)?.debt?.raw ?? 0n) !== ((B.get(key) as { debt?: Fact } | undefined)?.debt?.raw ?? 0n);
    if (amtChanged || valueChanged || extraChanged) rows.push(row);
  }
  rows.sort((x, y) => Math.abs((y.usdAfter ?? 0) - (y.usdBefore ?? 0)) - Math.abs((x.usdAfter ?? 0) - (x.usdBefore ?? 0)));
  return { rows, before: a, after: b };
}

const signed = (v: number) => `${v >= 0 || Math.abs(v) < 0.005 ? "+" : "−"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const T = {
  en: { flows: "from balances moving", price: "from prices/rates moving", morphoFlows: "from amounts changing (including interest accrued on the debt)", morphoDebtOnly: "from the debt changing (interest accrued, or a borrow/repay)", morphoPrice: "from the collateral price moving", new: "new position", gone: "position closed", total: "Net change in valued positions" },
  id: { flows: "dari perpindahan saldo", price: "dari perubahan harga/imbal hasil", morphoFlows: "dari perubahan jumlah (termasuk bunga yang bertambah pada utang)", morphoDebtOnly: "dari utang yang berubah (bunga bertambah, atau pinjam/bayar)", morphoPrice: "dari pergerakan harga jaminan", new: "posisi baru", gone: "posisi ditutup", total: "Perubahan bersih posisi yang dinilai" },
} as const;

interface Citer { ref(...f: Fact[]): string }

export function explainChange(d: Diff, lang: Lang, c: Citer): string[] {
  const t = T[lang];
  const lines: string[] = [];
  let net = 0;
  const facts: Fact[] = [];
  for (const r of d.rows) {
    const fa = r.amountBefore;
    const fb = r.amountAfter;
    const unit = (fb ?? fa)!.symbol;
    const dp = (fb ?? fa)!.decimals >= 18 ? 4 : 2;
    const amounts = `${fa ? fmtToken(fa.raw, fa.decimals, dp) : "0"} → ${fb ? fmtToken(fb.raw, fb.decimals, dp) : "0"} ${unit}`;
    const cites = [fa, fb, ...r.extra].filter((f): f is Fact => !!f);
    const tag = !fa || fa.raw === 0n ? ` (${t.new})` : !fb || fb.raw === 0n ? ` (${t.gone})` : "";
    if (r.usdBefore !== null && r.usdAfter !== null && r.moves !== null && r.market !== null) {
      const delta = r.usdAfter - r.usdBefore;
      net += delta;
      facts.push(...cites);
      lines.push(`  ${nameOf(r.position, lang)}${tag}: ${amounts}; ${money(r.usdBefore)} → ${money(r.usdAfter)} (${signed(delta)}): ${signed(r.moves)} ${r.morpho ? (r.debtOnly ? t.morphoDebtOnly : t.morphoFlows) : t.flows}, ${signed(r.market)} ${r.morpho ? t.morphoPrice : t.price} ${c.ref(...cites)}`);
    } else {
      lines.push(`  ${nameOf(r.position, lang)}${tag}: ${amounts}${r.note ? ` (${r.note})` : ""} ${c.ref(...cites)}`);
    }
  }
  const priced = d.rows.filter((r) => r.moves !== null);
  if (priced.length) lines.push(`${t.total}: ${signed(net)} ${c.ref(...facts)}`);
  return lines;
}
