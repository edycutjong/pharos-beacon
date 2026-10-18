// Wallet Risk Checker (Medium · 100 pts): reads a wallet's or contract's on-chain history through the Chain MCP, checks six signals
// and answers low / medium / high with a plain-language reason for each red flag. `gate` puts it in front of a Policy Gatekeeper
// send: a high-risk recipient is refused before the policy is even asked.
//   npm run wallet-risk-checker -- check 0x… [--network pharos|atlantic] [--block N] [--config f] [--lookback 30000] [--proof label]
//   npm run wallet-risk-checker -- gate --to 0x… --amount 0.0001 [--policy f] [--config f] [--block-on high|medium] [--execute] [--proof label]
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "viem";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { withLock } from "../../src/lib/state.js";
import { appendAudit, verifyAudit } from "../../src/gatekeeper/audit.js";
import { parseGatekeeperPolicy, type GateRequest } from "../../src/gatekeeper/policy.js";
import { runRequests, type Outcome, type Send } from "../../src/gatekeeper/run.js";
import { formatOutcome } from "../policy-gatekeeper/index.js";
import { checkAddress, parseRiskConfig, reportText, type RiskReport } from "../../src/risk/check.js";

const TASK = "wallet-risk-checker";
const HERE = fileURLToPath(new URL(".", import.meta.url));

type Conn = Pick<ChainMcp, "call" | "close" | "endpoint" | "network" | "chainId" | "server"> & { broadcast?: boolean };

const reportForProof = (r: RiskReport) => ({ ...r, block: r.block.toString(), lookbackBlocks: r.lookbackBlocks.toString() });

export async function main(
  { onExit }: RunContext,
  argv = process.argv.slice(2),
  connect: (n: "atlantic" | "pharos", broadcast: boolean) => Promise<Conn> = (n, b) => chainMcp(n, b ? { broadcast: true } : {}),
): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- check <address> [--network pharos|atlantic] [--lookback N] [--block N] [--config f] [--proof label]  |  gate --to <address> --amount <PHRS> [--policy f] [--block-on high|medium] [--execute] [--proof label]`,
      options: {
        network: { type: "string", default: "pharos" }, config: { type: "string", default: join(HERE, "risk-config.json") }, lookback: { type: "string", default: "30000" }, block: { type: "string" },
        to: { type: "string" }, amount: { type: "string" }, policy: { type: "string", default: join(HERE, "gate-policy.json") }, "block-on": { type: "string", default: "high" },
        execute: { type: "boolean", default: false }, proof: { type: "string" }, state: { type: "string" }, audit: { type: "string" },
      },
      positionals: [1, 2],
    },
    argv,
  );
  const cmd = positionals[0];
  if (cmd !== "check" && cmd !== "gate") throw new UsageError(`unknown command ${cmd}: use check or gate`);
  if (values.proof !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(values.proof)) throw new UsageError("--proof takes a label of lower-case letters, digits and hyphens");
  if (!/^\d+$/.test(values.lookback!) || Number(values.lookback) < 1) throw new UsageError("--lookback must be a whole number of blocks >= 1");
  const blockOn = choice("--block-on", values["block-on"], ["high", "medium"] as const);
  let config;
  try {
    config = parseRiskConfig(JSON.parse(readFileSync(values.config!, "utf8")));
  } catch (e) {
    throw new UsageError(`${values.config}: ${(e as Error).message.split("\n")[0]}`);
  }
  const lookbackBlocks = BigInt(values.lookback!);
  if (values.block !== undefined && !/^\d+$/.test(values.block)) throw new UsageError("--block must be a block number");
  const block = values.block === undefined ? undefined : BigInt(values.block);

  if (cmd === "check") {
    const raw = positionals[1];
    if (!raw || !isAddress(raw, { strict: false })) throw new UsageError("check needs an address: check 0x…");
    const network = choice("--network", values.network, ["pharos", "atlantic"] as const);
    const mcp = await connect(network, false);
    onExit(() => mcp.close());
    const report = await checkAddress(mcp.call, getAddress(raw), { network, config, lookbackBlocks, ...(block !== undefined ? { block } : {}) });
    console.log(reportText(report));
    if (values.proof !== undefined) {
      console.log(`proof: ${writeProof(new URL(`proof/${values.proof}.json`, import.meta.url), { config: { flagged: config.flagged.length, trustedSpenders: config.trustedSpenders.length, youngDays: config.youngDays }, report: reportForProof(report) }, proofMeta(TASK, mcp))}`);
    }
    return 0;
  }

  // gate: risk first, then the Policy Gatekeeper
  if (positionals.length > 1) throw new UsageError("gate takes --to and --amount, not a positional address");
  if (!values.to || !isAddress(values.to, { strict: false }) || !values.amount) throw new UsageError("gate needs --to 0x… and --amount <PHRS>");
  let policy;
  try {
    policy = parseGatekeeperPolicy(JSON.parse(readFileSync(values.policy!, "utf8")));
  } catch (e) {
    throw new UsageError(`${values.policy}: ${(e as Error).message}`);
  }
  const to = getAddress(values.to);
  const scratch = join(tmpdir(), "beacon-wallet-risk-checker");
  const stateFile = values.state ?? join(scratch, "spend.json");
  // The committed audit log is proof: only --execute or --proof runs append to it; a plain try-out logs to a scratch file.
  const auditFile = values.audit ?? (values.execute || values.proof ? join(HERE, "audit/gate-audit.jsonl") : join(scratch, "audit.jsonl"));
  const mcp = await connect("atlantic", values.execute);
  onExit(() => mcp.close());
  // Provenance is captured before the run appends to the audit log, so `dirty` is about code, not about this run's own output.
  const meta = values.proof !== undefined ? proofMeta(TASK, mcp) : undefined;
  const report = await checkAddress(mcp.call, to, { network: "atlantic", config, lookbackBlocks });
  console.log(reportText(report));
  const refuse = report.verdict === "high" || (blockOn === "medium" && report.verdict === "medium");
  const request: GateRequest = { to, amount: values.amount, label: `gate ${short(to)}` };
  let outcomes: Outcome[] = [];
  let denied = false;
  if (refuse) {
    denied = true;
    const reason = `recipient risk is ${report.verdict.toUpperCase()}: ${report.reasons.join(" | ")}`;
    const entry = appendAudit(auditFile, { event: "decision", policy: policy.name, label: request.label, request: { to, amount: values.amount }, clock: "real", requestTime: new Date().toISOString(), decision: "deny", rule: "wallet_risk", reason });
    console.log(`\nGATE: DENY by wallet_risk (audit #${entry.seq}). ${values.amount} PHRS → ${to} was NOT sent, and the policy was not asked.`);
  } else {
    console.log(`\nGATE: recipient risk is ${report.verdict.toUpperCase()}, below ${blockOn.toUpperCase()}: passing the request to the Policy Gatekeeper (${policy.name}).`);
    let sender: ChainMcp | undefined;
    const send: Send = async (rcpt, wei, beforeBroadcast) => {
      sender = mcp as unknown as ChainMcp;
      const signer = testnetSigner(sender);
      const signed = await signer.sign(await signer.prepare({ to: rcpt, value: wei }));
      beforeBroadcast(signed.hash);
      await signer.broadcast(signed);
      const r = await signer.waitForReceipt(signed.hash);
      return { tx: signed.hash, status: r.status, block: r.blockNumber.toString(), gasUsed: r.gasUsed.toString() };
    };
    outcomes = await withLock(stateFile, () => runRequests(policy, [request], { stateFile, auditFile, execute: values.execute!, send }));
    outcomes.forEach((o, i) => console.log(formatOutcome(o, i)));
  }
  console.log(`audit log: ${verifyAudit(auditFile)} entries, hash chain intact (${basename(auditFile)})`);
  if (values.proof !== undefined) {
    const name = `${values.proof}.json`;
    console.log(`proof: ${writeProof(new URL(`proof/${name}`, import.meta.url), { gate: { blockOn, denied, outcome: denied ? "denied by wallet_risk, nothing sent" : outcomes[0]?.status }, request, report: reportForProof(report), outcomes }, meta!)}`);
  }
  if (outcomes.some((o) => o.status === "error" || o.status === "reverted")) return 1;
  return denied ? 3 : 0;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

if (isMain(import.meta.url)) await runCli(main);
