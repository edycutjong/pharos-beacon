// Policy Gatekeeper (Medium · 100 pts): checks a requested action against spend limits, an allowlist and a time window
// before it may execute. Every request gets allow/deny + the deciding rule; a denied request is never sent.
//   npm run policy-gatekeeper -- <policy.json> (--to 0x… --amount 0.001 | --requests <file.json>) [--execute] [--proof]
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envOr } from "../../src/lib/env.js";
import { isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { withLock } from "../../src/lib/state.js";
import { verifyAudit } from "../../src/gatekeeper/audit.js";
import { parseGatekeeperPolicy, type GateRequest } from "../../src/gatekeeper/policy.js";
import { runRequests, type Outcome, type Send } from "../../src/gatekeeper/run.js";

const TASK = "policy-gatekeeper";
const HERE = dirname(fileURLToPath(import.meta.url));

export function formatOutcome(o: Outcome, i: number): string {
  const d = o.decision;
  const head = `#${i + 1} ${o.request.label ?? ""}`.trim();
  const lines = [`${head}: ${String(o.request.amount)} PHRS → ${String(o.request.to)}${o.request.at ? ` @ ${o.request.at}` : ""}`];
  for (const c of d.checks) lines.push(`  ${c.pass ? "PASS" : "FAIL"} ${c.rule}: ${c.detail}`);
  lines.push(`  => ${d.decision.toUpperCase()} by ${d.rule} (audit #${o.audit})`);
  if (o.status === "allowed-dry-run") lines.push(`  not sent: ${o.note}`);
  if (o.status === "denied") lines.push("  not sent: denied requests are never executed");
  if (o.tx) lines.push(`  tx ${o.status}: ${explorerTx("atlantic", o.tx)}`);
  if (o.status === "error") lines.push(`  error: ${o.note}`);
  return lines.join("\n");
}

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- <policy.json> (--to 0x… --amount 0.001 | --requests <file.json>) [--at ISO] [--execute] [--fail-on-deny] [--proof] [--state f] [--audit f]`,
      options: {
        to: { type: "string" }, amount: { type: "string" }, requests: { type: "string" }, at: { type: "string" },
        execute: { type: "boolean", default: false }, "fail-on-deny": { type: "boolean", default: false }, proof: { type: "boolean", default: false },
        // GATEKEEPER_STATE / GATEKEEPER_AUDIT change the defaults (a second agent, or a recording that must not touch the main window).
        state: { type: "string", default: envOr("GATEKEEPER_STATE", join(HERE, "state/spend.json")) }, audit: { type: "string" },
      },
      positionals: [1, 1],
    },
    argv,
  );
  // The committed audit log is proof: only --execute or --proof runs append to it. A plain dry-run (e.g. a reviewer trying
  // the command) logs to a scratch file so the repo stays clean. --audit or GATEKEEPER_AUDIT always wins.
  values.audit ??= envOr("GATEKEEPER_AUDIT", values.execute || values.proof ? join(HERE, "audit/audit.jsonl") : join(tmpdir(), "beacon-policy-gatekeeper", "audit.jsonl"));
  let policy;
  try {
    policy = parseGatekeeperPolicy(JSON.parse(readFileSync(positionals[0]!, "utf8")));
  } catch (e) {
    throw new UsageError(`${positionals[0]}: ${(e as Error).message}`);
  }
  let requests: GateRequest[];
  if (values.requests) {
    if (values.to || values.amount) throw new UsageError("use either --requests or --to/--amount");
    try {
      requests = JSON.parse(readFileSync(values.requests, "utf8"));
    } catch (e) {
      throw new UsageError(`${values.requests}: ${(e as Error).message}`);
    }
    if (!Array.isArray(requests) || requests.length === 0) throw new UsageError(`${values.requests} must be a non-empty array of {to, amount, at?, label?}`);
  } else {
    if (!values.to || !values.amount) throw new UsageError("give --to and --amount, or --requests");
    requests = [{ to: values.to, amount: values.amount, ...(values.at ? { at: values.at } : {}) }];
  }
  if (values.at && values.requests) throw new UsageError("--at applies to --to/--amount only; put `at` inside each request");

  let mcp: ChainMcp | undefined;
  const send: Send = async (to, wei, beforeBroadcast) => {
    mcp ??= await chainMcp("atlantic", { broadcast: true });
    onExit(() => mcp!.close());
    const signer = testnetSigner(mcp);
    const prepared = await signer.prepare({ to, value: wei });
    const signed = await signer.sign(prepared);
    beforeBroadcast(signed.hash);
    await signer.broadcast(signed);
    const r = await signer.waitForReceipt(signed.hash);
    return { tx: signed.hash, status: r.status, block: r.blockNumber.toString(), gasUsed: r.gasUsed.toString() };
  };

  const outcomes = await withLock(values.state!, () => runRequests(policy, requests, { stateFile: values.state!, auditFile: values.audit!, execute: values.execute!, send }));
  outcomes.forEach((o, i) => console.log(formatOutcome(o, i)));
  const n = (s: Outcome["status"]) => outcomes.filter((o) => o.status === s).length;
  const executed = n("executed");
  console.log(`summary: ${outcomes.length} requests · ${outcomes.filter((o) => o.decision.decision === "allow").length} allowed · ${n("denied")} denied · ${executed} sent`);
  console.log(`audit log: ${verifyAudit(values.audit!)} entries, hash chain intact (${values.audit})`);

  if (values.proof) {
    const name = `${basename(positionals[0]!, ".json")}.${executed ? "live" : outcomes.every((o) => o.status === "denied") ? "denied" : "dry-run"}.json`;
    // No chain call is needed when nothing was sent (every request denied or dry-run): say so instead of naming an endpoint.
    const meta = proofMeta(TASK, mcp ?? { network: "atlantic", chainId: 688689, endpoint: "none (no chain call: nothing was sent)", server: undefined });
    console.log(`proof: ${writeProof(join(HERE, "proof", name), { policy: policyForProof(policy), outcomes }, meta)}`);
  }
  if (outcomes.some((o) => o.status === "error" || o.status === "reverted")) return 1;
  return values["fail-on-deny"] && n("denied") > 0 ? 3 : 0;
}

/** The policy as the proof records it (bigints become decimal strings in wei). */
const policyForProof = (p: unknown) => JSON.parse(JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? `${v}` : v)));

if (isMain(import.meta.url)) await runCli(main);
