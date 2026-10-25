// Live demo endpoint for the Invoice-to-Payment Agent (api/router.ts → this file). It runs the CLI's rule extractor
// (extractInvoice without an LLM, which no server key exists for), toDraft, the duplicate fingerprint and preparePayment against
// Atlantic, and returns the UNSIGNED transaction. It never signs and never sends; the paid-invoice ledger is a CLI file, so the
// duplicate refusal is shown by the CLI, not here.
//   GET ?action=info
//   POST ?action=run   body {"text": "<invoice text or JSON>", "payIn"?: "USDC", "from"?: "0x…"}   NDJSON
import { detectFormat, extractInvoice, fingerprint, toDraft } from "../../src/pay/invoice.js";
import { preparePayment } from "../../src/pay/prepare.js";
import { atlanticRpcCall } from "../../src/web/atlantic-rpc.js";
import { InputError, actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, stepper, type Emit } from "../../src/web/live.js";
import { DEFAULT_FROM, parseFrom, preparedView } from "../../src/web/pay-live.js";
import type { View } from "../../src/web/view.js";
import type { Hex } from "viem";
import { SYMBOLS } from "../../src/pay/parse.js";

export interface RunParams { text: string; payIn?: string; from: Hex }
export interface Deps { call?: ReturnType<typeof atlanticRpcCall> }

export async function parseRun(req: Request): Promise<RunParams> {
  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try { body = (await req.json()) as Record<string, unknown>; } catch { throw new InputError("the body must be JSON: {\"text\": \"…\"}"); }
  } else body = { text: url.searchParams.get("text"), payIn: url.searchParams.get("payIn"), from: url.searchParams.get("from") };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) throw new InputError("text is required: the invoice as JSON or plain text");
  if (text.length > 4000) throw new InputError("the invoice may be at most 4,000 characters");
  const payIn = typeof body.payIn === "string" && body.payIn ? body.payIn.toUpperCase() : undefined;
  if (payIn && !(SYMBOLS as readonly string[]).includes(payIn)) throw new InputError(`payIn must be one of ${SYMBOLS.join(", ")}`);
  return { text, ...(payIn ? { payIn } : {}), from: parseFrom(typeof body.from === "string" ? body.from : undefined) };
}

export async function run(p: RunParams, emit: Emit, deps: Deps = {}): Promise<void> {
  const t0 = Date.now();
  emit({ type: "start", parser: "rules", from: p.from, endpoint: "public Atlantic RPC https://atlantic.dplabs-internal.com" });
  const s = stepper(emit);
  s.begin("extract");
  const x = await extractInvoice(p.text, detectFormat("invoice.txt", p.text), undefined);
  s.end("extract", x.flags.length ? "refused" : "ok", x.flags.length ? "flagged" : x.via);
  const fields: View["evidence"] = [["Number", x.number ?? "—"], ["Issuer", x.issuer ?? "—"], ["Payee", x.payee ?? "—"], ["Amount", `${x.amount ?? "—"} ${x.currency ?? ""}`.trim()]];
  s.begin("validate");
  const { draft, flags, notes } = toDraft(x, p.payIn);
  s.end("validate", draft ? "ok" : "refused", draft ? "complete" : `${flags.length} flag${flags.length === 1 ? "" : "s"}`);
  if (!draft) {
    s.begin("prepare"); s.end("prepare", "skip", "nothing to prepare");
    s.begin("sign"); s.end("sign", "skip", "never on this page");
    const view: View = {
      tone: "bad", verdict: "FLAGGED: needs a human",
      note: "Nothing was prepared. The invoice has problems a payment must not guess around.",
      tables: [{ head: ["Problem"], rows: flags.map((f) => [f]) }],
      evidence: fields,
      summary: `Flagged ${flags.length} problem${flags.length === 1 ? "" : "s"} before any transaction was prepared.`,
    };
    emit({ type: "done", totalMs: Date.now() - t0, view });
    return;
  }
  s.begin("prepare");
  const prep = await preparePayment(draft, { call: deps.call ?? atlanticRpcCall(), from: p.from });
  s.end("prepare", prep.ok ? "ok" : "refused", `${prep.checks.filter((c) => c.ok).length}/${prep.checks.length} checks`);
  s.begin("sign"); s.end("sign", "skip", "never on this page");
  const fp = fingerprint({ number: x.number, issuer: x.issuer, amount: x.amount, currency: x.currency });
  emit({ type: "done", totalMs: Date.now() - t0, view: preparedView(prep, { verdict: "PREPARED, NOT SIGNED", note: "A check refused the payment." }, [...fields, ["Fingerprint", fp], ...notes.map((n): [string, string] => ["Note", n]), ["Sender", p.from]]) });
}

const gate = concurrencyGate(2);

export function handle(req: Request, deps: Deps = {}): Promise<Response> {
  return guard(async () => {
    const url = new URL(req.url);
    const action = actionOf(url, ["info", "run"] as const, "info");
    if (action === "info") return json({ task: "invoice-to-payment-agent", parser: "rules (the CLI also fills gaps with an LLM when a key is set; none on this server)", defaultFrom: DEFAULT_FROM, reads: "public Atlantic RPC", deploy: deployInfo() });
    const p = await parseRun(req);
    if (!gate.take()) return busy();
    return ndjson((emit) => run(p, emit, deps), gate.release);
  });
}
