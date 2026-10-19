// The buyer: calls a route over real HTTP and reports every step with its measured time. Used by the CLI and by the
// server-side demo (GET demo-run), which streams these events to the page as NDJSON.
//   a / b   pay gas-snapshot (0.001) / whale-brief (0.01): request → 402 → sign → retry (verify, settle) → 200 + receipt check
//   under   sign an authorization for half the price → the facilitator's /verify says invalid → 402 again (requirement 05)
//   replay  pay once, then send the same PAYMENT-SIGNATURE again → 402: the EIP-3009 nonce is already used
//   free    GET health, no payment
// The receipt check (one of "what's ours"): the buyer does not trust PAYMENT-RESPONSE alone. It reads the settle transaction's
// receipt and accepts the data only if the receipt has status 1 and a USDC Transfer from the payer to the payee for exactly the price.
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, getAddress, http, isAddressEqual, type Hex, type Log, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { X402_USDC, atlantic, explorerTx } from "../../src/lib/networks.js";
import { TRANSFER_TOPIC } from "../../src/whale/scan.js";
import { BASE_PATH, NETWORK, PAID_ROUTES, usdc, type PaidRouteName } from "./config.js";
import { parseServerTiming } from "./resource.js";

export const SCENARIOS = ["a", "b", "under", "replay", "free"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const isScenario = (s: unknown): s is Scenario => SCENARIOS.includes(s as Scenario);

export const ROUTE_OF: Record<Scenario, "health" | PaidRouteName> = { a: "gas-snapshot", b: "whale-brief", under: "gas-snapshot", replay: "gas-snapshot", free: "health" };
/** Lamp ids, in order. Every scenario reports every one of its lamps (skipped ones as "skip"). */
export const STEP_IDS = ["req", "q", "sign", "verify", "settle", "ok", "replay"] as const;
export type StepId = (typeof STEP_IDS)[number];
export const stepsFor = (s: Scenario): StepId[] => (s === "replay" ? [...STEP_IDS] : STEP_IDS.filter((x) => x !== "replay"));

export type StepState = "ok" | "refused" | "failed" | "skip";
export interface StartEvent { type: "start"; scenario: Scenario; route: string; url: string; price: string | null; payer: Hex | null; steps: StepId[] }
export interface StepEvent { type: "step"; id: StepId; state: StepState; label: string; ms: number; detail?: Record<string, unknown> }
export interface RawEntry { dir: "→" | "←"; line: string; headers?: Record<string, string>; body?: unknown }
export interface DoneEvent {
  type: "done";
  scenario: Scenario;
  outcome: "paid" | "refused" | "free" | "failed";
  summary: string;
  totalMs: number;
  tx?: Hex;
  explorer?: string;
  block?: number;
  receipt?: ReceiptVerdict;
  data?: unknown;
  refusal?: string;
  raw: RawEntry[];
}
export interface ErrorEvent { type: "error"; message: string }
export type RunEvent = StartEvent | StepEvent | DoneEvent | ErrorEvent;

export interface ReceiptVerdict { ok: boolean; reason: string; status?: "success" | "reverted"; block?: number }

/** Does this receipt prove the payment? status success and a Transfer of `value` from `from` to `to` emitted by the token. */
export function matchReceipt(
  receipt: Pick<TransactionReceipt, "status" | "blockNumber"> & { logs: Pick<Log, "address" | "topics" | "data">[] },
  expect: { token: Hex; from: Hex; to: Hex; value: bigint },
): ReceiptVerdict {
  const block = Number(receipt.blockNumber);
  if (receipt.status !== "success") return { ok: false, reason: "the settle transaction reverted (status 0)", status: receipt.status, block };
  const hit = receipt.logs.some(
    (l) =>
      isAddressEqual(l.address, expect.token)
      && l.topics[0] === TRANSFER_TOPIC
      && l.topics.length === 3
      && isAddressEqual(`0x${l.topics[1]!.slice(26)}`, expect.from)
      && isAddressEqual(`0x${l.topics[2]!.slice(26)}`, expect.to)
      && l.data !== "0x" && BigInt(l.data) === expect.value,
  );
  return hit
    ? { ok: true, reason: `status 1 · USDC Transfer ${usdc(expect.value)} to the payee`, status: "success", block }
    : { ok: false, reason: `status 1 but no USDC Transfer of ${usdc(expect.value)} from the payer to ${expect.to}`, status: "success", block };
}

export interface BuyerOptions {
  /** Origin of the API, e.g. https://pharos.edycu.dev or http://localhost:4021. */
  base: string;
  scenario: Scenario;
  key: Hex;
  emit: (e: RunEvent) => void;
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request (a Vercel protection bypass). */
  headers?: Record<string, string>;
  getReceipt?: (hash: Hex) => Promise<TransactionReceipt>;
  now?: () => number;
}

const atlanticRpc = createPublicClient({ chain: atlantic, transport: http(undefined, { retryCount: 4, retryDelay: 700 }) });
const defaultReceipt = (hash: Hex) => atlanticRpc.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: 30_000 });

const headersOf = (r: Response, names: string[]) =>
  Object.fromEntries(names.flatMap((n) => (r.headers.get(n) ? [[n, r.headers.get(n)!]] : [])));
const bodyOf = async (r: Response) => {
  const t = await r.text();
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return t.slice(0, 500);
  }
};
const reasonOf = (body: unknown, pr?: PaymentRequired) => (body as { reason?: string } | null)?.reason ?? pr?.error ?? "payment required";

/** A buyer client that will only pay our USDC on Atlantic, at most 0.02 USDC per payment. */
export function buyerClient(key: Hex) {
  const signer = privateKeyToAccount(key);
  const client = new x402Client()
    .register(NETWORK, new ExactEvmScheme(signer))
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: X402_USDC.address, maxAmountPerPayment: "20000" }] });
  return { client, address: signer.address };
}

/** Sign for `amount` instead of the asked price, but present it as an answer to the real requirements: an underpayment. */
export async function underpay(client: x402Client, pr: PaymentRequired, factor = 2n): Promise<PaymentPayload> {
  const real = pr.accepts[0]!;
  const cheaper: PaymentRequirements = { ...real, amount: (BigInt(real.amount) / factor).toString() };
  const payload = await client.createPaymentPayload({ ...pr, accepts: [cheaper] });
  return { ...payload, accepted: real };
}

/** Run one scenario end to end. Never throws: a failure is reported as a failed step and a "failed" done event. */
export async function runScenario(o: BuyerOptions): Promise<DoneEvent> {
  const doFetch = o.fetch ?? globalThis.fetch;
  const now = o.now ?? (() => performance.now());
  const getReceipt = o.getReceipt ?? defaultReceipt;
  const route = ROUTE_OF[o.scenario];
  const url = `${o.base.replace(/\/+$/, "")}${BASE_PATH}/${route}`;
  const paid = route !== "health" ? PAID_ROUTES[route] : undefined;
  const { client, address } = buyerClient(o.key);
  const raw: RawEntry[] = [];
  const steps = stepsFor(o.scenario);
  const done = new Set<StepId>();
  const t0 = now();
  const step = (id: StepId, state: StepState, label: string, ms: number, detail?: Record<string, unknown>) => {
    done.add(id);
    o.emit({ type: "step", id, state, label, ms: Math.round(ms), ...(detail ? { detail } : {}) });
  };
  const skipRest = (label: string) => steps.filter((s) => !done.has(s)).forEach((s) => step(s, "skip", label, 0));
  const finish = (d: Omit<DoneEvent, "type" | "scenario" | "totalMs" | "raw">): DoneEvent => {
    const ev: DoneEvent = { type: "done", scenario: o.scenario, totalMs: Math.round(now() - t0), raw, ...d };
    o.emit(ev);
    return ev;
  };
  const get = (headers: Record<string, string> = {}) => doFetch(url, { headers: { accept: "application/json", ...o.headers, ...headers } });

  o.emit({ type: "start", scenario: o.scenario, route: `GET ${BASE_PATH}/${route}`, url, price: paid ? usdc(paid.amount) : null, payer: paid ? address : null, steps });
  try {
    // 1. Ask without paying.
    let t = now();
    const first = await get();
    const firstBody = await bodyOf(first);
    raw.push({ dir: "→", line: `GET ${url}` });
    raw.push({ dir: "←", line: `${first.status} ${first.statusText || ""}`.trim(), headers: headersOf(first, ["PAYMENT-REQUIRED"]), body: firstBody });
    if (route === "health") {
      const ok = first.status === 200;
      step("req", ok ? "ok" : "failed", ok ? "200 · free route" : `HTTP ${first.status}`, now() - t);
      ["q", "sign", "verify", "settle"].forEach((s) => step(s as StepId, "skip", "no payment needed", 0));
      step("ok", ok ? "ok" : "failed", ok ? "200 · no payment" : `HTTP ${first.status}`, 0);
      return finish({ outcome: ok ? "free" : "failed", summary: ok ? "The free route answered without any payment step." : `GET health answered ${first.status}.`, data: firstBody });
    }
    if (first.status !== 402) {
      step("req", "failed", `expected 402, got ${first.status}`, now() - t);
      skipRest("not reached");
      return finish({ outcome: "failed", summary: `The paid route answered ${first.status} instead of 402.`, data: firstBody });
    }
    step("req", "ok", "sent", now() - t);

    // 2. Read the 402: what is asked, in what, to whom.
    t = now();
    const prHeader = first.headers.get("PAYMENT-REQUIRED");
    if (!prHeader) throw new Error("the 402 has no PAYMENT-REQUIRED header");
    const pr = decodePaymentRequiredHeader(prHeader);
    const ask = pr.accepts[0]!;
    raw[raw.length - 1]!.headers = { "PAYMENT-REQUIRED": JSON.stringify(pr.accepts[0]) };
    step("q", "refused", `402 · ${usdc(ask.amount)}`, now() - t, { amount: ask.amount, asset: ask.asset, payTo: ask.payTo, network: ask.network, message: (firstBody as { message?: string })?.message });

    // 3. Sign (EIP-3009 transferWithAuthorization, off chain).
    t = now();
    const payload = o.scenario === "under" ? await underpay(client, pr) : await client.createPaymentPayload(pr);
    const signed = (payload.payload as { authorization?: { value?: string } }).authorization?.value ?? ask.amount;
    const sigHeader = encodePaymentSignatureHeader(payload);
    step("sign", "ok", o.scenario === "under" ? `signed ${usdc(signed)} of ${usdc(ask.amount)}` : "EIP-3009 signed", now() - t, { value: signed });

    // 4. Retry with the payment. The server verifies, runs the route, settles, and reports verify/settle times in Server-Timing.
    t = now();
    const second = await get({ "PAYMENT-SIGNATURE": sigHeader });
    const secondBody = await bodyOf(second);
    const httpMs = now() - t;
    const st = parseServerTiming(second.headers.get("Server-Timing"));
    raw.push({ dir: "→", line: `GET ${url}`, headers: { "PAYMENT-SIGNATURE": `${sigHeader.slice(0, 24)}… (signed ${usdc(signed)})` } });
    const prH = second.headers.get("PAYMENT-RESPONSE");
    const settle = prH ? decodePaymentResponseHeader(prH) : undefined;
    raw.push({ dir: "←", line: `${second.status} ${second.statusText || ""}`.trim(), headers: { ...(settle ? { "PAYMENT-RESPONSE": JSON.stringify(settle) } : {}), ...headersOf(second, ["Server-Timing"]) }, body: secondBody });

    if (second.status === 402) {
      const reason = reasonOf(secondBody);
      const settleFailed = st.settle !== undefined;
      step("verify", settleFailed ? "ok" : "failed", settleFailed ? "/verify valid" : `/verify invalid: ${reason}`, st.verify ?? httpMs);
      if (settleFailed) step("settle", "failed", `/settle failed: ${reason}`, st.settle ?? 0);
      else step("settle", "skip", "not attempted", 0);
      step("ok", "refused", "402 again", Math.max(0, httpMs - (st.verify ?? 0) - (st.settle ?? 0)));
      skipRest("not reached");
      const under = o.scenario === "under";
      return finish({
        outcome: "refused",
        refusal: reason,
        summary: under
          ? `Refused: the payment (${usdc(signed)}) was below the route price (${usdc(ask.amount)}), so the API answered 402 again. Nothing was settled. This is requirement 05.`
          : `Refused with 402: ${reason}.`,
        data: secondBody,
      });
    }
    if (second.status !== 200 || !settle?.success || !settle.transaction) {
      step("verify", st.verify !== undefined ? "ok" : "failed", st.verify !== undefined ? "/verify valid" : `HTTP ${second.status}`, st.verify ?? httpMs);
      step("settle", "failed", settle?.errorReason ?? `HTTP ${second.status}`, st.settle ?? 0);
      skipRest("not reached");
      return finish({ outcome: "failed", summary: `The paid retry answered ${second.status}${settle?.errorReason ? ` (${settle.errorReason})` : ""}.`, data: secondBody });
    }
    const tx = settle.transaction as Hex;
    step("verify", "ok", "/verify valid", st.verify ?? 0);
    step("settle", "ok", "/settle tx mined", st.settle ?? 0, { tx });

    // 5. The receipt check: the data is accepted only if the chain agrees.
    t = now();
    const receipt = await getReceipt(tx);
    const verdict = matchReceipt(receipt, { token: getAddress(ask.asset), from: address, to: getAddress(ask.payTo), value: BigInt(ask.amount) });
    step("ok", verdict.ok ? "ok" : "failed", verdict.ok ? "200 · receipt ok" : "200 · receipt MISMATCH", now() - t, { httpMs: Math.round(httpMs), receipt: verdict.reason });
    if (!verdict.ok) {
      skipRest("not reached");
      return finish({ outcome: "failed", summary: `The API answered 200 but the receipt check failed: ${verdict.reason}. The data is not accepted.`, tx, explorer: explorerTx("atlantic", tx), block: verdict.block, receipt: verdict });
    }

    // 6. Replay: the same signed payment again must be refused.
    let replayNote = "";
    if (o.scenario === "replay") {
      t = now();
      const again = await get({ "PAYMENT-SIGNATURE": sigHeader });
      const againBody = await bodyOf(again);
      raw.push({ dir: "→", line: `GET ${url}  (the same PAYMENT-SIGNATURE again)` });
      raw.push({ dir: "←", line: `${again.status} ${again.statusText || ""}`.trim(), headers: headersOf(again, ["Server-Timing"]), body: againBody });
      const refused = again.status === 402;
      const reason = reasonOf(againBody);
      step("replay", refused ? "refused" : "failed", refused ? `402 · ${reason.replace("invalid_exact_evm_", "")}` : `HTTP ${again.status}: replay NOT refused`, now() - t, { reason });
      replayNote = refused ? ` Sending the same signed payment again got 402 (${reason}): nothing was charged twice.` : ` The replay was NOT refused (HTTP ${again.status}).`;
      if (!refused) return finish({ outcome: "failed", summary: `Paid once, but the replay answered ${again.status}.`, tx, explorer: explorerTx("atlantic", tx), block: verdict.block, receipt: verdict, data: secondBody });
    }
    return finish({
      outcome: "paid",
      summary: `Paid ${usdc(ask.amount)}, settled on chain, receipt checked, data returned.${replayNote}`,
      tx,
      explorer: explorerTx("atlantic", tx),
      block: verdict.block,
      receipt: verdict,
      data: secondBody,
    });
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    o.emit({ type: "error", message });
    skipRest("not reached");
    return finish({ outcome: "failed", summary: `The run failed: ${message}` });
  }
}
