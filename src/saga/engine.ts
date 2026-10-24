import type { Hex } from "viem";
import { readState, writeState } from "../lib/state.js";

// A saga: ordered, dependent on-chain actions. Each action is signed, journaled, sent, waited for and VERIFIED (receipt
// checked, then the state it should have produced is read back) before the next one starts. A transient failure is retried
// with backoff and a higher fee on the same nonce; a permanent one rolls the saga back by running the undo actions of every
// step that landed, newest first. Every transition is written to the journal before the next thing happens, so a killed
// process resumes from the journal and never repeats a step that is done.

export interface TxFields {
  to: Hex;
  value: bigint;
  data: Hex;
}

/** What the engine needs from the chain; src/saga/port.ts builds it from the Chain MCP + the testnet signer. */
export interface Rcpt {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice?: bigint;
  logs: { address: Hex; topics: Hex[]; data: Hex }[];
}

export interface SignedFields {
  hash: Hex;
  raw: Hex;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
}

export interface Port {
  /** Fill gas by estimate_gas (a revert throws), nonce (`nonce` if given) and fees (`minFee`: at least this max fee), then sign. */
  sign(tx: TxFields, o: { nonce?: number; minMaxFee?: bigint; maxFeeOverride?: bigint }): Promise<SignedFields>;
  /** Send the signed bytes. Resolves when the node took the tx; throws a classified error otherwise. */
  broadcast(s: SignedFields): Promise<void>;
  /** The mined receipt, or null while there is none. */
  receipt(hash: Hex): Promise<Rcpt | null>;
  /** Does the node know the tx (pending or mined)? */
  known(hash: Hex): Promise<boolean>;
  /** Poll for the receipt up to `timeoutMs`; null on timeout. */
  waitReceipt(hash: Hex, timeoutMs: number): Promise<Rcpt | null>;
  /** eth_call: the raw return data. */
  call(to: Hex, data: Hex): Promise<Hex>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export type Phase = "forward" | "undo";
export type ActionState = "pending" | "running" | "verified" | "skipped" | "failed";

export interface AttemptRec {
  n: number;
  hash: Hex;
  raw: Hex;
  nonce: number;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  state: "signed" | "sent" | "not-sent" | "refused" | "mined" | "reverted" | "timeout" | "replaced";
  note?: string;
  gasUsed?: string;
  blockNumber?: string;
}

export interface ActionRec {
  id: string;
  phase: Phase;
  /** The forward step this belongs to (a forward action: itself; an undo action: the step it reverses). */
  step: string;
  title: string;
  state: ActionState;
  /** A successful receipt was seen: the effect is on chain, so a rollback must reverse it. */
  landed?: boolean;
  attempts: AttemptRec[];
  detail?: string;
  failure?: { kind: "transient-exhausted" | "revert" | "rejected" | "verify"; reason: string };
}

export interface LogEntry {
  t: string;
  action: string;
  event: string;
  detail?: string;
}

export type SagaStatus = "running" | "completed" | "compensating" | "rolled-back" | "stuck";

export interface Journal {
  version: 1;
  id: string;
  network: "atlantic";
  wallet: Hex;
  /** The saga's parameters as strings (bigints serialized), so a resume rebuilds the same definition. */
  params: Record<string, string>;
  status: SagaStatus;
  startedAt: string;
  updatedAt: string;
  /** Reads before the first action: what a rollback must restore. */
  snapshot: Record<string, string>;
  /** Values later actions depend on (e.g. the swap output). */
  data: Record<string, string>;
  actions: ActionRec[];
  log: LogEntry[];
  failedAt?: string;
  checks?: { name: string; expected: string; after: string; ok: boolean }[];
}

export interface Ctx {
  port: Port;
  j: Journal;
  /** The wallet's reads for the definitions (eth_call etc.). */
  data(key: string): string | undefined;
  setData(key: string, value: string): void;
}

export interface ActionDef {
  id: string;
  phase: Phase;
  step: string;
  title: string;
  /** The transaction, or null when the state it would produce already holds (the action is then skipped). Reads chain state. */
  intent(c: Ctx): Promise<TxFields | null>;
  /** After a successful receipt: read the chain and prove the action did what it says. */
  verify(c: Ctx, rcpt: Rcpt): Promise<{ ok: boolean; detail: string }>;
  /** Before the first send: record what verify compares against. */
  before?(c: Ctx): Promise<void>;
}

export interface SagaDef {
  forward: ActionDef[];
  /** The undo actions for one forward step, in the order they run. */
  undo(step: string): ActionDef[];
  snapshot(c: Ctx): Promise<Record<string, string>>;
  /** After a completed or rolled-back saga: compare the chain with the snapshot. */
  check(c: Ctx, outcome: "completed" | "rolled-back"): Promise<NonNullable<Journal["checks"]>>;
}

export interface RetryPolicy {
  /** Sends per action, the first included. */
  maxAttempts: number;
  /** Wait before attempt n+1: backoffMs × 2^(n-1). */
  backoffMs: number;
  /** A fee bump of this many percent over the previous attempt's max fee (replacement transactions need ≥ 10%). */
  bumpPercent: number;
  receiptTimeoutMs: number;
}

export const DEFAULT_POLICY: RetryPolicy = { maxAttempts: 3, backoffMs: 2_000, bumpPercent: 25, receiptTimeoutMs: 30_000 };

export type CrashPoint = "signed" | "sent" | "mined";
export type Inject = { kind: "underpriced" | "drop"; action: string } | { kind: "crash"; action: string; point: CrashPoint };

/** Thrown by a test's crash hook; the CLI's hook kills the process instead. */
export class CrashInjected extends Error {
  override name = "CrashInjected";
}

export interface EngineOptions {
  policy?: RetryPolicy;
  inject?: Inject[];
  /** Called at an injected crash point. The CLI sends SIGKILL to itself; tests throw CrashInjected. */
  crash?: (action: string, point: CrashPoint) => never;
  /** Heard for every journal log line (the CLI prints it). */
  onLog?: (e: LogEntry) => void;
}

// ---------------------------------------------------------------- failure classification

export type Failure = "transient" | "permanent";

/** Node answers that mean "try again, maybe with more fee": a spike, a dropped or refused-for-now transaction, a throttled RPC. */
const TRANSIENT =
  /underpriced|less than base fee|below (the )?base fee|fee cap|max fee|gas price (is )?too low|replacement|already known|mempool|txpool|timed? ?out|timeout|etimedout|econnreset|econnrefused|fetch failed|socket|429|rate.?limit|too many requests|temporar|unavailable|50[0234]\b|dropped|evicted|not found in (the )?pool/i;
const REVERT = /revert|execution reverted|invalid opcode|out of gas|insufficient (funds|allowance|balance)|exceeds allowance|exceeds balance/i;

/** A revert (code 3 or its text) is permanent: sending it again fails the same way. Known transient texts are retried. Anything else fails closed (permanent). */
export function classify(e: unknown): Failure {
  const text = e instanceof Error ? `${e.message} ${String((e as { reason?: unknown }).reason ?? "")}` : String(e);
  const code = (e as { code?: unknown }).code;
  if (code === 3 || REVERT.test(text)) return "permanent";
  if (TRANSIENT.test(text)) return "transient";
  return "permanent";
}

// ---------------------------------------------------------------- journal

export function newJournal(init: Pick<Journal, "id" | "wallet" | "params">, defs: ActionDef[], now: Date): Journal {
  return {
    version: 1,
    ...init,
    network: "atlantic",
    status: "running",
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    snapshot: {},
    data: {},
    actions: defs.map((d) => ({ id: d.id, phase: d.phase, step: d.step, title: d.title, state: "pending", attempts: [] })),
    log: [],
  };
}

export function loadJournal(file: string): Journal | undefined {
  return readState<Journal | undefined>(file, undefined, (v) => {
    const j = v as Journal;
    if (j?.version !== 1 || !Array.isArray(j.actions) || typeof j.id !== "string") throw new Error(`${file} is not a saga journal; refusing to guess`);
    return j;
  });
}

export function stepNumber(j: Journal, action: ActionRec): string {
  const fwd = j.actions.filter((a) => a.phase === "forward");
  const i = fwd.findIndex((a) => a.id === action.step);
  return `${i + 1}/${fwd.length}`;
}

// ---------------------------------------------------------------- the runner

export class Saga {
  private readonly policy: RetryPolicy;
  private readonly inject: Inject[];

  constructor(
    private readonly def: SagaDef,
    readonly j: Journal,
    private readonly port: Port,
    private readonly file: string,
    private readonly opts: EngineOptions = {},
  ) {
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.inject = opts.inject ?? [];
  }

  private get ctx(): Ctx {
    return { port: this.port, j: this.j, data: (k) => this.j.data[k], setData: (k, v) => void (this.j.data[k] = v) };
  }

  private save(): void {
    this.j.updatedAt = this.port.now().toISOString();
    writeState(this.file, this.j);
  }

  private log(action: string, event: string, detail?: string): void {
    const e: LogEntry = { t: this.port.now().toISOString(), action, event, ...(detail ? { detail } : {}) };
    this.j.log.push(e);
    this.save();
    this.opts.onLog?.(e);
  }

  private injected(kind: "underpriced" | "drop", action: string, attempt: number): boolean {
    return attempt === 1 && this.inject.some((i) => i.kind === kind && i.action === action);
  }

  private crashAt(action: string, point: CrashPoint): void {
    if (this.inject.some((i) => i.kind === "crash" && i.action === action && i.point === point)) {
      this.log(action, "INJECTED-CRASH", `process killed at ${point}`);
      (this.opts.crash ?? ((): never => { throw new CrashInjected(`${action}:${point}`); }))(action, point);
    }
  }

  private defOf(rec: ActionRec): ActionDef {
    const d = rec.phase === "forward" ? this.def.forward.find((x) => x.id === rec.id) : this.def.undo(rec.step).find((x) => x.id === rec.id);
    if (!d) throw new Error(`journal action ${rec.id} has no definition; the saga changed since it started`);
    return d;
  }

  /** Run (or resume) the saga to a terminal status. */
  async run(): Promise<Journal> {
    const j = this.j;
    if (j.status === "completed" || j.status === "rolled-back" || j.status === "stuck") return j;
    if (Object.keys(j.snapshot).length === 0) {
      j.snapshot = await this.def.snapshot(this.ctx);
      this.log("saga", "STARTED", `saga ${j.id}: ${j.actions.filter((a) => a.phase === "forward").map((a) => a.id).join(" → ")}`);
    } else {
      this.log("saga", "RESUMED", `from the journal, status ${j.status}`);
    }

    if (j.status === "running") {
      for (const rec of j.actions.filter((a) => a.phase === "forward")) {
        if (rec.state === "verified" || rec.state === "skipped") continue; // done: never repeated
        const ok = await this.runAction(rec);
        if (!ok) {
          j.failedAt = rec.id;
          j.status = "compensating";
          this.log("saga", "COMPENSATING", `step ${rec.id} failed permanently (${rec.failure?.kind}): rolling back what landed`);
          break;
        }
      }
      if (j.status === "running") {
        j.status = "completed";
        this.log("saga", "COMPLETED", "every step verified");
        j.checks = await this.def.check(this.ctx, "completed");
        this.save();
        return j;
      }
    }

    if (j.status === "compensating") return this.compensate();
    return j;
  }

  private async compensate(): Promise<Journal> {
    const j = this.j;
    // Undo actions are created once, newest forward step first, and kept in the journal so a resume continues the same plan.
    if (!j.actions.some((a) => a.phase === "undo")) {
      const toUndo = j.actions.filter((a) => a.phase === "forward" && (a.state === "verified" || a.landed)).reverse();
      for (const f of toUndo) {
        for (const u of this.def.undo(f.id)) j.actions.push({ id: u.id, phase: "undo", step: f.id, title: u.title, state: "pending", attempts: [] });
      }
      this.log("saga", "ROLLBACK-PLAN", toUndo.length ? `undo ${toUndo.map((a) => a.id).join(", ")} (newest first)` : "nothing landed, nothing to undo");
    }
    for (const rec of j.actions.filter((a) => a.phase === "undo")) {
      if (rec.state === "verified" || rec.state === "skipped") continue;
      if (!(await this.runAction(rec))) {
        j.status = "stuck";
        this.log("saga", "STUCK", `rollback action ${rec.id} failed permanently: ${rec.failure?.reason}. Funds may be stranded mid-saga; see the journal`);
        return j;
      }
    }
    j.status = "rolled-back";
    j.checks = await this.def.check(this.ctx, "rolled-back");
    const bad = j.checks.filter((c) => !c.ok);
    this.log("saga", "ROLLED-BACK", bad.length ? `balance invariant FAILED for ${bad.map((c) => c.name).join(", ")}` : `balance invariant holds for all ${j.checks.length} reads`);
    if (bad.length) j.status = "stuck";
    this.save();
    return j;
  }

  /** One action to a verified/skipped state (true) or a permanent failure (false). */
  private async runAction(rec: ActionRec): Promise<boolean> {
    const d = this.defOf(rec);
    const where = `step ${stepNumber(this.j, rec)}${rec.phase === "undo" ? " undo" : ""} ${rec.id}`;
    const ctx = this.ctx;
    rec.state = "running";
    this.log(rec.id, "RUNNING", `${where}: ${rec.title}`);

    // An attempt already journaled (the process was killed mid-action): settle it before doing anything new.
    const last = rec.attempts.at(-1);
    let pendingAttempt = last && ["signed", "sent", "timeout", "not-sent"].includes(last.state) ? last : undefined;

    if (!pendingAttempt) {
      if (!rec.attempts.length) await d.before?.(ctx);
      const intent = await d.intent(ctx);
      if (intent === null) {
        rec.state = "skipped";
        rec.detail = "the state this would produce already holds";
        this.log(rec.id, "SKIPPED", rec.detail);
        return true;
      }
      this.intents.set(rec.id, intent);
      this.save();
    }

    for (;;) {
      const attemptNo = rec.attempts.length + (pendingAttempt ? 0 : 1);
      let att = pendingAttempt;
      pendingAttempt = undefined;
      let rcpt: Rcpt | null = null;

      if (att) {
        rcpt = await this.settle(rec, att);
      } else {
        const intent = this.intents.get(rec.id) ?? (await d.intent(ctx));
        if (intent === null) {
          rec.state = "skipped";
          rec.detail = "the state this would produce already holds";
          this.log(rec.id, "SKIPPED", rec.detail);
          return true;
        }
        const prev = [...rec.attempts].reverse().find((a) => a.raw !== "0x");
        let signed: SignedFields;
        try {
          const o: { nonce?: number; minMaxFee?: bigint; maxFeeOverride?: bigint } = {};
          if (prev) {
            o.nonce = prev.nonce;
            o.minMaxFee = (BigInt(prev.maxFeePerGas) * BigInt(100 + this.policy.bumpPercent) + 99n) / 100n;
          }
          if (this.injected("underpriced", rec.id, attemptNo)) o.maxFeeOverride = 1n;
          signed = await this.port.sign(intent, o);
        } catch (e) {
          // Failed before anything was signed: nothing is on chain. A revert is permanent (the simulation refused it).
          const kind = classify(e);
          const reason = reasonOf(e);
          rec.attempts.push({ n: attemptNo, hash: "0x", raw: "0x", nonce: -1, gas: "0", maxFeePerGas: "0", maxPriorityFeePerGas: "0", state: "refused", note: `not signed: ${reason}` });
          this.log(rec.id, kind === "permanent" ? "REFUSED" : "TRANSIENT", `attempt ${attemptNo} could not be prepared: ${reason}`);
          if (kind === "permanent") return this.fail(rec, REVERT.test(reason) ? "revert" : "rejected", reason);
          if (attemptNo >= this.policy.maxAttempts) return this.fail(rec, "transient-exhausted", reason);
          await this.backoff(rec, attemptNo);
          continue;
        }
        att = {
          n: attemptNo,
          hash: signed.hash,
          raw: signed.raw,
          nonce: signed.nonce,
          gas: String(signed.gas),
          maxFeePerGas: String(signed.maxFeePerGas),
          maxPriorityFeePerGas: String(signed.maxPriorityFeePerGas),
          state: "signed",
        };
        rec.attempts.push(att);
        this.log(rec.id, "SIGNED", `attempt ${attemptNo}/${this.policy.maxAttempts} nonce ${att.nonce} ${att.hash} maxFee ${att.maxFeePerGas} wei${attemptNo > 1 ? ` (bumped from ${prev!.maxFeePerGas})` : ""}`);
        this.crashAt(rec.id, "signed");

        if (this.injected("drop", rec.id, attemptNo)) {
          att.state = "not-sent";
          att.note = "INJECTED: broadcast skipped, as if the transaction was dropped";
          this.log(rec.id, "INJECTED-DROP", "signed but never sent: the receipt wait must time out and the retry recover");
        } else {
          try {
            await this.port.broadcast(signed);
            att.state = "sent";
            this.log(rec.id, "SENT", att.hash);
          } catch (e) {
            const kind = classify(e);
            const reason = reasonOf(e);
            att.state = "refused";
            att.note = reason;
            if (kind === "permanent") {
              this.log(rec.id, "REFUSED", `the node refused ${att.hash}: ${reason}`);
              return this.fail(rec, REVERT.test(reason) ? "revert" : "rejected", reason);
            }
            this.log(rec.id, "TRANSIENT", `attempt ${attemptNo} refused by the node (${reason})`);
            if (attemptNo >= this.policy.maxAttempts) return this.fail(rec, "transient-exhausted", reason);
            await this.backoff(rec, attemptNo);
            continue;
          }
        }
        this.crashAt(rec.id, "sent");
        rcpt = await this.port.waitReceipt(att.hash, this.policy.receiptTimeoutMs);
      }

      if (rcpt === null) {
        // No receipt in time. Before sending anything again, ask whether ANY earlier attempt landed (one of them may have).
        for (const a of rec.attempts) {
          if (!a.raw || a.raw === "0x") continue;
          const r = await this.port.receipt(a.hash);
          if (r) {
            rcpt = r;
            att = a;
            break;
          }
        }
      }
      if (rcpt === null) {
        att!.state = "timeout";
        this.log(rec.id, "TRANSIENT", `attempt ${att!.n}: no receipt for ${att!.hash} within ${Math.round(this.policy.receiptTimeoutMs / 1000)} s (dropped, or the fee was too low)`);
        if (rec.attempts.length >= this.policy.maxAttempts) return this.fail(rec, "transient-exhausted", `no receipt after ${rec.attempts.length} attempts`);
        await this.backoff(rec, rec.attempts.length);
        continue;
      }

      // A receipt. Mark the attempts: this one mined, the others replaced.
      for (const a of rec.attempts) if (a.hash !== att!.hash && a.state !== "refused") a.state = "replaced";
      att!.gasUsed = String(rcpt.gasUsed);
      att!.blockNumber = String(rcpt.blockNumber);
      this.crashAt(rec.id, "mined");
      if (rcpt.status === "reverted") {
        att!.state = "reverted";
        this.log(rec.id, "REVERTED", `${att!.hash} mined in block ${rcpt.blockNumber} with status 0: permanent`);
        return this.fail(rec, "revert", `the transaction reverted on chain (${att!.hash})`);
      }
      att!.state = "mined";
      rec.landed = true;
      this.log(rec.id, "MINED", `${att!.hash} block ${rcpt.blockNumber} status 1 gas ${rcpt.gasUsed}`);
      const v = await d.verify(ctx, rcpt);
      if (!v.ok) {
        this.log(rec.id, "VERIFY-FAILED", v.detail);
        return this.fail(rec, "verify", v.detail);
      }
      rec.state = "verified";
      rec.detail = v.detail;
      this.log(rec.id, "VERIFIED", v.detail);
      return true;
    }
  }

  /** In-memory intents of the actions started in this process; a resumed action never needs one before its first new send. */
  private readonly intents = new Map<string, TxFields>();

  /** Settle a journaled attempt after a crash or a timeout: receipt → done; known to the node → wait; unknown → send the same bytes again. */
  private async settle(rec: ActionRec, att: AttemptRec): Promise<Rcpt | null> {
    const r = await this.port.receipt(att.hash);
    if (r) {
      this.log(rec.id, "RECOVERED", `journal says ${att.state}; the chain already has ${att.hash} mined`);
      return r;
    }
    if (att.state !== "not-sent" && (await this.port.known(att.hash))) {
      this.log(rec.id, "RECOVERED", `${att.hash} is in the node's pool; waiting for it`);
    } else {
      this.log(rec.id, "RECOVERED", `${att.hash} is unknown to the node; sending the SAME signed bytes again (same nonce, same hash: at most one effect)`);
      try {
        await this.port.broadcast({ hash: att.hash, raw: att.raw, nonce: att.nonce, gas: BigInt(att.gas), maxFeePerGas: BigInt(att.maxFeePerGas), maxPriorityFeePerGas: BigInt(att.maxPriorityFeePerGas) });
        att.state = "sent";
      } catch (e) {
        att.note = reasonOf(e);
        this.log(rec.id, "TRANSIENT", `re-send failed: ${att.note}`);
        return null;
      }
    }
    return this.port.waitReceipt(att.hash, this.policy.receiptTimeoutMs);
  }

  private async backoff(rec: ActionRec, afterAttempt: number): Promise<void> {
    const ms = this.policy.backoffMs * 2 ** (afterAttempt - 1);
    this.log(rec.id, "RETRY", `backing off ${ms} ms, then attempt ${afterAttempt + 1}/${this.policy.maxAttempts} on the same nonce with a higher fee`);
    await this.port.sleep(ms);
  }

  private fail(rec: ActionRec, kind: NonNullable<ActionRec["failure"]>["kind"], reason: string): false {
    rec.state = "failed";
    rec.failure = { kind, reason };
    this.log(rec.id, "FAILED", `${kind}: ${reason}`);
    return false;
  }
}

export function reasonOf(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0]!.slice(0, 300);
}

/** The state line a `status` command prints: where the saga is, one row per action. */
export function statusTable(j: Journal): string {
  const rows = j.actions.map((a) => {
    const last = a.attempts.at(-1);
    const hash = last && last.hash !== "0x" ? last.hash : "";
    const att = a.attempts.length ? `${a.attempts.length} attempt${a.attempts.length > 1 ? "s" : ""}` : "";
    return `${a.phase === "undo" ? "undo " : ""}${a.id}`.padEnd(26) + a.state.padEnd(10) + att.padEnd(12) + hash;
  });
  const cur = j.actions.find((a) => a.state === "running" || a.state === "pending");
  const where = j.status === "running" || j.status === "compensating" ? ` · now at ${cur ? `${cur.phase === "undo" ? "undo " : ""}${cur.id} (${stepNumber(j, cur)})` : "—"}` : "";
  return [`saga ${j.id}: ${j.status.toUpperCase()}${where}`, "action".padEnd(26) + "state".padEnd(10) + "tries".padEnd(12) + "tx", ...rows].join("\n");
}

