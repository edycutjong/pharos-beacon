// Live demo endpoint for the Natural-Language Payment Agent (api/router.ts → this file). It runs the CLI's rule parser (no LLM key
// exists on the server) and preparePayment against Atlantic, and returns the UNSIGNED transaction. It never signs and never sends.
//   GET ?action=info
//   GET ?action=run&text=<instruction>[&followup=<answer>…][&from=0x…]   NDJSON (steps, then one "done" line with a View)
import { parseRules } from "../../src/pay/parse.js";
import { preparePayment } from "../../src/pay/prepare.js";
import { InputError, actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, stepper, type Emit } from "../../src/web/live.js";
import { atlanticRpcCall } from "../../src/web/atlantic-rpc.js";
import { parseFrom, preparedView, DEFAULT_FROM } from "../../src/web/pay-live.js";
import type { View } from "../../src/web/view.js";
import type { Hex } from "viem";

export interface RunParams { turns: string[]; from: Hex }
export interface Deps { call?: ReturnType<typeof atlanticRpcCall> }

export function parseRun(url: URL): RunParams {
  const q = url.searchParams;
  const text = (q.get("text") ?? "").trim();
  if (!text) throw new InputError("text is required: a payment instruction such as \"send 0.0001 PHRS to 0x…\"");
  const turns = [text, ...q.getAll("followup").map((s) => s.trim()).filter(Boolean)];
  if (turns.length > 4 || turns.some((t) => t.length > 300)) throw new InputError("at most 4 turns of 300 characters each");
  return { turns, from: parseFrom(q.get("from")) };
}

export async function run(p: RunParams, emit: Emit, deps: Deps = {}): Promise<void> {
  const t0 = Date.now();
  emit({ type: "start", parser: "rules", from: p.from, endpoint: "public Atlantic RPC https://atlantic.dplabs-internal.com" });
  const s = stepper(emit);
  s.begin("parse");
  const parsed = parseRules(p.turns);
  s.end("parse", parsed.questions.length ? "refused" : "ok", parsed.questions.length ? "needs more" : `${parsed.parser} · ${parsed.lang}`);
  const understood = JSON.stringify(parsed.draft);
  if (parsed.questions.length) {
    s.begin("prepare");
    s.end("prepare", "skip", "waiting for your answer");
    const view: View = {
      tone: "warn", verdict: "NEEDS ONE MORE THING",
      note: "Nothing was prepared. Answer the question below and run again with the answer as a follow-up.",
      tables: [{ head: ["Question"], rows: parsed.questions.map((q) => [q]) }],
      evidence: [["Understood so far", understood], ["Parser", `${parsed.parser} (language ${parsed.lang})`]],
      summary: `Asked ${parsed.questions.length} question${parsed.questions.length === 1 ? "" : "s"} instead of guessing.`,
    };
    emit({ type: "done", totalMs: Date.now() - t0, view, asked: parsed.questions });
    return;
  }
  s.begin("prepare");
  const prep = await preparePayment(parsed.draft, { call: deps.call ?? atlanticRpcCall(), from: p.from });
  s.end("prepare", prep.ok ? "ok" : "refused", `${prep.checks.filter((c) => c.ok).length}/${prep.checks.length} checks`);
  s.begin("sign");
  s.end("sign", "skip", "never on this page");
  emit({ type: "done", totalMs: Date.now() - t0, view: preparedView(prep, { verdict: "PREPARED, NOT SIGNED", note: "The payment was refused by a check." }, [["Understood", understood], ["Parser", `${parsed.parser} (language ${parsed.lang})`], ["Sender", p.from]]) });
}

const gate = concurrencyGate(2);

export function handle(req: Request, deps: Deps = {}): Promise<Response> {
  return guard(async () => {
    const url = new URL(req.url);
    const action = actionOf(url, ["info", "run"] as const, "info");
    if (action === "info") return json({ task: "natural-language-payment-agent", parser: "rules (the CLI also uses an LLM when a key is set; none on this server)", defaultFrom: DEFAULT_FROM, reads: "public Atlantic RPC", deploy: deployInfo() });
    const p = parseRun(url);
    if (!gate.take()) return busy();
    return ndjson((emit) => run(p, emit, deps), gate.release);
  });
}
