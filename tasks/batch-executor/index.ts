// Batch Executor (Medium · 100 pts): takes ≥ 3 independent actions (PHRS or ERC-20 sends), bundles them into ONE
// transaction (Multicall3.aggregate3Value, allowFailure on every call), reports the gas against the actions sent one by one,
// and shows per action what happened when one of them fails.
//   npm run batch-executor -- --plan tasks/batch-executor/plans/all-success.json [--drop-failing] [--approve] [--execute] [--proof name]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, erc20Abi, formatEther, formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { secret } from "../../src/lib/env.js";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { MULTICALL3, PlanError, fmtAmount, resolveActions, runBatch, type Action, type BatchResult, type Call } from "../../src/batch/batch.js";

const TASK = "batch-executor";
const HERE = fileURLToPath(new URL(".", import.meta.url));

export function formatResult(r: BatchResult): string {
  const { sim } = r;
  const out = [`batch @ block ${sim.block}: ${sim.actions.length} action(s) → 1 transaction to Multicall3 ${MULTICALL3}`];
  if (sim.batchFailure) out.push(`  the batch itself would fail: ${sim.batchFailure}`);
  sim.actions.forEach((s, i) => {
    const alone = s.aloneGas !== undefined ? `alone ${s.aloneGas} gas` : `alone: would fail (${s.aloneFailure})`;
    out.push(`  ${i + 1}. ${s.action.label.padEnd(66)} ${s.ok ? "would succeed" : `WOULD FAIL — ${s.failure}`} · ${alone}`);
  });
  for (const d of r.dropped) out.push(`  dropped before sending: ${d.label} — ${d.failure}`);
  if (sim.batchGas !== undefined) out.push(`  batch gas estimate ${sim.batchGas} × ${sim.gasPriceWei} wei = ${formatEther(sim.batchGas * sim.gasPriceWei)} PHRS`);
  if (r.status === "blocked") out.push(`BLOCKED: ${r.blockReason ?? "no viable batch"}; nothing was signed or sent`);
  if (r.status === "simulated") out.push("not sent: pass --execute to send it");
  for (const a of r.approvals ?? []) out.push(`approved Multicall3 to move ${a.token}: ${explorerTx("atlantic", a.tx)}`);
  if (r.sent) out.push(`${r.status === "executed" ? "SENT" : "SENT but REVERTED"}: ${explorerTx("atlantic", r.sent.tx)} (block ${r.sent.block}, gas used ${r.sent.gasUsed})`);
  if (r.outcomes) {
    out.push("per action, read back from the chain:");
    r.outcomes.forEach((o, i) => {
      out.push(`  ${i + 1}. ${o.applied ? "APPLIED" : "NOT APPLIED"}  ${o.action.label} — recipient received ${fmtAmount(o.action.watch, o.received)}${o.failure ? ` (${o.failure})` : ""}`);
    });
    const ok = r.outcomes.filter((o) => o.applied).length;
    out.push(ok === r.outcomes.length ? `  all ${ok} applied` : `  ${ok} of ${r.outcomes.length} applied; ${r.outcomes.length - ok} failed on its own, the others were not undone`);
  }
  if (r.comparison) {
    const c = r.comparison;
    const word = c.savedGas >= 0n ? "saved" : "cost MORE by";
    const abs = c.savedGas >= 0n ? c.savedGas : -c.savedGas;
    out.push(`gas: ${c.comparable} action(s) sent one by one ≈ ${c.individualGas} (sum of estimates) vs ${c.batchGasUsed} used by the batch → ${word} ${abs} (${c.savedPct.replace("-", "")}%)`);
    out.push(`steps: ${c.txAlone} transactions to sign and send alone → 1 batch transaction`);
  }
  return out.join("\n");
}

/** Raise the allowance Multicall3 needs (it moves the tokens on the sender's behalf) to exactly what the batch spends. */
async function approveNeeded(call: Call, mcp: ChainMcp, sender: Hex, actions: Action[]): Promise<{ token: string; tx: Hex }[]> {
  const need = new Map<Hex, { asset: string; amount: bigint }>();
  for (const a of actions) if (a.watch.token) need.set(a.watch.token, { asset: a.watch.asset, amount: (need.get(a.watch.token)?.amount ?? 0n) + a.watch.amount });
  const done: { token: string; tx: Hex }[] = [];
  const signer = testnetSigner(mcp);
  for (const [token, n] of need) {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [sender, MULTICALL3] });
    const have = BigInt((await call("eth_call", { transaction: { to: token, data } })).result);
    if (have >= n.amount) continue;
    const signed = await signer.send({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MULTICALL3, n.amount] }) });
    const rc = await signer.waitForReceipt(signed.hash);
    if (rc.status !== "success") throw new Error(`the approval of ${n.asset} reverted: ${explorerTx("atlantic", signed.hash)}`);
    done.push({ token: n.asset, tx: signed.hash });
  }
  return done;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const reason = (f: string | undefined) => (f ?? "failed").replace(/^reverted: /, "").replace(/\(.*$/, "");
const actionText = (a: Action) => (a.watch.token ? `${formatUnits(a.watch.amount, a.watch.decimals)} ${a.watch.asset}` : `${formatEther(a.watch.amount)} PHRS`) + ` → ${short(a.watch.holder)}`;

/** The same report in at most ~16 short lines (for a narrow terminal, e.g. the demo video). */
export function formatCompact(r: BatchResult): string {
  const { sim } = r;
  const out = [`batch @ ${sim.block}: ${sim.actions.length} actions → 1 transaction via Multicall3`];
  if (sim.batchFailure) out.push(`  the batch itself would fail: ${sim.batchFailure}`);
  sim.actions.forEach((s, i) => {
    out.push(`  ${i + 1} ${actionText(s.action).padEnd(30)} ${s.ok ? "ok" : `WOULD FAIL: ${reason(s.failure)}`}${s.aloneGas !== undefined ? ` · alone ${s.aloneGas} gas` : ""}`);
  });
  for (const d of r.dropped) out.push(`  dropped before sending: ${reason(d.failure)} (${d.label.replace(/ to 0x([0-9a-fA-F]{4})\w*([0-9a-fA-F]{4})$/, " → 0x$1…$2")})`);
  if (r.status === "blocked") out.push(`BLOCKED: ${r.blockReason ?? "no viable batch"}`);
  if (r.status === "simulated") out.push("not sent: pass --execute");
  for (const a of r.approvals ?? []) out.push(`approved ${a.token} for Multicall3: ${short(a.tx)}`);
  if (r.sent) out.push(`${r.status === "executed" ? "SENT" : "REVERTED"} ${short(r.sent.tx)} · block ${r.sent.block} · gas used ${r.sent.gasUsed}`);
  r.outcomes?.forEach((o, i) => out.push(`  ${i + 1} ${o.applied ? "APPLIED" : "NOT APPLIED"}  ${actionText(o.action)}${o.applied ? "" : ` (${reason(o.failure)})`}`));
  if (r.outcomes) {
    const ok = r.outcomes.filter((o) => o.applied).length;
    out.push(ok === r.outcomes.length ? `all ${ok} applied` : `${ok} of ${r.outcomes.length} applied; the failure did not undo the rest`);
  }
  if (r.comparison) {
    const c = r.comparison;
    out.push(`gas: ${c.comparable} sent alone ≈ ${c.individualGas} vs ${c.batchGasUsed} batched → ${c.savedGas >= 0n ? "saved" : "cost more by"} ${c.savedPct.replace("-", "")}%`);
    out.push(`steps: ${c.txAlone} transactions alone → 1`);
  }
  return out.join("\n");
}

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseCli(
    {
      usage: `npm run ${TASK} -- --plan <plan.json> [--drop-failing] [--approve] [--execute] [--compact] [--proof name]`,
      options: {
        plan: { type: "string" }, "drop-failing": { type: "boolean", default: false }, approve: { type: "boolean", default: false }, compact: { type: "boolean", default: false },
        execute: { type: "boolean", default: false }, proof: { type: "string" },
      },
    },
    argv,
  );
  if (!values.plan) throw new UsageError("--plan <file.json> is required");
  // a bare name (--plan one-fails) is a plan shipped in tasks/batch-executor/plans/
  const planFile = /^[\w-]+$/.test(values.plan) ? join(HERE, "plans", `${values.plan}.json`) : values.plan;
  const pk = secret("PRIVATE_KEY");
  if (!pk) throw new UsageError("no sender: set PRIVATE_KEY (~/.config/pharos/testnet.env)");
  const sender = privateKeyToAccount(pk as Hex).address;
  let actions: Action[];
  try { actions = resolveActions((JSON.parse(readFileSync(planFile, "utf8")) as { actions?: unknown }).actions, sender); } catch (e) {
    if (e instanceof PlanError || e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === "ENOENT") throw new UsageError(`${values.plan}: ${(e as Error).message}`);
    throw e;
  }

  const mcp: ChainMcp = await chainMcp("atlantic", { broadcast: values.execute });
  onExit(() => mcp.close());
  const approvals = values.execute && values.approve ? await approveNeeded(mcp.call, mcp, sender, actions) : [];
  const send = async (to: Hex, value: bigint, data: Hex, gas: bigint) => {
    const signer = testnetSigner(mcp);
    const signed = await signer.send({ to, value, data, gas });
    const rc = await signer.waitForReceipt(signed.hash);
    return { tx: signed.hash, status: rc.status, block: rc.blockNumber.toString(), gasUsed: rc.gasUsed, ...(rc.effectiveGasPrice !== undefined ? { effectiveGasPrice: rc.effectiveGasPrice } : {}) };
  };
  const result = await runBatch(mcp.call, sender, actions, { execute: values.execute!, dropFailing: values["drop-failing"]!, send });
  if (approvals.length) result.approvals = approvals;
  console.log(values.compact ? formatCompact(result) : formatResult(result));
  if (values.proof) console.log(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), { sender, plan: values.plan, result }, proofMeta(TASK, mcp))}`);
  if (result.status === "blocked") return 3;
  if (result.status === "reverted") return 1;
  return result.outcomes?.some((o) => !o.applied) ? 4 : 0;
}

if (isMain(import.meta.url)) await runCli(main);
