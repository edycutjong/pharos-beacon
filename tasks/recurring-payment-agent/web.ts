// Live demo endpoint for the Recurring Payment Agent (api/recurring-payment-agent.ts). Read-only: it never signs or pays.
// It loads a committed plan and its ledger (at the pinned commit), works out the schedule at a clock you choose with the CLI's own
// functions (src/recurring/agent.ts), checks every paid period's transaction on Atlantic, reads the paying wallet's balance and
// simulates (estimate_gas) the next payment, so it says what a real `run` would do at that clock. Atlantic reads go through the
// public Atlantic RPC (the Atlantic Chain MCP runs locally over stdio, not on Vercel).
//   GET ?action=info
//   GET ?action=status&plan=rent|wphrs|insufficient&clock=<ISO date>|now        NDJSON
import { decodeEventLog, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddressEqual, parseUnits, toHex, type Hex, type RpcLog } from "viem";
import type { ChainMcp } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import { duePeriods, historyRows, nextScheduled, parsePlan, unpaidDue, type Ledger, type Plan } from "../../src/recurring/agent.js";
import { atlanticRpcCall } from "../../src/web/atlantic-rpc.js";
import { InputError, actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, pinnedJson, stepper, type Emit } from "../../src/web/live.js";

export const PLANS = {
  rent: { plan: "tasks/recurring-payment-agent/plans/rent.json", ledger: "tasks/recurring-payment-agent/state/rent-demo.json" },
  wphrs: { plan: "tasks/recurring-payment-agent/plans/wphrs.json", ledger: "tasks/recurring-payment-agent/state/wphrs-demo.json" },
  insufficient: { plan: "tasks/recurring-payment-agent/plans/insufficient.json", ledger: "tasks/recurring-payment-agent/state/insufficient-demo.json" },
} as const;

type Call = ChainMcp["call"];
export interface Deps {
  call: () => Call;
  fetch?: typeof fetch;
  now?: () => Date;
}
const defaultDeps: Deps = { call: () => atlanticRpcCall() };

export interface StatusParams {
  plan: keyof typeof PLANS;
  /** undefined = the real clock */
  clock?: Date;
}

export function parseStatus(url: URL): StatusParams {
  const q = url.searchParams;
  const plan = q.get("plan") ?? "rent";
  if (!(plan in PLANS)) throw new InputError(`plan must be one of ${Object.keys(PLANS).join(", ")}`);
  const c = q.get("clock") ?? "now";
  if (c === "now") return { plan: plan as keyof typeof PLANS };
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z?)?$/.test(c)) throw new InputError("clock must be an ISO date like 2026-11-22 or 2026-11-22T09:00:00Z, or now");
  const d = new Date(c.length === 10 ? `${c}T12:00:00Z` : c.endsWith("Z") ? c : `${c}Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2026 || d.getUTCFullYear() > 2030) throw new InputError("clock must be a date between 2026 and 2030");
  return { plan: plan as keyof typeof PLANS, clock: d };
}

const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Does this paid period's transaction on Atlantic pay exactly the plan's amount to its recipient, and did it succeed? */
export async function verifyPaid(call: Call, plan: Plan, payer: Hex | undefined, hash: Hex): Promise<{ ok: boolean; note: string; block?: string; gasUsed?: string }> {
  const r = await call("get_transaction_receipt", { hash });
  if (!r) return { ok: false, note: "the node has no receipt for this hash" };
  const block = BigInt(r.blockNumber).toString(), gasUsed = BigInt(r.gasUsed).toString();
  if (r.status !== "0x1") return { ok: false, note: `receipt status ${r.status}: reverted`, block, gasUsed };
  const units = parseUnits(plan.amount, plan.token.decimals);
  if (plan.token.address) {
    const hit = (r.logs as RpcLog[]).find((l) => {
      if (!isAddressEqual(l.address, plan.token.address!) || l.topics[0] !== transferTopic || l.topics.length !== 3) return false;
      const ev = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", topics: l.topics as [Hex, ...Hex[]], data: l.data });
      return isAddressEqual(ev.args.to, plan.recipient) && ev.args.value === units && (!payer || isAddressEqual(ev.args.from, payer));
    });
    return hit ? { ok: true, note: `status 1 · Transfer of ${plan.amount} ${plan.token.symbol} to the recipient`, block, gasUsed } : { ok: false, note: "no matching Transfer log in the receipt", block, gasUsed };
  }
  const tx = await call("get_transaction", { hash });
  if (!tx) return { ok: false, note: "the node has no transaction for this hash", block, gasUsed };
  const right = tx.to && isAddressEqual(tx.to, plan.recipient) && BigInt(tx.value) === units && (!payer || isAddressEqual(tx.from, payer));
  return right ? { ok: true, note: `status 1 · ${plan.amount} PHRS to the recipient`, block, gasUsed } : { ok: false, note: "the transaction does not pay this plan's amount to its recipient", block, gasUsed };
}

export async function status(p: StatusParams, emit: Emit, deps: Deps = defaultDeps): Promise<void> {
  const t0 = Date.now();
  const s = stepper(emit);
  const now = p.clock ?? (deps.now ?? (() => new Date()))();
  const call = deps.call();

  s.begin("load");
  const plan = parsePlan(await pinnedJson(PLANS[p.plan].plan, deps.fetch));
  const ledger = await pinnedJson<Ledger>(PLANS[p.plan].ledger, deps.fetch);
  if (!ledger || !Array.isArray(ledger.periods) || JSON.stringify(ledger.plan) !== JSON.stringify(plan)) throw new Error("the committed ledger does not belong to this plan");
  const payer = ledger.payer ? getAddress(ledger.payer) : undefined;
  s.end("load", "ok", `${plan.id} · ${ledger.periods.length} period${ledger.periods.length === 1 ? "" : "s"} in the ledger`);
  emit({ type: "start", plan, payer: payer ?? null, clock: now.toISOString(), injected: Boolean(p.clock), source: PLANS[p.plan] });

  s.begin("schedule");
  const { rows, next } = historyRows(plan, ledger, now);
  const due = duePeriods(plan, now);
  s.end("schedule", "ok", `${due.length} due by this clock${next ? ` · next #${next.period} on ${next.due.slice(0, 10)}` : ""}`);

  s.begin("verify");
  const checks: { period: number; tx: Hex; explorer: string; ok: boolean; note: string; block?: string; gasUsed?: string }[] = [];
  for (const rec of ledger.periods.filter((x) => x.status === "paid" && x.tx)) {
    checks.push({ period: rec.period, tx: rec.tx!.hash, explorer: explorerTx("atlantic", rec.tx!.hash), ...(await verifyPaid(call, plan, payer, rec.tx!.hash)) });
  }
  const bad = checks.filter((c) => !c.ok).length;
  s.end("verify", bad ? "failed" : checks.length ? "ok" : "skip", checks.length ? `${checks.length - bad} of ${checks.length} paid txs confirmed` : "no paid period to check");

  s.begin("funds");
  const units = parseUnits(plan.amount, plan.token.decimals);
  let tokenBal: bigint | undefined;
  let native = 0n;
  if (payer) {
    native = BigInt((await call("get_balance", { address: payer })).balanceWei);
    if (plan.token.address) {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [payer] });
      tokenBal = BigInt((await call("eth_call", { transaction: { to: plan.token.address, data } })).result);
    }
  }
  const have = plan.token.address ? tokenBal ?? 0n : native;
  const enough = have >= units;
  const fmtHave = `${formatUnits(have, plan.token.decimals).replace(/(\.\d{6})\d+$/, "$1")} ${plan.token.symbol}`;
  s.end("funds", enough ? "ok" : "refused", enough ? `holds ${fmtHave}, needs ${plan.amount}` : `holds ${fmtHave}, needs ${plan.amount}: insufficient`);

  // What a real `run` at this clock would do, in the CLI's own order: funds first, then prepare (here: estimate the gas).
  s.begin("simulate");
  const todo = rows.filter((r) => r.status !== "paid");
  const target = todo[0]?.period ?? next?.period;
  let would: { period?: number; action: string; gas?: string; reason?: string };
  if (target === undefined) would = { action: "nothing: the plan is complete" };
  else if (!payer) would = { period: target, action: "unknown: the ledger names no paying wallet" };
  else if (!enough) would = { period: target, action: "fail", reason: `insufficient ${plan.token.symbol} balance: has ${fmtHave}, needs ${plan.amount}; nothing would be sent` };
  else {
    const tx = plan.token.address
      ? { from: payer, to: plan.token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [plan.recipient, units] }) }
      : { from: payer, to: plan.recipient, value: toHex(units) };
    const gas = BigInt((await call("estimate_gas", { transaction: tx })).gas);
    const dueNow = todo.length > 0;
    would = { period: target, action: dueNow ? "pay now" : "wait until it is due", gas: gas.toString() };
  }
  s.end("simulate", would.action === "fail" ? "refused" : would.gas ? "ok" : "skip", would.action === "fail" ? `period ${would.period}: would fail, nothing sent` : would.gas ? `period ${would.period}: ${would.action} · ${would.gas} gas` : would.action);

  const nx = nextScheduled(plan, now);
  emit({
    type: "done", totalMs: Date.now() - t0, rows, next: next ?? null, nextDue: nx ? nx.due.toISOString() : null, unpaid: unpaidDue(rows) ?? null,
    checks, would, balances: { native: native.toString(), token: tokenBal?.toString() ?? null, have: fmtHave },
    ledger: ledger.periods.map((x) => ({ period: x.period, status: x.status, attempts: x.attempts, reason: x.reason ?? null, receipt: x.receipt ?? null })),
  });
}

const gate = concurrencyGate(2);

export function handle(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  return guard(async () => {
    const url = new URL(req.url);
    const action = actionOf(url, ["info", "status"] as const, "info");
    if (action === "info") return json({ task: "recurring-payment-agent", network: "atlantic", reads: "public Atlantic RPC (read-only; nothing is signed)", plans: PLANS, deploy: deployInfo() });
    const p = parseStatus(url);
    if (!gate.take()) return busy();
    return ndjson((emit) => status(p, emit, deps), gate.release);
  });
}
