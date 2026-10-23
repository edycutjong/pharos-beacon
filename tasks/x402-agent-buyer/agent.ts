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
import { readState, writeJsonAtomic } from "../../src/lib/state.js";
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
  if (ask > want.maxWorth) return { buy: false, why: "not-worth", text: `${usdc(ask)} is more than this answer is worth to the task (${usdc(want.maxWorth)})` };
  const hit = o.cache.find((c) => covers(want, c, o.now));
  if (hit) return { buy: false, why: "redundant", text: `already bought (${hit.key}, ${routeOf(hit.path)}) and it still answers this: skipping saves ${usdc(ask)}`, saved: ask, from: hit.key };
  const left = policy.budget - o.spent - o.pending;
  if (ask > left) return { buy: false, why: "over-budget", text: `${usdc(ask)} would take the spend to ${usdc(o.spent + o.pending + ask)}, over the budget ${usdc(policy.budget)} (${usdc(left)} left)` };
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
}
export type Journal = Record<string, Purchase>;

export interface PaymentRow {
  n: number;
  at: string;
  task: string;
  key: string;
  endpoint: string;
  bought: string;
  price: string;
  amount: string;
  tx: Hex;
  explorer: string;
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
    // The RPC takes 1,000 blocks per log query; the authorization lives 120 s, so a few windows are plenty.
    for (let i = 0n; i < 4n; i++) {
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
  | { type: "sign"; want: string; key: string; nonce: Hex; price: string }
  | { type: "attempt"; want: string; n: number; error?: string; status?: number }
  | { type: "reconcile"; want: string; nonceUsed: boolean; tx?: Hex; text: string }
  | { type: "paid"; want: string; row: PaymentRow }
  | { type: "already-paid"; want: string; key: string; tx?: Hex }
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

export class Agent {
  readonly o: AgentOptions & Required<Pick<AgentOptions, "retries">>;
  private readonly emit: (e: AgentEvent) => void;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly chain: Chain;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly client: ReturnType<typeof buyerClient>;

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
  private url = (path: string) => `${this.o.base.replace(/\/+$/, "")}${BASE_PATH}/${path}`;
  private get = (path: string, headers: Record<string, string> = {}) => this.fetchFn(this.url(path), { headers: { accept: "application/json", ...this.o.headers, ...headers } });

  /** Total paid in this task, from the payment log. */
  spent = (): bigint => readLog(this.o.logFile).filter((r) => r.task === this.o.task).reduce((s, r) => s + BigInt(r.amount), 0n);
  /** Signed but unresolved authorizations: they may still settle, so they count against the budget. */
  pending = (j = this.journal(), except?: string): bigint => Object.values(j).filter((p) => p.key.startsWith(`${this.o.task}/`) && p.state === "signed" && p.key !== except).reduce((s, p) => s + BigInt(p.amount), 0n);

  private log(p: Purchase, tx: Hex, block: number | undefined, note?: string): PaymentRow {
    const rows = readLog(this.o.logFile);
    // One row per purchase: the same purchase is never logged twice, whatever the retry path.
    const prior = rows.find((r) => r.key === p.key);
    if (prior) return prior;
    const total = this.spent() + BigInt(p.amount);
    const row: PaymentRow = {
      n: rows.length + 1,
      at: new Date(this.now()).toISOString(),
      task: this.o.task,
      key: p.key,
      endpoint: this.url(p.path),
      bought: p.purpose,
      price: usdc(p.amount),
      amount: p.amount,
      tx,
      explorer: explorerTx("atlantic", tx),
      ...(block !== undefined ? { block } : {}),
      runningTotal: usdc(total),
      runningTotalAtomic: total.toString(),
      ...(note ? { note } : {}),
    };
    mkdirSync(dirname(this.o.logFile), { recursive: true });
    appendFileSync(this.o.logFile, `${JSON.stringify(row)}\n`);
    return row;
  }

  /** The answers already bought in this task, newest last. */
  private cache(j: Journal): CachedAnswer[] {
    return Object.values(j).filter((p) => p.state === "paid" && p.data !== undefined && p.key.startsWith(`${this.o.task}/`)).map((p) => ({ key: p.key, path: p.path, at: p.at, data: p.data }));
  }

  /**
   * An unresolved purchase from an earlier send: ask the token whether its nonce was used.
   *   used → it settled; find the tx, log it once (the answer, if we never got it, is gone).
   *   not used and lapsed → it can never settle; the purchase may be signed again with a new nonce.
   *   not used and still valid → it may still settle; the caller re-sends the SAME header.
   */
  private async reconcile(p: Purchase, want: string, j: Journal): Promise<"settled" | "lapsed" | "open"> {
    const used = await this.chain.nonceUsed(p.payer, p.nonce);
    if (used) {
      const s = await this.chain.settlementOf(p.payer, p.nonce);
      this.emit({ type: "reconcile", want, nonceUsed: true, ...(s ? { tx: s.tx } : {}), text: s ? `authorization ${p.nonce.slice(0, 10)}… was used in ${s.tx.slice(0, 12)}…: it settled once` : `authorization ${p.nonce.slice(0, 10)}… was used, settling tx not found in the lookback` });
      if (s) {
        p.tx = s.tx;
        p.block = s.block;
        p.state = p.data !== undefined ? "paid" : "paid-data-lost";
        this.log(p, s.tx, s.block, p.data !== undefined ? undefined : "the response was lost after the API settled; counted once, not bought again");
        this.save(j);
        return "settled";
      }
      return "open";
    }
    if (this.now() / 1000 > p.validBefore) {
      p.state = "expired";
      this.save(j);
      this.emit({ type: "reconcile", want, nonceUsed: false, text: `authorization ${p.nonce.slice(0, 10)}… was never used and has expired: it can no longer be charged` });
      return "lapsed";
    }
    this.emit({ type: "reconcile", want, nonceUsed: false, text: `authorization ${p.nonce.slice(0, 10)}… not used yet and still valid: re-sending the same signature` });
    return "open";
  }

  /** One purchase. Never throws: every outcome is returned. */
  async buy(want: Want): Promise<TaskSummary["results"][number] & { data?: unknown }> {
    const key = idemKey(this.o.task, want.id);
    const j = this.journal();
    let p = j[key];
    const ev = this.emit;
    // 0. This intent already has an outcome (a re-run after a crash or a repeated task).
    if (p?.state === "paid") {
      ev({ type: "already-paid", want: want.id, key, ...(p.tx ? { tx: p.tx } : {}) });
      return { want: want.id, status: "already-paid", price: usdc(p.amount), ...(p.tx ? { tx: p.tx } : {}), data: p.data };
    }
    if (p?.state === "paid-data-lost") {
      ev({ type: "failed", want: want.id, text: `already paid once (${p.tx}) but the answer was lost; not buying it again under the same key` });
      return { want: want.id, status: "paid-data-lost", price: usdc(p.amount), ...(p.tx ? { tx: p.tx } : {}) };
    }
    if (p?.state === "signed") {
      const r = await this.reconcile(p, want.id, j);
      if (r === "settled") return { want: want.id, status: "paid-data-lost", price: usdc(p.amount), tx: p.tx! };
    }

    // 1. Ask. A 402 is free, and tells the price, the asset and the payee.
    let first: Response;
    try {
      first = await this.get(want.path);
    } catch (e) {
      ev({ type: "failed", want: want.id, text: `could not reach the API: ${(e as Error).message}` });
      return { want: want.id, status: "failed" };
    }
    if (first.status !== 402) {
      ev({ type: "failed", want: want.id, text: `expected 402, got ${first.status}` });
      return { want: want.id, status: "failed" };
    }
    const header = first.headers.get("PAYMENT-REQUIRED");
    if (!header) {
      ev({ type: "failed", want: want.id, text: "the 402 has no PAYMENT-REQUIRED header" });
      return { want: want.id, status: "failed" };
    }
    const pr = decodePaymentRequiredHeader(header);
    const ask = pr.accepts[0]!;
    const price = BigInt(ask.amount);
    ev({ type: "ask", want: want.id, path: want.path, price: usdc(price) });

    // 2. Decide.
    const d = decide({ want, ask: price, asset: ask.asset, network: ask.network, spent: this.spent(), pending: this.pending(j, key), policy: this.o.policy, cache: this.cache(j), now: this.now() });
    if (!d.buy) {
      ev({ type: "refused", want: want.id, why: d.why, text: d.text, ...(d.saved ? { saved: usdc(d.saved) } : {}) });
      const hit = d.from ? j[d.from] : undefined;
      return { want: want.id, status: d.why, amount: price.toString(), price: usdc(price), ...(hit ? { data: hit.data } : {}) };
    }

    // 3. Sign ONCE and write it down before it goes out. A lapsed or never-sent earlier authorization is replaced only now.
    if (!p || p.state === "expired" || p.state === "rejected") {
      const payload = await this.client.client.createPaymentPayload(pr);
      const auth = (payload.payload as { authorization: { nonce: Hex; validBefore: string } }).authorization;
      p = {
        key, path: want.path, purpose: want.purpose, state: "signed", amount: ask.amount, nonce: auth.nonce, payer: this.client.address, payTo: getAddress(ask.payTo),
        header: encodePaymentSignatureHeader(payload), validBefore: Number(auth.validBefore), attempts: 0, at: this.now(),
      };
      j[key] = p;
      this.save(j);
      ev({ type: "sign", want: want.id, key, nonce: p.nonce, price: usdc(price) });
    }

    // 4. Send. Every retry re-sends the same signature; between tries the token is asked whether it already settled.
    for (let n = 1; n <= this.o.retries; n++) {
      p.attempts = n;
      this.save(j);
      let res: Response;
      try {
        res = await this.get(want.path, { "PAYMENT-SIGNATURE": p.header });
      } catch (e) {
        ev({ type: "attempt", want: want.id, n, error: (e as Error).message });
        await this.sleep(2 ** n * 250);
        const r = await this.reconcile(p, want.id, j).catch(() => "open" as const);
        if (r === "settled") return { want: want.id, status: "paid-data-lost", price: usdc(p.amount), tx: p.tx! };
        if (r === "lapsed") break;
        continue;
      }
      ev({ type: "attempt", want: want.id, n, status: res.status });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch { /* keep text */ }
      const settle = res.headers.get("PAYMENT-RESPONSE") ? decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!) : undefined;
      if (res.status === 200 && settle?.success && settle.transaction) {
        const tx = settle.transaction as Hex;
        const verdict = matchReceipt(await this.chain.receipt(tx), { token: getAddress(X402_USDC.address), from: p.payer, to: p.payTo, value: BigInt(p.amount) });
        if (!verdict.ok) {
          ev({ type: "failed", want: want.id, text: `the API answered 200 but the receipt check failed: ${verdict.reason}; the data is not accepted` });
          p.state = "rejected";
          this.save(j);
          return { want: want.id, status: "failed", tx };
        }
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
        if (/nonce_already_used/.test(why)) {
          // The first send settled and its answer never reached us: the replay was refused, which is the proof of one payment.
          const r = await this.reconcile(p, want.id, j);
          if (r === "settled") return { want: want.id, status: "paid-data-lost", price: usdc(p.amount), tx: p.tx! };
          ev({ type: "failed", want: want.id, text: `the authorization was used but its transaction was not found: ${why}` });
          return { want: want.id, status: "failed" };
        }
        p.state = "rejected";
        this.save(j);
        ev({ type: "failed", want: want.id, text: `the API refused the payment: ${why}; nothing was charged` });
        return { want: want.id, status: "failed" };
      }
      ev({ type: "failed", want: want.id, text: `HTTP ${res.status} on the paid request` });
      await this.sleep(2 ** n * 250);
    }
    ev({ type: "failed", want: want.id, text: `no confirmed outcome after ${this.o.retries} sends; the signed payment stays in the journal as "${p.state}" and counts against the budget until it is settled or expires` });
    return { want: want.id, status: "failed" };
  }

  /**
   * Run a task. A required want refused for budget stops the task there ("the agent stops because it hit the budget");
   * any other refusal moves on to the next want; the task finishes when every required want has data.
   */
  async run(wants: Want[]): Promise<TaskSummary> {
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
        this.emit({ type: "stopped", want: w.id, text: `stopping: the budget is spent (${usdc(this.spent())} of ${usdc(this.o.policy.budget)}); ${wants.length - results.length} want(s) not attempted` });
      }
    }
    const spent = this.spent();
    const have = (r?: TaskSummary["results"][number]) => r && (r.status === "paid" || r.status === "already-paid" || r.status === "redundant");
    const unmet = wants.filter((w, i) => !w.optional && !have(results[i]));
    const summary: TaskSummary = {
      task: this.o.task,
      outcome: stoppedBy ? "stopped-budget" : unmet.length ? "unfinished" : "finished",
      paid: readLog(this.o.logFile).filter((r) => r.task === this.o.task).length,
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
