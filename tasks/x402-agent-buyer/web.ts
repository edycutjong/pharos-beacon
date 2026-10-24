// Live demo endpoint for the x402 Agent Buyer (api/router.ts → this file). A DRY PLAN: for each thing the task wants, it asks the
// paywalled API on this same deployment for its 402 (an unpaid GET), reads the price from the
// PAYMENT-REQUIRED header, and applies the agent's own `decide` (asset, per-call cap, worth, budget). It never signs a payment and
// holds no key. The paying run (signing, retries, the ledger) is the CLI's; its recorded runs are in tasks/x402-agent-buyer/proof/.
//   GET ?action=info
//   GET ?action=run&task=finish|budget|cap   NDJSON (steps, then one "done" line with a View)
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { X402_USDC } from "../../src/lib/networks.js";
import { InputError, actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, stepper, type Emit } from "../../src/web/live.js";
import type { View } from "../../src/web/view.js";
import { BASE_PATH, NETWORK, usdc } from "../x402-paywalled-api/config.js";
import { decide, type CachedAnswer } from "./agent.js";
import { TASKS } from "./plan.js";

export const WEB_TASKS = ["finish", "budget", "cap"] as const;
export type WebTask = (typeof WEB_TASKS)[number];
export interface Deps { ask?: (path: string, origin: string) => Promise<{ amount: bigint; asset: string; network: string }> }

export function parseRun(url: URL): WebTask {
  const t = url.searchParams.get("task") ?? "finish";
  if (!(WEB_TASKS as readonly string[]).includes(t)) throw new InputError(`task must be one of ${WEB_TASKS.join(", ")}`);
  return t as WebTask;
}

/** The price the API asks for `path`: an unpaid GET to this deployment's own paywalled API (always the request's own origin). */
async function askOverHttp(path: string, origin: string): Promise<{ amount: bigint; asset: string; network: string }> {
  const res = await fetch(`${origin}${BASE_PATH}/${path}`, { signal: AbortSignal.timeout(15_000) });
  if (res.status !== 402) throw new Error(`${path}: expected 402, got ${res.status}`);
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error(`${path}: the 402 has no PAYMENT-REQUIRED header`);
  const pr = decodePaymentRequiredHeader(header);
  const ask = pr.accepts.find((a) => a.network === NETWORK && a.asset.toLowerCase() === X402_USDC.address.toLowerCase()) ?? pr.accepts[0];
  if (!ask) throw new Error(`${path}: the 402 offers no way to pay`);
  return { amount: BigInt(ask.amount), asset: ask.asset, network: ask.network };
}

const routeOf = (path: string) => path.split("?")[0]!;

export async function run(name: WebTask, origin: string, emit: Emit, deps: Deps = {}): Promise<void> {
  const t0 = Date.now();
  const task = TASKS[name]!;
  const ask = deps.ask ?? askOverHttp;
  emit({ type: "start", task: name, goal: task.goal, budget: usdc(task.policy.budget), perCallCap: usdc(task.policy.perCallCap), wants: task.wants.length });
  const s = stepper(emit);
  const rows: string[][] = [];
  let spent = 0n; // answers this plan would buy for sure
  let maybe = 0n; // whale answers the real agent may skip after reading an answer it already bought
  const cache: CachedAnswer[] = [];
  let bought = 0, skipped = 0, check = 0, stoppedBy: string | undefined;
  for (const w of task.wants) {
    const id = `w-${w.id}`;
    s.begin(id, w.id);
    let a;
    try { a = await ask(w.path, origin); } catch (e) { s.end(id, "failed", (e as Error).message.slice(0, 120)); throw e; }
    const d = decide({ want: w, ask: a.amount, asset: a.asset, network: a.network, spent: spent + maybe, pending: 0n, policy: task.policy, cache, now: Date.now() });
    const whaleBefore = ["whale-brief", "whale-range"].includes(routeOf(w.path)) && task.wants.slice(0, task.wants.indexOf(w)).some((x) => ["whale-brief", "whale-range"].includes(routeOf(x.path)) && rows.some((r) => r[0] === x.id && r[3] !== "REFUSED"));
    if (d.buy) {
      if (whaleBefore) {
        maybe += a.amount; check++;
        rows.push([w.id, w.path, usdc(a.amount), "CHECK FIRST", "A whale answer is already planned: the agent compares its block range with this question (the value check) and pays only if it does not cover it. A dry plan has no bought answer to compare."]);
        s.end(id, "skip", `${usdc(a.amount)} · check first`);
      } else {
        spent += a.amount; bought++;
        if (routeOf(w.path) === "gas-snapshot") cache.push({ key: w.id, path: w.path, at: Date.now(), data: {} });
        rows.push([w.id, w.path, usdc(a.amount), "WOULD BUY", `${w.purpose}`]);
        s.end(id, "ok", `${usdc(a.amount)} · buy`);
      }
    } else {
      skipped++;
      rows.push([w.id, w.path, usdc(a.amount), "REFUSED", `${d.why}: ${d.text}`]);
      s.end(id, "refused", `${usdc(a.amount)} · ${d.why}`);
      if (d.why === "over-budget" && !w.optional) { stoppedBy = w.id; break; }
    }
  }
  const upper = spent + maybe;
  const view: View = {
    tone: stoppedBy ? "warn" : "ok",
    verdict: stoppedBy ? `STOPS at "${stoppedBy}": over budget` : `${bought} to buy, ${skipped} refused${check ? `, ${check} to check first` : ""}`,
    note: `${task.goal} Planned spend ${usdc(spent)}${maybe ? ` (up to ${usdc(upper)} if every check-first answer is paid)` : ""} of a ${usdc(task.policy.budget)} budget, ${usdc(task.policy.perCallCap)} cap per call. Nothing was signed or paid: this is a plan from the live 402 prices.`,
    tables: [{ head: ["Want", "Route", "Asked price", "Decision", "Why"], rows }],
    evidence: [
      ["Policy", `budget ${usdc(task.policy.budget)} · per-call cap ${usdc(task.policy.perCallCap)}`],
      ["Prices from", "the paywalled API's own 402 (PAYMENT-REQUIRED header), asked without a payment"],
      ["Signing", "never on this page: no key exists here"],
    ],
    summary: stoppedBy ? `Stops at "${stoppedBy}": the next answer would go over the budget.` : `Plan: ${bought} purchases for ${usdc(spent)}, ${skipped} refused.`,
  };
  emit({ type: "done", totalMs: Date.now() - t0, view });
}

const gate = concurrencyGate(3);

export function handle(req: Request, deps: Deps = {}): Promise<Response> {
  return guard(async () => {
    const url = new URL(req.url);
    const action = actionOf(url, ["info", "run"] as const, "info");
    if (action === "info") return json({ task: "x402-agent-buyer", tasks: Object.fromEntries(WEB_TASKS.map((k) => [k, { goal: TASKS[k]!.goal, wants: TASKS[k]!.wants.map((w) => w.path) }])), paid: "the CLI only", deploy: deployInfo() });
    const name = parseRun(url);
    if (!gate.take()) return busy();
    return ndjson((emit) => run(name, url.origin, emit, deps), gate.release);
  });
}
