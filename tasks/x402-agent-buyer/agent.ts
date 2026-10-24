// x402 Agent Buyer: an agent that pays for what it uses. For each thing it wants it asks the API for the price (a 402 costs
// nothing), decides whether to buy, pays inside a budget, and finishes the job or stops.
//   decide()  pure policy, in this order: per-call cap → worth → already have it (value check) → budget
//   buy()     one purchase: ask → decide → sign once → send (same signature on every retry) → receipt check → log
//   Safe retries (requirement 04): the signed payment is written to the journal BEFORE it is sent, under the purchase's
//   idempotency key. A retry re-sends that same EIP-3009 authorization, never a fresh one, so the chain can settle it at most
//   once (the nonce). If the answer to a send is lost, the next try asks the token (authorizationState) before it signs anything.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { createPublicClient, getAddress, http, parseAbi, parseAbiItem, type Hex, type TransactionReceipt } from "viem";
import { readState, withLock, writeJsonAtomic } from "../../src/lib/state.js";
import { X402_USDC, atlantic, explorerTx } from "../../src/lib/networks.js";
import { buyerClient, matchReceipt } from "../x402-paywalled-api/buyer.js";
import { BASE_PATH, NETWORK, usdc } from "../x402-paywalled-api/config.js";

/** What the agent wants: one question, answered by one route. */
export interface Want {
  /** Stable id inside the task; with the task id it makes the idempotency key. */
  id: string;
  /** Path after the API base path, with its query: "gas-snapshot", "whale-range?blocks=2000". */
  path: string;
  /** What the data is for; written into the payment log as "what it bought". */
  purpose: string;
  /** The most the task will pay for this answer (USDC atomic). Above it the data "is not worth it". */
  maxWorth: bigint;
  /** A required want that cannot be met ends the task as unfinished; an optional one is skipped. */
  optional?: boolean;
  /** For "largest transfers in the last `blocks` blocks": how many of the top transfers the question needs. */
  top?: number;
}

export interface Policy {
  /** Total spend allowed in this task (USDC atomic), counting payments still unresolved. */
  budget: bigint;
  /** The most one call may cost (USDC atomic). */
  perCallCap: bigint;
}

export type Refusal = "over-cap" | "not-worth" | "redundant" | "over-budget" | "wrong-asset";

export type Decision = { buy: true } | { buy: false; why: Refusal; text: string; saved?: bigint; from?: string };

export interface CachedAnswer { key: string; path: string; at: number; data: unknown }

/** Seconds a cached answer may serve a new question. Gas moves fast; mainnet whale history does not. */
export const TTL_MS = { "gas-snapshot": 60_000, "whale-brief": 600_000, "whale-range": 600_000 } as const;

interface WhaleData { blocks?: string; largest?: { block: number; usdc: string }[] }

const routeOf = (path: string) => path.split("?")[0]!;
const blocksOf = (path: string) => Number(new URLSearchParams(path.split("?")[1] ?? "").get("blocks") ?? 1000);

/** The first and last block of a whale answer ("21065300–21067799"). */
const rangeOf = (d: WhaleData): [number, number] | undefined => {
  const m = /^(\d+)[–-](\d+)$/.exec(d.blocks ?? "");
  return m ? [Number(m[1]), Number(m[2])] : undefined;
};

/**
 * Does an answer we already paid for cover this question? (the value check)
 *  - gas-snapshot: the same route inside the TTL.
 *  - whale questions ("the largest transfers in the last N blocks"): a bought whale answer whose range holds the last N blocks
 *    of its own head answers it when at least `top` of its listed transfers lie inside that window. A transfer that is in the
 *    answer's top list and inside the window is also in the window's own top list, so nothing is guessed.
 */
export function covers(want: Pick<Want, "path" | "top">, c: CachedAnswer, now: number): boolean {
  const wr = routeOf(want.path);
  const cr = routeOf(c.path);
  const ttl = TTL_MS[wr as keyof typeof TTL_MS];
  if (ttl === undefined || now - c.at > ttl) return false;
  if (wr === "gas-snapshot") return cr === "gas-snapshot";
  if ((cr !== "whale-brief" && cr !== "whale-range") || (wr !== "whale-brief" && wr !== "whale-range")) return false;
  const d = c.data as WhaleData;
  const range = rangeOf(d);
  if (!range || !Array.isArray(d.largest)) return false;
  const n = wr === "whale-brief" ? 1000 : blocksOf(want.path);
  if (range[1] - range[0] + 1 < n) return false;
  const from = range[1] - n + 1;
  return d.largest.filter((t) => t.block >= from).length >= (want.top ?? 1);
}

/** The policy. Pure: the same inputs always give the same answer. */
export function decide(o: { want: Want; ask: bigint; asset: string; network: string; spent: bigint; pending: bigint; policy: Policy; cache: CachedAnswer[]; now: number }): Decision {
  const { want, ask, policy } = o;
  if (o.asset.toLowerCase() !== X402_USDC.address.toLowerCase() || o.network !== NETWORK)
    return { buy: false, why: "wrong-asset", text: `asks ${o.network} ${o.asset}, not test USDC on ${NETWORK}` };
  if (ask > policy.perCallCap) return { buy: false, why: "over-cap", text: `${usdc(ask)} is over the per-call cap ${usdc(policy.perCallCap)}` };
  if (ask > want.maxWorth) return { buy: false, why: "not-worth", text: `${usdc(ask)} is more than this is worth to the task (${usdc(want.maxWorth)})` };
  const hit = o.cache.find((c) => covers(want, c, o.now));
  if (hit) return { buy: false, why: "redundant", text: `already bought (${hit.key}) and it still answers this: skipping saves ${usdc(ask)}`, saved: ask, from: hit.key };
  const left = policy.budget - o.spent - o.pending;
  if (ask > left) return { buy: false, why: "over-budget", text: `${usdc(ask)} would make the spend ${usdc(o.spent + o.pending + ask)}, over the ${usdc(policy.budget)} budget (${usdc(left)} left)` };
  return { buy: true };
}

// ---------------------------------------------------------------------------------------------------------------- state

export interface Purchase {
  key: string;
  path: string;
  purpose: string;
  /** signed: authorization written, outcome unknown · paid: settled and data in hand · paid-data-lost: settled, answer lost
   *  · expired: the authorization lapsed unsettled (safe to sign again) · rejected: the API refused it. */
  state: "signed" | "paid" | "paid-data-lost" | "expired" | "rejected";
  amount: string;
  nonce: Hex;
  payer: Hex;
  payTo: Hex;
  /** The PAYMENT-SIGNATURE header. Kept in the journal only (never in logs or proofs): it is a bearer authorization until validBefore. */
  header: string;
  validBefore: number;
  attempts: number;
  tx?: Hex;
  block?: number;
  at: number;
  data?: unknown;
  note?: string;
}
export type Journal = Record<string, Purchase>;

export interface PaymentRow {
  n: number;
  at: string;
  task: string;
  /** The purchase's idempotency key, `<task>/<want>`. */
  purchase: string;
  endpoint: string;
  bought: string;
  price: string;
  amount: string;
  /** Absent only when the token says the authorization was used but the settling transaction is outside the lookback. */
  tx?: Hex;
  explorer?: string;
  block?: number;
  runningTotal: string;
  runningTotalAtomic: string;
  note?: string;
}

/** Reads the JSONL payment log; a half-written last line is ignored. */
export function readLog(file: string): PaymentRow[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as PaymentRow];
    } catch {
      return [];
    }
  });
}

// ----------------------------------------------------------------------------------------------------------------- chain

const usdcAbi = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const authUsed = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const rpc = createPublicClient({ chain: atlantic, transport: http(undefined, { retryCount: 4, retryDelay: 700 }) });

export interface Chain {
  /** Has this EIP-3009 authorization been used (or cancelled) on the token? */
  nonceUsed(payer: Hex, nonce: Hex): Promise<boolean>;
  /** The transaction that used it, found from the token's AuthorizationUsed log; undefined when not found in the lookback. */
  settlementOf(payer: Hex, nonce: Hex): Promise<{ tx: Hex; block: number } | undefined>;
  receipt(tx: Hex): Promise<TransactionReceipt>;
}

export const atlanticChain: Chain = {
  nonceUsed: (payer, nonce) => rpc.readContract({ address: getAddress(X402_USDC.address), abi: usdcAbi, functionName: "authorizationState", args: [payer, nonce] }),
  async settlementOf(payer, nonce) {
    const latest = await rpc.getBlockNumber();
    // The RPC takes 1,000 blocks per log query; an authorization lives a few minutes, so a few windows are plenty.
    for (let i = 0n; i < 8n; i++) {
      const toBlock = latest - i * 1000n;
      const logs = await rpc.getLogs({ address: getAddress(X402_USDC.address), event: authUsed, args: { authorizer: payer, nonce }, fromBlock: toBlock - 999n, toBlock });
      if (logs[0]) return { tx: logs[0].transactionHash, block: Number(logs[0].blockNumber) };
    }
    return undefined;
  },
  receipt: (hash) => rpc.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: 30_000 }),
};

// ---------------------------------------------------------------------------------------------------------------- agent

export type AgentEvent =
  | { type: "task"; task: string; budget: string; perCallCap: string; wants: number; base: string; payer: Hex }
  | { type: "ask"; want: string; path: string; price: string }
  | { type: "refused"; want: string; why: Refusal; text: string; saved?: string }
  | { type: "sign"; want: string; purchase: string; nonce: Hex; price: string }
  | { type: "attempt"; want: string; n: number; error?: string; status?: number; body?: string }
  | { type: "reconcile"; want: string; nonceUsed: boolean; tx?: Hex; text: string }
  | { type: "paid"; want: string; row: PaymentRow }
  | { type: "already-paid"; want: string; purchase: string; tx?: Hex }
  | { type: "failed"; want: string; text: string }
  | { type: "stopped"; want: string; text: string }
  | { type: "done"; summary: TaskSummary };

export interface TaskSummary {
  task: string;
  outcome: "finished" | "stopped-budget" | "unfinished";
  paid: number;
  refused: number;
  spent: string;
  spentAtomic: string;
  saved: string;
  budget: string;
  left: string;
  results: { want: string; amount?: string; status: "paid" | "already-paid" | "redundant" | "over-cap" | "not-worth" | "over-budget" | "failed" | "paid-data-lost" | "not-attempted" | "wrong-asset"; price?: string; tx?: Hex }[];
}

export interface AgentOptions {
  task: string;
  base: string;
  key: Hex;
  policy: Policy;
  logFile: string;
  journalFile: string;
  emit?: (e: AgentEvent) => void;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  chain?: Chain;
  /** Sends of the same signed payment per purchase. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const reasonOf = (body: unknown, pr?: PaymentRequired) => (body as { reason?: string } | null)?.reason ?? pr?.error ?? "payment required";
const idemKey = (task: string, id: string) => `${task}/${id}`;
/** Seconds past validBefore before an unused authorization counts as lapsed (clock skew, a transaction still being mined). */
const LAPSE_MARGIN_S = 60;
/** The longest authorization lifetime the agent will sign: a seller cannot make it sign a payment that stays open for hours. */
const MAX_AUTH_LIFETIME_S = 900;

export class Agent {
  readonly o: AgentOptions & Required<Pick<AgentOptions, "retries">>;
  private readonly emit: (e: AgentEvent) => void;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly chain: Chain;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly client: ReturnType<typeof buyerClient>;
  /** buy() calls run one at a time in this process, so spent + pending is never read by two purchases at once. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(o: AgentOptions) {
    this.o = { retries: 3, ...o };
    this.emit = o.emit ?? (() => undefined);
    this.fetchFn = o.fetch ?? globalThis.fetch;
    this.chain = o.chain ?? atlanticChain;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.client = buyerClient(o.key);
  }

  private journal = (): Journal => readState<Journal>(this.o.journalFile, {});
  private save = (j: Journal) => writeJsonAtomic(this.o.journalFile, j);
  private url = (path: string) => (/^https?:\/\//.test(path) ? path : `${this.o.base.replace(/\/+$/, "")}${BASE_PATH}/${path}`);
  private get = (path: string, headers: Record<string, string> = {}) => this.fetchFn(this.url(path), { headers: { accept: "application/json", ...this.o.headers, ...headers } });
  /** Past validBefore plus a minute of margin for clock skew and a transaction still in a block's making. */
  private lapsed = (p: Purchase) => this.now() / 1000 > p.validBefore + LAPSE_MARGIN_S;

  /** Total paid in this ledger (its payment log): a budget scopes the ledger, not one task. */
  spent = (): bigint => readLog(this.o.logFile).reduce((s, r) => s + BigInt(r.amount), 0n);
  /** Signed but unresolved authorizations (also ones the API refused, until they lapse): they may still settle, so they count against the budget. */
  pending = (j = this.journal(), except?: string): bigint =>
    Object.values(j).filter((p) => p.key !== except && (p.state === "signed" || (p.state === "rejected" && !this.lapsed(p)))).reduce((s, p) => s + BigInt(p.amount), 0n);

  private log(p: Purchase, tx: Hex | undefined, block: number | undefined, note?: string): PaymentRow {
    const rows = readLog(this.o.logFile);
    // One row per purchase: the same purchase is never logged twice, whatever the retry path.
    const prior = rows.find((r) => r.purchase === p.key);
    if (prior) return prior;
    const total = this.spent() + BigInt(p.amount);
    const row: PaymentRow = {
      n: rows.length + 1,
      at: new Date(this.now()).toISOString(),
      task: this.o.task,
      purchase: p.key,
      endpoint: this.url(p.path),
      bought: p.purpose,
      price: usdc(p.amount),
      amount: p.amount,
      ...(tx ? { tx, explorer: explorerTx("atlantic", tx) } : {}),
      ...(block !== undefined ? { block } : {}),
      runningTotal: usdc(total),
      runningTotalAtomic: total.toString(),
      ...(note ? { note } : {}),
    };
    mkdirSync(dirname(this.o.logFile), { recursive: true });
    // A crash can leave a half-written last line: start the new row on a line of its own.
    const open = (() => { try { const t = readFileSync(this.o.logFile, "utf8"); return t.length > 0 && !t.endsWith("\n"); } catch { return false; } })();
    appendFileSync(this.o.logFile, `${open ? "\n" : ""}${JSON.stringify(row)}\n`);
    return row;
  }

  /** The answers already bought in this ledger. */
  private cache(j: Journal): CachedAnswer[] {
    return Object.values(j).filter((p) => p.state === "paid" && p.data !== undefined).map((p) => ({ key: p.key, path: p.path, at: p.at, data: p.data }));
  }

  /**
   * An unresolved purchase: ask the token whether its nonce was used.
   *   used → it settled; log it once (with the tx found from the AuthorizationUsed event; the answer, if never received, is gone).
   *   not used and lapsed → it can never settle; the purchase may be signed again with a new nonce.
   *   not used and still valid → it may still settle; the caller re-sends the SAME header, or waits.
   */
  private async reconcile(p: Purchase, want: string, j: Journal): Promise<"settled" | "lapsed" | "open"> {
    const used = await this.chain.nonceUsed(p.payer, p.nonce);
    if (used) {
      const s = await this.chain.settlementOf(p.payer, p.nonce);
      this.emit({ type: "reconcile", want, nonceUsed: true, ...(s ? { tx: s.tx } : {}), text: s ? `authorization ${p.nonce.slice(0, 10)}… was used in ${s.tx.slice(0, 12)}…: it settled once` : `authorization ${p.nonce.slice(0, 10)}… was used; the settling tx is outside the lookback, logged without one` });
      p.tx = s?.tx;
      p.block = s?.block;
      p.state = p.data !== undefined ? "paid" : "paid-data-lost";
      this.log(p, s?.tx, s?.block, p.data !== undefined ? undefined : `the response was lost after the API settled; counted once, not bought again${s ? "" : " (tx not found in the lookback)"}`);
      this.save(j);
      return "settled";
    }
    if (this.lapsed(p)) {
      p.state = "expired";
      this.save(j);
      this.emit({ type: "reconcile", want, nonceUsed: false, text: `authorization ${p.nonce.slice(0, 10)}… was never used and has expired: it can no longer be charged` });
      return "lapsed";
    }
    this.emit({ type: "reconcile", want, nonceUsed: false, text: `authorization ${p.nonce.slice(0, 10)}… not used yet and still valid` });
    return "open";
  }

  /**
   * Before a new decision: every other unresolved purchase in the ledger is checked against the token (best effort), so a
   * payment that settled is in the log and a lapsed unused authorization stops counting against the budget.
   */
  private async settleOld(j: Journal, except: string): Promise<void> {
    for (const q of Object.values(j)) {
      if (q.key === except || (q.state !== "signed" && q.state !== "rejected")) continue;
      await this.reconcile(q, q.key.split("/").pop()!, j).catch(() => undefined);
    }
  }

  /** One purchase. Never throws: every outcome is returned. Purchases run one at a time. */
  buy(want: Want): Promise<TaskSummary["results"][number] & { data?: unknown }> {
    const next = this.tail.then(() => this.buyOne(want));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async buyOne(want: Want): Promise<TaskSummary["results"][number] & { data?: unknown }> {
    try {
      return await this.purchase(want);
    } catch (e) {
      const text = `unexpected error: ${(e as Error).message}; any signed payment stays in the journal and counts against the budget until it is settled or lapses`;
      this.emit({ type: "failed", want: want.id, text });
      return { want: want.id, status: "failed" };
    }
  }

  private async purchase(want: Want): Promise<TaskSummary["results"][number] & { data?: unknown }> {
    const key = idemKey(this.o.task, want.id);
    const j = this.journal();
    let p = j[key];
    const ev = this.emit;
    const fail = (text: string, extra: Partial<TaskSummary["results"][number]> = {}) => {
      ev({ type: "failed", want: want.id, text });
      return { want: want.id, status: "failed" as const, ...extra };
    };
    // 0. This intent already has an outcome (a re-run after a crash or a repeated task).
    if (p && p.path !== want.path && p.state !== "expired") return fail(`key ${key} was used for another question (${p.path}); not reusing it for ${want.path}`);
    if (p?.state === "paid") {
      ev({ type: "already-paid", want: want.id, purchase: key, ...(p.tx ? { tx: p.tx } : {}) });
      return { want: want.id, status: "already-paid", price: usdc(p.amount), ...(p.tx ? { tx: p.tx } : {}), data: p.data };
    }
    if (p?.state === "paid-data-lost") {
      ev({ type: "failed", want: want.id, text: `already paid once${p.tx ? ` (${p.tx})` : ""} but the answer was lost; not buying it again under the same key` });
      return { want: want.id, status: "paid-data-lost", price: usdc(p.amount), ...(p.tx ? { tx: p.tx } : {}) };
    }
    if (p?.state === "signed" || p?.state === "rejected") {
      const r = await this.reconcile(p, want.id, j);
      if (r === "settled") return { want: want.id, status: "paid-data-lost", price: usdc(p.amount), ...(p.tx ? { tx: p.tx } : {}) };
      if (r === "open" && p.state === "rejected") return fail(`the API refused the earlier payment for this purchase and its authorization is still valid until ${new Date(p.validBefore * 1000).toISOString()}; not signing a second one before it lapses`);
    }

    // 1. Ask. A 402 is free, and tells the price, the asset and the payee.
    let first: Response;
    try {
      first = await this.get(want.path);
    } catch (e) {
      return fail(`could not reach the API: ${(e as Error).message}`);
    }
    if (first.status !== 402) return fail(`expected 402, got ${first.status}`);
    const header = first.headers.get("PAYMENT-REQUIRED");
    if (!header) return fail("the 402 has no PAYMENT-REQUIRED header");
    const pr = decodePaymentRequiredHeader(header);
    const ask = pr.accepts.find((a) => a.network === NETWORK && a.asset.toLowerCase() === X402_USDC.address.toLowerCase()) ?? pr.accepts[0];
    if (!ask) return fail("the 402 offers no way to pay");
    const price = BigInt(ask.amount);
    ev({ type: "ask", want: want.id, path: want.path, price: usdc(price) });

    // 2. Decide, with the ledger as current as the chain can make it.
    await this.settleOld(j, key);
    const d = decide({ want, ask: price, asset: ask.asset, network: ask.network, spent: this.spent(), pending: this.pending(j, key), policy: this.o.policy, cache: this.cache(j), now: this.now() });
    if (!d.buy) {
      ev({ type: "refused", want: want.id, why: d.why, text: d.text, ...(d.saved ? { saved: usdc(d.saved) } : {}) });
      const hit = d.from ? j[d.from] : undefined;
      return { want: want.id, status: d.why, amount: price.toString(), price: usdc(price), ...(hit ? { data: hit.data } : {}) };
    }
    if (p?.state === "signed" && p.amount !== ask.amount) return fail(`the price changed from ${usdc(p.amount)} to ${usdc(price)} since the payment was signed; waiting for the old authorization to lapse`);

    // 3. Sign ONCE and write it down before it goes out. A lapsed earlier authorization is replaced only now.
    if (!p || p.state === "expired" || p.state === "rejected") {
      const payload = await this.client.client.createPaymentPayload({ ...pr, accepts: [ask] });
      const auth = (payload.payload as { authorization: { nonce: Hex; value: string; to: string; validBefore: string } }).authorization;
      // The cap and the budget were checked against the quote: what is signed must be exactly the quote, to the quoted payee.
      if (auth.value !== ask.amount || getAddress(auth.to) !== getAddress(ask.payTo)) return fail("the signed authorization does not match the quote; not sending it");
      if (Number(auth.validBefore) > this.now() / 1000 + MAX_AUTH_LIFETIME_S) return fail(`the API asks for an authorization valid longer than ${MAX_AUTH_LIFETIME_S} s; not signing it`);
      p = {
        key, path: want.path, purpose: want.purpose, state: "signed", amount: ask.amount, nonce: auth.nonce, payer: this.client.address, payTo: getAddress(ask.payTo),
        header: encodePaymentSignatureHeader(payload), validBefore: Number(auth.validBefore), attempts: 0, at: this.now(),
      };
      j[key] = p;
      this.save(j);
      ev({ type: "sign", want: want.id, purchase: key, nonce: p.nonce, price: usdc(price) });
    }

    // 4. Send. Every retry re-sends the same signature; after a network error the token is asked whether it already settled.
    for (let n = 1; n <= this.o.retries; n++) {
      p.attempts = n;
      this.save(j);
      let res: Response;
      try {
        res = await this.get(want.path, { "PAYMENT-SIGNATURE": p.header });
      } catch (e) {
        ev({ type: "attempt", want: want.id, n, error: (e as Error).message });
        await this.sleep(2 ** n * 250);
        const r = await this.reconcile(p, want.id, j).catch(() => "unknown" as const);
        if (r === "settled") return { want: want.id, status: "paid-data-lost", price: usdc(p.amount), ...(p.tx ? { tx: p.tx } : {}) };
        if (r === "lapsed") break;
        continue;
      }
      const text = await res.text();
      ev({ type: "attempt", want: want.id, n, status: res.status, ...(res.status === 200 ? {} : { body: text.slice(0, 240) }) });
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch { /* keep text */ }
      const settle = res.headers.get("PAYMENT-RESPONSE") ? decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!) : undefined;
      if (res.status === 200 && settle?.success && settle.transaction) {
        const tx = settle.transaction as Hex;
        let verdict: ReturnType<typeof matchReceipt>;
        if (readLog(this.o.logFile).some((r) => r.tx === tx)) return fail(`the API named a transaction already in the log (${tx}) as this payment; not accepted`);
        try {
          verdict = matchReceipt(await this.chain.receipt(tx), { token: getAddress(X402_USDC.address), from: p.payer, to: p.payTo, value: BigInt(p.amount) });
        } catch (e) {
          // No receipt yet: the payment stays pending (counted against the budget); a re-run reconciles it from the chain.
          return fail(`the API answered 200 (tx ${tx}) but its receipt could not be read: ${(e as Error).message}; the payment stays pending`, { tx });
        }
        if (!verdict.ok) {
          if (verdict.status === "reverted") {
            p.state = "rejected";
            this.save(j);
            return fail(`the API answered 200 but the settle transaction reverted: nothing moved; the data is not accepted`, { tx });
          }
          // Mined, but not the payment we signed: money may have moved, so it is counted, and the data is not accepted.
          p.state = "paid-data-lost";
          p.tx = tx;
          this.log(p, tx, verdict.block, `receipt check failed (${verdict.reason}); counted as spent, data not accepted`);
          this.save(j);
          return fail(`the API answered 200 but the receipt check failed: ${verdict.reason}; the data is not accepted and the payment is counted as spent`, { tx });
        }
        // The receipt must be of OUR authorization: a seller could name an old transaction of the same price.
        const ours = await this.chain.nonceUsed(p.payer, p.nonce).catch(() => undefined);
        if (ours !== true) return fail(`the receipt matches the price but the token does not show our authorization as used${ours === undefined ? " (could not check)" : ""}; the data is not accepted and the payment stays pending`, { tx });
        p.state = "paid";
        p.tx = tx;
        p.block = verdict.block;
        p.data = body;
        const row = this.log(p, tx, verdict.block);
        this.save(j);
        ev({ type: "paid", want: want.id, row });
        return { want: want.id, status: "paid", price: usdc(p.amount), tx, data: body };
      }
      if (res.status === 402) {
        const why = reasonOf(body);
        const r = await this.reconcile(p, want.id, j).catch(() => "unknown" as const);
        if (r === "settled") return { want: want.id, status: "paid-data-lost", price: usdc(p.amount), ...(p.tx ? { tx: p.tx } : {}) };
        if (r === "lapsed") return fail(`the API refused the payment: ${why}; the authorization was never used and has lapsed, so nothing was charged`);
        // The 402 does not say it was not charged: the token does. Unused, so nothing moved; the authorization still counts until it lapses.
        p.state = "rejected";
        this.save(j);
        return fail(r === "unknown" ? `the API refused the payment: ${why}; the token could not be checked, so the authorization stays counted until it lapses` : `the API refused the payment: ${why}; the token shows the authorization unused, so nothing was charged`);
      }
      ev({ type: "failed", want: want.id, text: `HTTP ${res.status} on the paid request` });
      await this.sleep(2 ** n * 250);
    }
    // No clear answer: the token decides whether the payment happened.
    const last = await this.reconcile(p, want.id, j).catch(() => "unknown" as const);
    if (last === "settled") return { want: want.id, status: "paid-data-lost", price: usdc(p.amount), ...(p.tx ? { tx: p.tx } : {}) };
    return fail(p.state === "signed" ? `no confirmed outcome after ${this.o.retries} sends; the signed payment stays in the journal and counts against the budget until it settles or lapses` : `no confirmed outcome after ${this.o.retries} sends; the authorization lapsed unused, so nothing was charged`);
  }

  /**
   * Run a task (one run per ledger at a time: a second run fails at once on the lock file). A required want refused for
   * budget stops the task there ("the agent stops because it hit the budget"); any other refusal moves on to the next
   * want; the task finishes when every required want has data.
   */
  run(wants: Want[]): Promise<TaskSummary> {
    return withLock(this.o.journalFile, () => this.runLocked(wants));
  }

  private async runLocked(wants: Want[]): Promise<TaskSummary> {
    this.emit({ type: "task", task: this.o.task, budget: usdc(this.o.policy.budget), perCallCap: usdc(this.o.policy.perCallCap), wants: wants.length, base: this.o.base, payer: this.client.address });
    const results: TaskSummary["results"] = [];
    let stoppedBy: string | undefined;
    let saved = 0n;
    for (const w of wants) {
      if (stoppedBy) {
        results.push({ want: w.id, status: "not-attempted" });
        continue;
      }
      const r = await this.buy(w);
      const { data: _d, ...row } = r;
      results.push(row);
      if (r.status === "redundant" && r.amount) saved += BigInt(r.amount);
      if (r.status === "over-budget" && !w.optional) {
        stoppedBy = w.id;
        this.emit({ type: "stopped", want: w.id, text: `stopping: "${w.id}" does not fit the budget (${usdc(this.spent())} spent of ${usdc(this.o.policy.budget)}); ${wants.length - results.length} want(s) not attempted` });
      }
    }
    const spent = this.spent();
    const have = (r?: TaskSummary["results"][number]) => r && (r.status === "paid" || r.status === "already-paid" || r.status === "redundant");
    const unmet = wants.filter((w, i) => !w.optional && !have(results[i]));
    const summary: TaskSummary = {
      task: this.o.task,
      outcome: stoppedBy ? "stopped-budget" : unmet.length ? "unfinished" : "finished",
      paid: readLog(this.o.logFile).length,
      refused: results.filter((r) => ["over-cap", "not-worth", "over-budget", "redundant", "wrong-asset"].includes(r.status)).length,
      spent: usdc(spent),
      spentAtomic: spent.toString(),
      saved: usdc(saved),
      budget: usdc(this.o.policy.budget),
      left: usdc(this.o.policy.budget - spent),
      results,
    };
    this.emit({ type: "done", summary });
    return summary;
  }
}
