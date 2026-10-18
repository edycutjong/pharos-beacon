import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseUnits, type Hex } from "viem";
import { explorerTx } from "../lib/networks.js";
import { BroadcastError, type PreparedTx, type Receipt, type SignedTx, type TestnetSigner } from "../lib/signer.js";
import { describeError } from "../lib/net.js";
import { readState, writeState } from "../lib/state.js";
import type { Notifier } from "../watch/discord.js";

// A recurring payment is a schedule plus a ledger. The schedule says when each period is due; the ledger (a state file)
// says what happened to it. A period is paid at most once because the transaction is signed and written to the ledger
// BEFORE it is broadcast: a re-run after a crash looks that hash up (and re-sends the same bytes) instead of building a
// second payment. Pure schedule maths and the ledger live here; the CLI wires the Chain MCP signer in.

export type Frequency = "weekly" | "monthly";
export interface TokenSpec {
  symbol: string;
  decimals: number;
  /** Absent = native PHRS. */
  address?: Hex;
}
export interface Plan {
  id: string;
  frequency: Frequency;
  /** First due date (UTC). */
  start: string;
  /** Amount per period in the token's own units, as a decimal string. */
  amount: string;
  token: TokenSpec;
  recipient: Hex;
  /** Total periods (default: unlimited). */
  periods?: number;
}

const DAY = 86_400_000;
const MAX_CATCH_UP = 120;

export function parsePlan(raw: unknown): Plan {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object") throw new Error("the plan must be a JSON object");
  const id = String(p.id ?? "");
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new Error("plan.id must be lowercase letters, digits and hyphens");
  if (p.frequency !== "weekly" && p.frequency !== "monthly") throw new Error('plan.frequency must be "weekly" or "monthly"');
  const start = new Date(String(p.start));
  if (Number.isNaN(start.getTime())) throw new Error("plan.start must be a date, e.g. 2026-10-01T09:00:00Z");
  if (!isAddress(String(p.recipient))) throw new Error("plan.recipient must be a 0x address");
  let token: TokenSpec;
  if (p.token === "PHRS" || p.token === undefined) token = { symbol: "PHRS", decimals: 18 };
  else {
    const t = p.token as Record<string, unknown>;
    if (!t || !isAddress(String(t.address))) throw new Error('plan.token must be "PHRS" or {"address","symbol","decimals"}');
    const decimals = Number(t.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("plan.token.decimals must be a whole number");
    token = { symbol: String(t.symbol ?? "TOKEN"), decimals, address: getAddress(String(t.address)) };
  }
  const amount = String(p.amount ?? "");
  let units: bigint;
  try { units = parseUnits(amount, token.decimals); } catch { throw new Error("plan.amount must be a decimal number, e.g. 0.001"); }
  if (units <= 0n) throw new Error("plan.amount must be greater than zero");
  let periods: number | undefined;
  if (p.periods !== undefined) {
    periods = Number(p.periods);
    if (!Number.isInteger(periods) || periods < 1) throw new Error("plan.periods must be a whole number ≥ 1");
  }
  return { id, frequency: p.frequency, start: start.toISOString(), amount, token, recipient: getAddress(String(p.recipient)), ...(periods ? { periods } : {}) };
}

/** Due date of period `n` (1-based). Monthly keeps the start's day of month, clamped to a short month's last day. */
export function dueAt(plan: Plan, n: number): Date {
  const s = new Date(plan.start);
  if (plan.frequency === "weekly") return new Date(s.getTime() + (n - 1) * 7 * DAY);
  const total = s.getUTCMonth() + (n - 1);
  const year = s.getUTCFullYear() + Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(s.getUTCDate(), last), s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds()));
}

/** Periods whose due date has passed at `now`, oldest first. */
export function duePeriods(plan: Plan, now: Date): number[] {
  const out: number[] = [];
  for (let n = 1; n <= (plan.periods ?? Infinity) && out.length < MAX_CATCH_UP; n++) {
    if (dueAt(plan, n) > now) break;
    out.push(n);
  }
  return out;
}

/** The first period due after `now` (undefined once the plan is complete). */
export function nextScheduled(plan: Plan, now: Date): { period: number; due: Date } | undefined {
  for (let n = 1; n <= (plan.periods ?? n); n++) {
    const due = dueAt(plan, n);
    if (due > now) return { period: n, due };
  }
  return undefined;
}

export interface Attempt {
  at: string;
  outcome: string;
  hash?: Hex;
}
type StoredTx = Record<keyof Omit<PreparedTx, "data">, string> & { data?: Hex };
export interface Period {
  period: number;
  due: string;
  /** "sent" = signed and recorded, not confirmed yet (shown to the user as pending). */
  status: "sent" | "paid" | "failed";
  attempts: Attempt[];
  tx?: { hash: Hex; nonce: number; raw: Hex; prepared: StoredTx };
  reason?: string;
  block?: string;
  gasUsed?: string;
  paidAtRun?: string;
  receipt?: { notifier: string; id?: string } | { error: string };
}
export interface Ledger {
  plan: Plan;
  payer?: Hex;
  periods: Period[];
}
export type ShownStatus = "paid" | "pending" | "failed";

export function loadLedger(file: string, plan: Plan): Ledger {
  return readState<Ledger>(file, { plan, periods: [] }, (v) => {
    const l = v as Ledger;
    if (!l || !Array.isArray(l.periods) || !l.plan) throw new Error(`${file} is not a recurring-payment ledger`);
    if (JSON.stringify(l.plan) !== JSON.stringify(plan)) {
      throw new Error(`${file} belongs to a different plan (amount, token, recipient, schedule or start differ). Use another --state file for a changed plan: paying on an edited plan would hide what was paid before`);
    }
    return l;
  });
}

const rehydrate = (t: StoredTx): PreparedTx => ({
  chainId: Number(t.chainId), to: t.to as Hex, value: BigInt(t.value), nonce: Number(t.nonce), gas: BigInt(t.gas),
  maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas), ...(t.data ? { data: t.data } : {}),
});
const dehydrate = (t: PreparedTx): StoredTx => ({
  chainId: String(t.chainId), to: t.to, value: t.value.toString(), nonce: String(t.nonce), gas: t.gas.toString(),
  maxFeePerGas: t.maxFeePerGas.toString(), maxPriorityFeePerGas: t.maxPriorityFeePerGas.toString(), ...(t.data ? { data: t.data } : {}),
});

/** What the agent needs from the chain. The CLI binds it to the Chain MCP signer; tests bind it to fakes. */
export interface Port {
  address: Hex;
  nativeBalance(): Promise<bigint>;
  tokenBalance(token: Hex): Promise<bigint>;
  /** Null while the node does not have a receipt for the hash. */
  receipt(hash: Hex): Promise<Receipt | null>;
  signer: Pick<TestnetSigner, "prepare" | "sign" | "broadcast" | "waitForReceipt">;
}

export interface RunOptions {
  plan: Plan;
  file: string;
  port: Port;
  now: Date;
  notifier?: Notifier;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Pause before the one retry of a send the node refused (ms). */
  backoffMs?: number;
}
export interface RunEvent {
  period: number;
  action: "paid" | "failed" | "pending" | "already-paid" | "reconciled-paid" | "reconciled-failed";
  detail: string;
  tx?: Hex;
}

export const shown = (p: Period | undefined): ShownStatus => (p?.status === "paid" ? "paid" : p?.status === "failed" ? "failed" : "pending");
/** At most 6 decimals, so a reason stays short. */
const trim = (v: string) => v.replace(/(\.\d{6})\d+$/, "$1");
const amountText = (plan: Plan) => `${plan.amount} ${plan.token.symbol}`;

function save(file: string, ledger: Ledger): void {
  writeState(file, ledger);
}
function upsert(ledger: Ledger, rec: Period): Period {
  const i = ledger.periods.findIndex((p) => p.period === rec.period);
  if (i >= 0) ledger.periods[i] = rec;
  else ledger.periods.push(rec), ledger.periods.sort((a, b) => a.period - b.period);
  return rec;
}

async function sendReceipt(o: RunOptions, rec: Period, text: string): Promise<void> {
  if (!o.notifier || rec.receipt) return;
  try {
    const d = await o.notifier.send(text);
    rec.receipt = { notifier: o.notifier.name, ...(d.id ? { id: d.id } : {}) };
  } catch (e) {
    rec.receipt = { error: describeError(e) }; // a lost notification never changes what was paid
  }
}

const paidText = (o: RunOptions, rec: Period) =>
  `Recurring payment ${o.plan.id} #${rec.period}: ${amountText(o.plan)} paid to ${o.plan.recipient} (due ${rec.due.slice(0, 10)}) ${explorerTx("atlantic", rec.tx!.hash)}`;

async function settle(o: RunOptions, ledger: Ledger, rec: Period, r: Receipt, how: RunEvent["action"]): Promise<RunEvent> {
  rec.block = r.blockNumber.toString();
  rec.gasUsed = r.gasUsed.toString();
  const hash = rec.tx!.hash;
  if (r.status === "success") {
    rec.status = "paid";
    rec.paidAtRun = o.now.toISOString();
    rec.attempts.push({ at: o.now.toISOString(), outcome: "confirmed", hash });
    await sendReceipt(o, rec, paidText(o, rec));
    save(o.file, ledger);
    return { period: rec.period, action: how === "reconciled-paid" ? how : "paid", detail: `block ${rec.block}, gas used ${rec.gasUsed}`, tx: hash };
  }
  rec.status = "failed";
  rec.reason = `the transaction was mined but reverted (block ${rec.block})`;
  rec.attempts.push({ at: o.now.toISOString(), outcome: "reverted", hash });
  rec.tx = undefined; // mined and reverted: it can never pay, so the period may be tried again with a new transaction
  await sendReceipt(o, rec, `Recurring payment ${o.plan.id} #${rec.period} FAILED: ${rec.reason}. ${explorerTx("atlantic", hash)}`);
  save(o.file, ledger);
  return { period: rec.period, action: how === "reconciled-paid" ? "reconciled-failed" : "failed", detail: rec.reason, tx: hash };
}

/** A period signed and recorded earlier whose outcome is unknown: ask the chain, re-send the same bytes if it is missing. Never builds a new payment. */
async function reconcile(o: RunOptions, ledger: Ledger, rec: Period): Promise<RunEvent> {
  const { hash, raw, prepared } = rec.tx!;
  let r = await o.port.receipt(hash);
  if (!r) {
    const signed: SignedTx = { hash, raw, tx: rehydrate(prepared) };
    await o.port.signer.broadcast(signed); // same bytes, same hash: sending it twice cannot pay twice
    r = await o.port.signer.waitForReceipt(hash);
  }
  return settle(o, ledger, rec, r, "reconciled-paid");
}

function fail(o: RunOptions, ledger: Ledger, rec: Period, reason: string): RunEvent {
  rec.status = "failed";
  rec.reason = reason;
  rec.attempts.push({ at: o.now.toISOString(), outcome: `failed: ${reason}` });
  save(o.file, ledger);
  return { period: rec.period, action: "failed", detail: reason };
}

/** Pay one period. Order matters: check funds → prepare → sign → RECORD the hash and nonce → broadcast → confirm. */
async function pay(o: RunOptions, ledger: Ledger, rec: Period): Promise<RunEvent> {
  const { plan, port } = o;
  const units = parseUnits(plan.amount, plan.token.decimals);
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let nonce: number | undefined;
  for (let attempt = 1; ; attempt++) {
    const have = plan.token.address ? await port.tokenBalance(plan.token.address) : await port.nativeBalance();
    if (have < units) {
      return fail(o, ledger, rec, `insufficient ${plan.token.symbol} balance: has ${trim(formatUnits(have, plan.token.decimals))}, needs ${plan.amount}; nothing was sent`);
    }
    const intent = plan.token.address
      ? { to: plan.token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [plan.recipient, units] }), ...(nonce !== undefined ? { nonce } : {}) }
      : { to: plan.recipient, value: units, ...(nonce !== undefined ? { nonce } : {}) };
    const prepared = await port.signer.prepare(intent);
    const fee = prepared.gas * prepared.maxFeePerGas;
    const native = plan.token.address ? await port.nativeBalance() : have;
    const need = fee + (plan.token.address ? 0n : units);
    if (native < need) {
      return fail(o, ledger, rec, `insufficient PHRS: has ${trim(formatUnits(native, 18))}, needs ${trim(formatUnits(need, 18))} (${plan.token.address ? "gas" : `${plan.amount} + gas`}); nothing was sent`);
    }
    const signed = await port.signer.sign(prepared);
    rec.status = "sent";
    rec.reason = undefined;
    rec.tx = { hash: signed.hash, nonce: prepared.nonce, raw: signed.raw, prepared: dehydrate(prepared) };
    rec.attempts.push({ at: o.now.toISOString(), outcome: `signed (attempt ${attempt}), recorded before broadcast`, hash: signed.hash });
    save(o.file, ledger); // the hash is on disk before the network sees it
    try {
      await port.signer.broadcast(signed);
    } catch (e) {
      if (e instanceof BroadcastError) {
        // The node refused it and does not have it, so it cannot land: the period is unpaid and one retry cannot double-pay.
        nonce = prepared.nonce;
        rec.tx = undefined;
        rec.attempts.push({ at: o.now.toISOString(), outcome: `refused by the node: ${describeError(e.cause)}`, hash: signed.hash });
        if (attempt < 2) {
          o.log?.(`  period ${rec.period}: the node refused the send (${describeError(e.cause)}); retrying once after a pause`);
          save(o.file, ledger);
          await sleep(o.backoffMs ?? 3000);
          continue;
        }
        return fail(o, ledger, rec, `the node refused the transaction twice: ${describeError(e.cause)}; nothing was paid`);
      }
      throw e; // unclear outcome: the hash stays recorded as "sent" and the next run reconciles it
    }
    const r = await port.signer.waitForReceipt(signed.hash);
    return settle(o, ledger, rec, r, "paid");
  }
}

/** Process every period due at `o.now`. Stops at the first unclear outcome (a later payment must not overtake it). */
export async function runDue(o: RunOptions): Promise<RunEvent[]> {
  const ledger = loadLedger(o.file, o.plan);
  ledger.payer = o.port.address;
  if (o.plan.recipient === o.port.address) throw new Error("the recipient is the paying wallet: refusing a payment to yourself");
  const events: RunEvent[] = [];
  for (const n of duePeriods(o.plan, o.now)) {
    let rec = ledger.periods.find((p) => p.period === n);
    if (rec?.status === "paid") {
      events.push({ period: n, action: "already-paid", detail: `paid in block ${rec.block}; not paid again`, tx: rec.tx!.hash });
      continue;
    }
    rec ??= upsert(ledger, { period: n, due: dueAt(o.plan, n).toISOString(), status: "failed", attempts: [] });
    const ev = rec.status === "sent" && rec.tx ? await reconcile(o, ledger, rec) : await pay(o, ledger, rec);
    events.push(ev);
    o.log?.(`  period ${n} (due ${rec.due.slice(0, 10)}): ${ev.action} — ${ev.detail}`);
  }
  save(o.file, ledger);
  return events;
}

export interface Row {
  period: number;
  due: string;
  status: ShownStatus;
  amount: string;
  tx: string;
  note: string;
}

/** The history table: every period due so far plus the next scheduled one. */
export function historyRows(plan: Plan, ledger: Ledger, now: Date): { rows: Row[]; next?: { period: number; due: string } } {
  const rows: Row[] = [];
  for (const n of duePeriods(plan, now)) {
    const rec = ledger.periods.find((p) => p.period === n);
    const hash = rec?.attempts.filter((a) => a.hash).at(-1)?.hash;
    rows.push({
      period: n, due: dueAt(plan, n).toISOString().slice(0, 10), status: shown(rec), amount: amountText(plan),
      tx: rec?.status === "paid" ? rec.tx!.hash : hash ?? "-",
      note: rec?.status === "paid" ? `block ${rec.block}` : rec?.reason ?? (rec ? "signed, awaiting confirmation" : "due, not yet processed"),
    });
  }
  const nx = nextScheduled(plan, now);
  return { rows, ...(nx ? { next: { period: nx.period, due: nx.due.toISOString() } } : {}) };
}

const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

/** Periods that are due but not paid are tried again by the next run; saying so keeps a failed period from looking abandoned. */
export function unpaidDue(rows: Row[]): string | undefined {
  const o = rows.filter((r) => r.status !== "paid");
  return o.length ? `unpaid and due: ${o.map((r) => `period ${r.period} (${r.status})`).join(", ")}; the next run tries ${o.length === 1 ? "it" : "them"} again` : undefined;
}

/** The same history in under 62 columns (a narrow terminal, a video): no wrapped rows, the reason is in the run's own lines. */
export function compactTable(plan: Plan, ledger: Ledger, now: Date): string {
  const { rows, next } = historyRows(plan, ledger, now);
  const lines = rows.map((r) => `${String(r.period).padEnd(2)} ${r.due}  ${r.status.padEnd(7)} ${r.tx === "-" ? "(no tx sent)" : short(r.tx)}`);
  const open = rows.filter((r) => r.status !== "paid");
  const retry = open.length ? `retry at next run: ${open.map((r) => `#${r.period}`).join(" ")}` : undefined;
  const tail = next ? `next: #${next.period} on ${next.due.slice(0, 10)} ${next.due.slice(11, 16)}Z` : open.length ? "no later period is scheduled" : "no further payments: plan complete";
  return [`plan ${plan.id}: ${plan.frequency}, ${amountText(plan)}`, `to ${short(plan.recipient)}`, "#  due         status  tx", ...(lines.length ? lines : ["(nothing due yet)"]), ...(retry ? [retry] : []), tail].join("\n");
}

/** Break a line at spaces so no piece is longer than `width`; continuation lines are indented. */
export function wrapLine(line: string, width = 60, indent = "    "): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of line.split(" ")) {
    if (cur && (cur + " " + w).length > width) (out.push(cur), (cur = indent + w));
    else cur = cur ? `${cur} ${w}` : w;
  }
  return [...out, cur];
}

export function historyTable(plan: Plan, ledger: Ledger, now: Date): string {
  const { rows, next } = historyRows(plan, ledger, now);
  const head = "period  due         status   amount          tx / note";
  const lines = rows.map((r) => `${String(r.period).padEnd(7)} ${r.due}  ${r.status.padEnd(8)} ${r.amount.padEnd(15)} ${r.tx === "-" ? "" : `${r.tx.slice(0, 10)}…${r.tx.slice(-6)} `}${r.note}`);
  const open = unpaidDue(rows);
  const tail = next ? `next payment: period ${next.period} on ${next.due.slice(0, 10)} (${next.due.slice(11, 16)}Z), ${amountText(plan)} to ${plan.recipient}` : open ? "no later period is scheduled; the plan is not complete until the unpaid ones are paid" : "no further payments: the plan is complete";
  return [`plan ${plan.id}: ${amountText(plan)} ${plan.frequency} to ${plan.recipient}, from ${plan.start.slice(0, 10)}${plan.periods ? `, ${plan.periods} periods` : ""}`, head, ...(lines.length ? lines : ["(nothing due yet)"]), ...(open ? [open] : []), tail].join("\n");
}
