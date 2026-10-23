// x402 Agent Buyer (Hard · 200 pts): an agent that pays x402-paywalled APIs on Pharos Atlantic, inside a budget.
//   npm run x402-agent-buyer -- run finish|budget|cap|retry [--base URL] [--simulate-failure before|after] [--fresh] [--proof name]
//   npm run x402-agent-buyer -- log [--task finish]        (the payment log of a task, as a table)
// The API is the x402 Paywalled API (tasks/x402-paywalled-api): default https://pharos.edycu.dev; `whale-range` needs a branch
// build, so run `npm run x402-paywalled-api -- serve` and pass --base http://localhost:4021.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { atlantic } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { buyerKey, setting } from "../x402-paywalled-api/settings.js";
import { Agent, readLog, type AgentEvent, type PaymentRow } from "./agent.js";
import { TASKS } from "./plan.js";

const TASK = "x402-agent-buyer";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const STATE = join(HERE, "state");
const USAGE = "x402-agent-buyer run finish|budget|cap|retry [--base URL] [--simulate-failure before|after] [--fresh] [--proof name] | log [--task id]";
const DEFAULT_BASE = "https://pharos.edycu.dev";

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
      return `  sign     ${e.want.padEnd(12)} ${e.price} · key ${e.key} · nonce ${short(e.nonce)} (written to the journal before it is sent)`;
    case "attempt":
      return `  send #${e.n}  ${e.want.padEnd(12)} ${e.error ? `FAILED: ${e.error}` : `HTTP ${e.status}`}`;
    case "reconcile":
      return `  check    ${e.want.padEnd(12)} ${e.text}`;
    case "paid":
      return `  PAID     ${e.want.padEnd(12)} ${e.row.price} · tx ${e.row.explorer} · running total ${e.row.runningTotal}`;
    case "already-paid":
      return `  have it  ${e.want.padEnd(12)} already paid under key ${e.key}${e.tx ? ` (tx ${short(e.tx)})` : ""}: no HTTP, no payment`;
    case "failed":
      return `  FAILED   ${e.want.padEnd(12)} ${e.text}`;
    case "stopped":
      return `  STOP     ${e.text}`;
    case "done": {
      const s = e.summary;
      return `${s.outcome.toUpperCase()} task ${s.task}: ${s.paid} payment(s), spent ${s.spent} of ${s.budget} (${s.left} left), refused ${s.refused}, saved by not re-buying ${s.saved}`;
    }
  }
}

export function formatLog(rows: PaymentRow[]): string {
  if (!rows.length) return "(no payments)";
  return rows.map((r) => `${String(r.n).padStart(2)}  ${r.price.padEnd(11)}  total ${r.runningTotal.padEnd(11)}  ${r.bought}\n    ${r.explorer}${r.note ? `\n    note: ${r.note}` : ""}`).join("\n");
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
    { usage: USAGE, positionals: [1, 2], options: { base: { type: "string" }, "simulate-failure": { type: "string" }, fresh: { type: "boolean", default: false }, proof: { type: "string" }, task: { type: "string" } } },
    argv,
  );
  const [cmd, arg] = positionals;
  if (cmd === "log") {
    const id = values.task ?? "finish";
    console.log(formatLog(readLog(join(STATE, `${id}.payments.jsonl`))));
    return 0;
  }
  if (cmd !== "run") throw new UsageError(`unknown command ${JSON.stringify(cmd)}\nusage: ${USAGE}`);
  const task = TASKS[choice("task", arg, Object.keys(TASKS) as [string, ...string[]])]!;
  const mode = values["simulate-failure"] === undefined ? undefined : choice("--simulate-failure", values["simulate-failure"], ["before", "after"] as const);
  const base = values.base ?? setting("PUBLIC_BASE_URL") ?? DEFAULT_BASE;
  const id = values.proof ?? task.id;
  const logFile = join(STATE, `${id}.payments.jsonl`);
  const journalFile = join(STATE, `${id}.journal.json`);
  if (values.fresh) [logFile, journalFile].forEach((f) => rmSync(f, { force: true }));
  mkdirSync(STATE, { recursive: true });
  const events: AgentEvent[] = [];
  const agent = new Agent({
    task: task.id, base, key: buyerKey(), policy: task.policy, logFile, journalFile,
    ...(mode ? { fetch: failOnce(globalThis.fetch, mode) } : {}),
    emit: (e) => {
      events.push(e);
      const line = formatEvent(e);
      if (line) console.log(line);
    },
  });
  console.log(`goal: ${task.goal}`);
  const summary = await agent.run(task.wants);
  console.log("payment log:\n" + formatLog(readLog(logFile)));
  if (values.proof) {
    const proofDir = join(HERE, "proof");
    mkdirSync(proofDir, { recursive: true });
    copyFileSync(logFile, join(proofDir, `${id}.payments.jsonl`));
    const meta = proofMeta(TASK, { network: "atlantic", chainId: atlantic.id, endpoint: `${new URL(base).origin} (x402 API) + Atlantic RPC (receipt and authorization checks)` });
    console.log(`proof: ${writeProof(join(proofDir, `${id}.json`), { task: task.id, goal: task.goal, base: new URL(base).origin, simulateFailure: mode ?? null, events, summary }, meta)}`);
  }
  // Exit 0 when the task ended the way its demo says it should (finish → finished, budget → stopped-budget), 1 otherwise.
  const expected = task.id === "budget" ? "stopped-budget" : "finished";
  return summary.outcome === expected || (task.id === "retry" && mode === "after") ? 0 : 1;
}

if (isMain(import.meta.url)) await runCli(main);
