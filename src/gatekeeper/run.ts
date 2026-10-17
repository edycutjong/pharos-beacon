import type { Hex } from "viem";
import { checksum, type GatekeeperPolicy, type GateRequest, parseAmount } from "./policy.js";
import { evaluate, type Decision, type Spend } from "./evaluate.js";
import { appendAudit } from "./audit.js";
import { readState, writeState } from "../lib/state.js";

// Orchestration: evaluate → write the decision to the audit log → only for an ALLOW with --execute, send. A denied
// request never reaches `send`: the only call to it is inside the allow branch below.

export interface SendResult {
  tx: Hex;
  status: "success" | "reverted";
  block: string;
  gasUsed: string;
}
/** Sends `wei` to `to`; calls `beforeBroadcast(hash)` once the hash is known and before anything leaves the machine. */
export type Send = (to: Hex, wei: bigint, beforeBroadcast: (hash: Hex) => void) => Promise<SendResult>;

export interface RunOptions {
  stateFile: string;
  auditFile: string;
  execute: boolean;
  send?: Send;
  now?: () => Date;
}
export interface Outcome {
  request: GateRequest;
  decision: Decision;
  status: "denied" | "allowed-dry-run" | "executed" | "reverted" | "error";
  audit: number;
  tx?: string;
  note?: string;
}

interface SpendState {
  spends: Spend[];
}
const checkState = (v: unknown): SpendState => {
  const s = v as SpendState;
  if (!s || !Array.isArray(s.spends) || !s.spends.every((x) => typeof x?.at === "string" && /^\d+$/.test(String(x?.wei)) && !isNaN(Date.parse(x.at))))
    throw new Error("spend state file has the wrong shape; refusing to guess (fix or remove it)");
  return s;
};

/** Run requests in order against one policy. Call inside `withLock(stateFile, …)`. */
export async function runRequests(policy: GatekeeperPolicy, requests: GateRequest[], o: RunOptions): Promise<Outcome[]> {
  const clock = o.now ?? (() => new Date());
  const out: Outcome[] = [];
  // A dry-run batch pretends its earlier ALLOWs were sent (in memory only, never saved), so it predicts what --execute would do.
  const pretend: Spend[] = [];
  for (const request of requests) {
    const simulated = request.at !== undefined;
    const when = simulated ? new Date(request.at as string) : clock();
    const state = readState<SpendState>(o.stateFile, { spends: [] }, checkState);
    const decision = evaluate(policy, request, [...state.spends, ...pretend], when);
    const dec = appendAudit(
      o.auditFile,
      { event: "decision", policy: policy.name, label: request.label, request: { to: request.to, amount: request.amount }, clock: simulated ? "simulated" : "real", requestTime: when.toISOString(), decision: decision.decision, rule: decision.rule, reason: decision.reason },
      clock(),
    );
    if (decision.decision === "deny") {
      out.push({ request, decision, status: "denied", audit: dec.seq });
      continue;
    }
    if (!o.execute || simulated || !o.send) {
      const note = simulated ? "simulated clock: never sent" : "dry-run: pass --execute to send";
      if (!simulated) pretend.push({ at: when.toISOString(), wei: parseAmount(request.amount).toString() });
      out.push({ request, decision, status: "allowed-dry-run", audit: dec.seq, note });
      continue;
    }
    const to = checksum(request.to as string);
    const wei = parseAmount(request.amount);
    let hash: Hex | undefined;
    try {
      const r = await o.send(to, wei, (h) => {
        hash = h;
        // Counted BEFORE the broadcast: if the send then fails, the limit errs on the side of having spent it.
        writeState(o.stateFile, { spends: [...state.spends, { at: when.toISOString(), wei: wei.toString(), tx: h }] });
      });
      appendAudit(o.auditFile, { event: "result", decisionSeq: dec.seq, tx: r.tx, status: r.status, block: r.block, gasUsed: r.gasUsed }, clock());
      out.push({ request, decision, status: r.status === "success" ? "executed" : "reverted", audit: dec.seq, tx: r.tx });
    } catch (e) {
      const note = (e as Error).message;
      appendAudit(o.auditFile, { event: "result", decisionSeq: dec.seq, tx: hash, status: "error", error: note.slice(0, 300) }, clock());
      out.push({ request, decision, status: "error", audit: dec.seq, tx: hash, note });
    }
  }
  return out;
}
