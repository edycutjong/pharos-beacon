// x402 Agent Buyer (Hard · 200 pts): an agent that pays x402-paywalled APIs on Pharos Atlantic, inside a budget.
//   npm run x402-agent-buyer -- run finish|budget|cap|retry|partner [--base URL | --local] [--partner URL] [--simulate-failure before|after] [--ledger name] [--fresh] [--proof name]
//   npm run x402-agent-buyer -- log [--task finish]        (the payment log of a task, as a table)
// The API is the x402 Paywalled API (tasks/x402-paywalled-api): default https://pharos.edycu.dev; `whale-range` needs a branch
// build, so run `npm run x402-paywalled-api -- serve` and pass --base http://localhost:4021.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { createPublicClient, http } from "viem";
import { atlantic } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { buyerKey, setting } from "../x402-paywalled-api/settings.js";
import { Agent, readLog, type AgentEvent, type PaymentRow } from "./agent.js";
import { PARTNER_URL, TASKS, partnerTask, type Task } from "./plan.js";

const TASK = "x402-agent-buyer";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const STATE = join(HERE, "state");
const USAGE = "x402-agent-buyer run finish|budget|cap|retry|partner [--base URL | --local] [--partner URL] [--simulate-failure before|after] [--ledger name] [--compact] [--fresh] [--proof name] | log [--task id]";
const DEFAULT_BASE = "https://pharos.edycu.dev";
const LOCAL_BASE = "http://localhost:4021";

const atlanticBlock = () => createPublicClient({ chain: atlantic, transport: http(undefined, { retryCount: 3 }) }).getBlockNumber();
const short = (h?: string) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "");

/** One terminal line (or few) per event. */
export function formatEvent(e: AgentEvent): string | undefined {
  switch (e.type) {
    case "task":
      return `task ${e.task}: ${e.wants} wants · budget ${e.budget} · per-call cap ${e.perCallCap}\n  API ${e.base} · payer ${e.payer}`;
    case "ask":
      return `  ask      ${e.want.padEnd(12)} GET ${e.path} → 402, price ${e.price}`;
    case "refused":
      return `  REFUSED  ${e.want.padEnd(12)} ${e.why}: ${e.text}`;
    case "sign":
      return `  sign     ${e.want.padEnd(12)} ${e.price} · key ${e.purchase} · nonce ${short(e.nonce)} · journaled first`;
    case "attempt":
      return `  send #${e.n}  ${e.want.padEnd(12)} ${e.error ? `FAILED: ${e.error}` : `HTTP ${e.status}${e.body ? ` ${e.body.replace(/\s+/g, " ").slice(0, 70)}` : ""}`}`;
    case "reconcile":
      return `  check    ${e.want.padEnd(12)} ${e.text}`;
    case "paid":
      return `  PAID     ${e.want.padEnd(12)} ${e.row.price} · tx ${short(e.row.tx)} · running total ${e.row.runningTotal}`;
    case "already-paid":
      return `  have it  ${e.want.padEnd(12)} already paid under key ${e.purchase}${e.tx ? ` (tx ${short(e.tx)})` : ""}: no HTTP, no payment`;
    case "failed":
      return `  FAILED   ${e.want.padEnd(12)} ${e.text}`;
    case "stopped":
      return `  STOP     ${e.text}`;
    case "done": {
      const s = e.summary;
      return `${s.outcome.toUpperCase()} ${s.task}: ${s.paid} paid · spent ${s.spent} of ${s.budget} (${s.left} left) · ${s.refused} refused · saved ${s.saved}`;
    }
  }
}

/**
 * `--compact`: one line of at most 62 characters per event (what fits a phone-sized terminal or a video frame).
 * Stateful: a refusal line carries the price from the `ask` line before it.
 */
export function compactFormatter(): (e: AgentEvent) => string | undefined {
  const price = new Map<string, string>();
  const num = (usdc: string) => usdc.replace(" USDC", "");
  const w = (id: string) => id.padEnd(9);
  const line = (e: AgentEvent): string | undefined => {
    switch (e.type) {
      case "task":
        return `task ${e.task} · budget ${num(e.budget)} · cap ${num(e.perCallCap)} USDC`;
      case "ask":
        price.set(e.want, num(e.price));
        return `ask   ${w(e.want)} ${num(e.price)}`;
      case "sign":
        return `sign  ${w(e.want)} ${num(e.price)} · nonce ${e.nonce.slice(0, 8)}…`;
      case "attempt":
        return `send ${e.n} ${w(e.want)} ${e.error ? `FAILED: ${(e.error.split(": ").pop() ?? e.error).slice(0, 30)}` : `HTTP ${e.status}`}`;
      case "reconcile":
        return `check ${e.text.includes("expired") ? "nonce unused, lapsed" : e.nonceUsed ? "nonce used: settled once" : "nonce unused, still valid"}`;
      case "refused": {
        const reason = { redundant: `have it, saves ${e.saved ? num(e.saved) : "?"}`, "not-worth": "costs more than it is worth", "over-cap": "over the per-call cap", "over-budget": "over the budget", "wrong-asset": "wrong token" }[e.why];
        return `NO    ${w(e.want)} ${price.get(e.want) ?? ""}: ${reason}`;
      }
      case "paid":
        return `PAID  ${w(e.want)} ${num(e.row.price)} · total ${num(e.row.runningTotal)}`;
      case "already-paid":
        return `have  ${w(e.want)} paid before: no new payment`;
      case "failed":
        return `FAIL  ${w(e.want)} ${e.text.slice(0, 44)}`;
      case "stopped":
        return `STOP  ${e.want} does not fit the budget`;
      case "done": {
        const s = e.summary;
        return `${s.outcome === "stopped-budget" ? "STOPPED" : s.outcome.toUpperCase()}  ${s.paid} paid · ${num(s.spent)} of ${num(s.budget)} USDC${s.saved !== "0 USDC" ? ` · saved ${num(s.saved)}` : ""}`;
      }
    }
  };
  return (e) => line(e)?.slice(0, 62);
}

export function formatLogCompact(rows: PaymentRow[]): string {
  if (!rows.length) return "(no payments)";
  return rows.map((r) => `${r.n}  ${r.price.replace(" USDC", "").padEnd(6)} total ${r.runningTotal.replace(" USDC", "").padEnd(6)} ${r.bought.slice(0, 26)}${r.note ? " *" : ""}`).join("\n");
}

export function formatLog(rows: PaymentRow[]): string {
  if (!rows.length) return "(no payments)";
  return rows.map((r) => `${String(r.n).padStart(2)}  ${r.price.padEnd(11)}  total ${r.runningTotal.padEnd(11)}  ${r.bought}\n    ${r.explorer ?? "(settling tx not found in the lookback)"}${r.note ? `\n    note: ${r.note}` : ""}`).join("\n");
}

/** Wraps fetch to drop the first paid request: before = it never leaves; after = the API answers but we never see it. */
export function failOnce(real: typeof globalThis.fetch, mode: "before" | "after"): typeof globalThis.fetch {
  let spent = false;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const paid = new Headers(init?.headers).has("PAYMENT-SIGNATURE");
    if (!paid || spent) return real(input, init);
    spent = true;
    if (mode === "after") await real(input, init);
    throw new Error(mode === "before" ? "simulated network failure: the request never left" : "simulated network failure: the API answered, the response was lost");
  }) as typeof globalThis.fetch;
}

export async function main(_ctx: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    { usage: USAGE, positionals: [1, 2], options: { base: { type: "string" }, partner: { type: "string" }, ledger: { type: "string" }, "simulate-failure": { type: "string" }, fresh: { type: "boolean", default: false }, proof: { type: "string" }, task: { type: "string" }, compact: { type: "boolean", default: false }, local: { type: "boolean", default: false } } },
    argv,
  );
  const [cmd, arg] = positionals;
  if (cmd === "log") {
    const id = values.task ?? "finish";
    console.log(formatLog(readLog(join(STATE, `${id}.payments.jsonl`))));
    return 0;
  }
  if (cmd !== "run") throw new UsageError(`unknown command ${JSON.stringify(cmd)}\nusage: ${USAGE}`);
  const name = choice("task", arg, [...Object.keys(TASKS), "partner"]);
  let task: Task;
  if (name === "partner") {
    const block = Number(await atlanticBlock());
    task = partnerTask(values.partner ?? PARTNER_URL, block);
  } else task = TASKS[name]!;
  const mode = values["simulate-failure"] === undefined ? undefined : choice("--simulate-failure", values["simulate-failure"], ["before", "after"] as const);
  const base = values.base ?? (values.local ? LOCAL_BASE : undefined) ?? setting("PUBLIC_BASE_URL") ?? DEFAULT_BASE;
  // A ledger is one budget scope: --ledger, else the proof name (each proof starts at zero), else the task id.
  const id = values.ledger ?? values.proof ?? task.id;
  const logFile = join(STATE, `${id}.payments.jsonl`);
  const journalFile = join(STATE, `${id}.journal.json`);
  if (values.fresh) [logFile, journalFile].forEach((f) => rmSync(f, { force: true }));
  mkdirSync(STATE, { recursive: true });
  // Provenance is taken before the run writes anything, so a proof records the tree as it was when the run started.
  const meta = values.proof ? proofMeta(TASK, { network: "atlantic", chainId: atlantic.id, endpoint: `${new URL(base).origin} (x402 API) + Atlantic RPC (receipt and authorization checks)` }) : undefined;
  const events: AgentEvent[] = [];
  const fmt = values.compact ? compactFormatter() : formatEvent;
  const agent = new Agent({
    task: task.id, base, key: buyerKey(), policy: task.policy, logFile, journalFile,
    ...(mode ? { fetch: failOnce(globalThis.fetch, mode) } : {}),
    emit: (e) => {
      events.push(e);
      const line = fmt(e);
      if (line) console.log(line);
    },
  });
  if (!values.compact) console.log(`goal: ${task.goal}`);
  const summary = await agent.run(task.wants);
  console.log("payment log:\n" + (values.compact ? formatLogCompact(readLog(logFile)) : formatLog(readLog(logFile))));
  if (values.proof && meta) {
    const proofDir = join(HERE, "proof");
    const proofName = values.proof;
    mkdirSync(proofDir, { recursive: true });
    copyFileSync(logFile, join(proofDir, `${proofName}.payments.jsonl`));
    console.log(`proof: ${writeProof(join(proofDir, `${proofName}.json`), { task: task.id, goal: task.goal, base: new URL(base).origin, simulateFailure: mode ?? null, events, summary }, meta)}`);
  }
  // Exit 0 when the task ended the way its demo says it should (finish → finished, budget → stopped-budget), 1 otherwise.
  // The partner seller only accepts payments from its own buyer wallet, so that task ends unfinished by design.
  const expected = task.id === "budget" ? "stopped-budget" : task.id === "partner" ? "unfinished" : "finished";
  return summary.outcome === expected || (task.id === "retry" && mode === "after") ? 0 : 1;
}

if (isMain(import.meta.url)) await runCli(main);
