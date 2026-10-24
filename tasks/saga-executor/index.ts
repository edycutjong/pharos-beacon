// Saga Executor (Hard · 200 pts): approve → swap → approve → deposit, each step verified before the next, retried on transient
// failures, rolled back on a permanent one, with a crash-safe journal. Atlantic testnet only, against OUR OWN test pool and
// vault (Atlantic has none): tasks/saga-executor/contracts, addresses in deployments.json.
//   npm run saga-executor -- plan   [--amount 0.001]
//   npm run saga-executor -- run    --id <name> --execute [--amount 0.001] [--inject drop:swap,underpriced:swap,crash:swap:sent] [--proof name]
//   npm run saga-executor -- resume --id <name> --execute [--proof name]
//   npm run saga-executor -- status --id <name>
//   npm run saga-executor -- vault open|close --execute      (the vault owner's key; closing it is how the demo forces the deposit to fail)
// Exit: 0 completed · 3 rolled back cleanly (the saga did not complete, nothing stranded) · 1 stuck or an error · 2 bad usage.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, formatUnits, parseUnits, type Hex } from "viem";
import { isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { withLock } from "../../src/lib/state.js";
import { checksTable, defiSaga, paramsFromRecord, paramsToRecord, poolAbi, vaultAbi, type SagaParams } from "../../src/saga/defi.js";
import { DEFAULT_POLICY, loadJournal, newJournal, Saga, statusTable, type CrashPoint, type Inject, type Journal, type LogEntry, type RetryPolicy } from "../../src/saga/engine.js";
import { chainPort } from "../../src/saga/port.js";

const TASK = "saga-executor";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEPLOY = JSON.parse(readFileSync(join(HERE, "deployments.json"), "utf8")) as {
  tokens: Record<"WPHRS" | "USDC", { address: Hex; decimals: number }>;
  pool: { address: Hex };
  vault: { address: Hex; owner: Hex };
};

/** "drop:swap", "underpriced:swap", "crash:swap:sent" (comma separated). */
export function parseInject(spec: string | undefined): Inject[] {
  if (!spec) return [];
  return spec.split(",").map((s) => {
    const [kind, action, point] = s.trim().split(":");
    if ((kind === "drop" || kind === "underpriced") && action && !point) return { kind, action };
    if (kind === "crash" && action && (point === "signed" || point === "sent" || point === "mined")) return { kind, action, point: point as CrashPoint };
    throw new UsageError(`--inject ${JSON.stringify(s)}: use drop:<action>, underpriced:<action> or crash:<action>:signed|sent|mined`);
  });
}

const hms = (t: string) => t.slice(11, 19);
const printLog = (e: LogEntry) => console.log(`${hms(e.t)}  ${e.action.padEnd(18)}${e.event.padEnd(15)}${e.detail ?? ""}`);

function printTxLinks(j: Journal): void {
  for (const a of j.actions) {
    for (const t of a.attempts) if (t.hash !== "0x" && (t.state === "mined" || t.state === "reverted")) console.log(`  ${a.phase === "undo" ? "undo " : ""}${a.id.padEnd(18)}${explorerTx("atlantic", t.hash)}`);
  }
}

function params(wallet: Hex, amount: string, slippageBps: number): SagaParams {
  const { WPHRS, USDC } = DEPLOY.tokens;
  return {
    wallet, pool: DEPLOY.pool.address, vault: DEPLOY.vault.address, tokenIn: WPHRS.address, tokenOut: USDC.address,
    symbolIn: "WPHRS", symbolOut: "USDC", decimalsIn: WPHRS.decimals, decimalsOut: USDC.decimals,
    amountIn: parseUnits(amount, WPHRS.decimals), slippageBps,
  };
}

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- plan|run|resume|status|vault [open|close] [--id name] [--amount 0.001] [--slippage-bps 50] [--inject kind:action[:point],…] [--retries 3] [--backoff-ms 2000] [--receipt-timeout-s 30] [--execute] [--proof name]`,
      options: {
        id: { type: "string" }, amount: { type: "string", default: "0.001" }, "slippage-bps": { type: "string", default: "50" }, inject: { type: "string" },
        retries: { type: "string", default: String(DEFAULT_POLICY.maxAttempts) }, "backoff-ms": { type: "string", default: String(DEFAULT_POLICY.backoffMs) },
        "receipt-timeout-s": { type: "string", default: String(DEFAULT_POLICY.receiptTimeoutMs / 1000) }, execute: { type: "boolean", default: false }, proof: { type: "string" },
      },
      positionals: [1, 2],
    },
    argv,
  );
  const cmd = positionals[0];
  if (!["plan", "run", "resume", "status", "vault"].includes(cmd!)) throw new UsageError(`unknown command ${cmd}: use plan, run, resume, status or vault`);
  const num = (flag: string, v: string, min: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) throw new UsageError(`--${flag} must be a number ≥ ${min}, got ${JSON.stringify(v)}`);
    return n;
  };
  const policy: RetryPolicy = {
    ...DEFAULT_POLICY,
    maxAttempts: Math.floor(num("retries", values.retries!, 1)),
    backoffMs: num("backoff-ms", values["backoff-ms"]!, 0),
    receiptTimeoutMs: num("receipt-timeout-s", values["receipt-timeout-s"]!, 1) * 1000,
  };
  const idOf = () => {
    if (!values.id || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(values.id)) throw new UsageError("--id <name> is required (lowercase letters, digits, hyphens)");
    return values.id;
  };
  const journalFile = (id: string) => join(HERE, "state", `${id}.json`);

  if (cmd === "status") {
    const j = loadJournal(journalFile(idOf()));
    if (!j) throw new UsageError(`no saga journal named ${values.id} (state/${values.id}.json)`);
    console.log(statusTable(j));
    j.log.slice(-12).forEach(printLog);
    return 0;
  }

  const mcp = await chainMcp("atlantic", { broadcast: values.execute });
  onExit(() => mcp.close());

  if (cmd === "vault") {
    const to = positionals[1];
    if (to !== "open" && to !== "close") throw new UsageError("vault open|close");
    const owner = testnetSigner(mcp); // PRIVATE_KEY: the vault's deployer and owner
    const { open } = await readVault(mcp);
    console.log(`vault ${DEPLOY.vault.address} is ${open ? "OPEN" : "CLOSED"}; owner ${DEPLOY.vault.owner}`);
    if (owner.address.toLowerCase() !== DEPLOY.vault.owner.toLowerCase()) throw new Error(`PRIVATE_KEY is ${owner.address}, not the vault owner`);
    if (!values.execute) {
      console.log(`would ${to} the vault; add --execute to send the transaction`);
      return 0;
    }
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "setStatus", args: [to === "open", 2n ** 256n - 1n] });
    const meta = values.proof ? proofMeta(TASK, mcp) : undefined;
    const s = await owner.send({ to: DEPLOY.vault.address, data });
    const r = await owner.waitForReceipt(s.hash);
    console.log(`vault ${to} ${r.status} in block ${r.blockNumber}: ${explorerTx("atlantic", s.hash)}`);
    const now = await readVault(mcp);
    console.log(`vault ${DEPLOY.vault.address} is now ${now.open ? "OPEN" : "CLOSED"} (read back)`);
    if (values.proof) {
      console.log(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), { command: `vault ${to}`, vault: DEPLOY.vault.address, owner: owner.address, tx: s.hash, explorer: explorerTx("atlantic", s.hash), receipt: { status: r.status, blockNumber: r.blockNumber.toString(), gasUsed: r.gasUsed.toString() }, openAfter: now.open }, meta!)}`);
    }
    return r.status === "success" && now.open === (to === "open") ? 0 : 1;
  }

  if (cmd === "plan") {
    // Keyless: reads the pool quote and the vault state only.
    const amountIn = parseUnits(values.amount!, DEPLOY.tokens.WPHRS.decimals);
    const v = await readVault(mcp);
    const quote = await mcp.call("eth_call", { transaction: { to: DEPLOY.pool.address, data: encodeFunctionData({ abi: poolAbi, functionName: "quote", args: [DEPLOY.tokens.WPHRS.address, amountIn] }) } });
    console.log(`pool ${DEPLOY.pool.address} · vault ${DEPLOY.vault.address} (${v.open ? "open" : "CLOSED: the deposit will fail and the saga will roll back"}) · Atlantic`);
    console.log(`1 approve-in   approve the pool to pull ${formatUnits(amountIn, DEPLOY.tokens.WPHRS.decimals)} WPHRS`);
    console.log(`2 swap         swap it for ${formatUnits(BigInt(quote.result), DEPLOY.tokens.USDC.decimals)} USDC (pool quote)`);
    console.log("3 approve-out  approve the vault to pull that USDC");
    console.log("4 deposit      deposit it into the vault");
    console.log("rollback       undo, newest first: withdraw → revoke vault allowance → swap back (approve, swap, revoke) → revoke pool allowance");
    console.log("add --execute to run it (run --id <name> --execute; the saga wallet is PRIVATE_KEY_2)");
    return 0;
  }

  // The saga's wallet is the second key, so the vault owner (the first) closing the vault is a different party's action.
  const signer = testnetSigner(mcp, { envVar: "PRIVATE_KEY_2" });
  const port = chainPort(mcp, signer);
  const p = params(signer.address, values.amount!, num("slippage-bps", values["slippage-bps"]!, 0));

  const id = idOf();
  const file = journalFile(id);
  const inject = parseInject(values.inject);
  let j = loadJournal(file);

  if (cmd === "run") {
    if (j) throw new UsageError(`saga ${id} already exists (status ${j.status}); use resume --id ${id}, or pick a new --id`);
    if (!values.execute) throw new UsageError("run sends transactions on Atlantic: add --execute (plan shows what it would do)");
    const defs = defiSaga(p);
    j = newJournal({ id, wallet: p.wallet, params: paramsToRecord(p) }, defs.forward, new Date());
  } else {
    // resume
    if (!j) throw new UsageError(`no saga journal named ${id}`);
    if (!values.execute) {
      console.log(statusTable(j));
      console.log(`add --execute to resume ${id}`);
      return 0;
    }
  }
  const sagaP = paramsFromRecord(j.params);
  if (sagaP.wallet.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`journal ${id} belongs to ${sagaP.wallet}, but PRIVATE_KEY_2 is ${signer.address}`);
  const def = defiSaga(sagaP);
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined; // before the journal exists: `dirty` is about the code
  if (j.data["native0"] === undefined) j.data["native0"] = String(BigInt((await mcp.call("get_balance", { address: signer.address })).balanceWei));

  console.log(`${cmd === "run" ? "starting" : "resuming"} saga ${id} · wallet ${signer.address} · ${formatUnits(sagaP.amountIn, sagaP.decimalsIn)} WPHRS → USDC → vault · retries ${policy.maxAttempts}, backoff ${policy.backoffMs} ms ×2, receipt timeout ${policy.receiptTimeoutMs / 1000} s`);
  if (inject.length) console.log(`fault injection: ${inject.map((i) => (i.kind === "crash" ? `crash ${i.action} at ${i.point}` : `${i.kind} ${i.action} (attempt 1)`)).join(", ")}`);
  const saga = new Saga(def, j, port, file, {
    policy, inject, onLog: printLog,
    crash: () => {
      process.kill(process.pid, "SIGKILL");
      throw new Error("unreachable");
    },
  });
  const final = await withLock(file, () => saga.run());

  const native1 = BigInt((await mcp.call("get_balance", { address: signer.address })).balanceWei);
  console.log("");
  console.log(statusTable(final));
  if (final.checks) {
    console.log(`\nbalance invariant (${final.status === "completed" ? "expected end state" : "every touched balance must equal its pre-saga value"}):`);
    console.log(checksTable(final.checks));
  }
  console.log(`\nPHRS spent on gas this saga: ${formatUnits(BigInt(final.data["native0"]!) - native1, 18)} (not refundable)`);
  console.log("transactions:");
  printTxLinks(final);
  if (values.proof) {
    console.log(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), { command: cmd, policy, inject, journal: final, nativeAfterWei: native1.toString() }, meta!)}`);
  }
  return final.status === "completed" ? 0 : final.status === "rolled-back" ? 3 : 1;
}

async function readVault(mcp: Awaited<ReturnType<typeof chainMcp>>): Promise<{ open: boolean }> {
  const out = await mcp.call("eth_call", { transaction: { to: DEPLOY.vault.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "open" }) } });
  return { open: BigInt(out.result) === 1n };
}

if (isMain(import.meta.url)) await runCli(main);
