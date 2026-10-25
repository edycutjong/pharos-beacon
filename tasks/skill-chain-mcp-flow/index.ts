// Skill + Chain MCP Flow (Medium · 100 pts): the Settlement Verdict skill. One request ("can I treat this transaction as
// paid?") → the skill reads the chain through the Chain MCP and decides SETTLED / WAIT / FAILED / MISMATCH / NOT_FOUND.
//   npm run skill-chain-mcp-flow -- 0x<txhash> [--network pharos|atlantic] [--expect-to 0x…] [--min-value 0.5]
//   npm run skill-chain-mcp-flow -- --latest        (the newest transaction on the network)
//   [--tiers 1=3,100=12,*=32] [--confirmations N] [--follow SECONDS] [--proof name]
// Exit code: 0 SETTLED · 2 WAIT or bad input (usage error) · 1 FAILED, MISMATCH, NOT_FOUND or a runtime error.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress, type Hex } from "viem";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { NETWORKS, chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import { wait } from "../../src/lib/net.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { DEFAULT_TIERS, judge, latestTransaction, parseCoins, parseTiers, render, type Report } from "../../src/settle/verdict.js";

const TASK = "skill-chain-mcp-flow";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const HASH = /^0x[0-9a-fA-F]{64}$/;
const POLL_MS = 2_000;

export interface TraceEntry { step: number; tool: string; args: Record<string, unknown>; ms: number }

/** Wrap a Chain MCP `call` so every tool call of the flow is recorded in order (the flow diagram's evidence). */
export function traced(call: ChainMcp["call"], trace: TraceEntry[]): ChainMcp["call"] {
  return (async (tool: string, args?: Record<string, unknown>, opts?: unknown) => {
    const t0 = Date.now();
    const out = await (call as (...a: unknown[]) => Promise<unknown>)(tool, args, opts);
    trace.push({ step: trace.length + 1, tool, args: args ?? {}, ms: Date.now() - t0 });
    return out;
  }) as ChainMcp["call"];
}

export async function main({ onExit }: RunContext, argv = process.argv.slice(2), connect: typeof chainMcp = chainMcp): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- <0x txhash> | --latest [--network pharos|atlantic] [--expect-to 0x…] [--min-value 0.5] [--tiers 1=3,100=12,*=32] [--confirmations N] [--follow SECONDS] [--proof name]`,
      options: {
        network: { type: "string", default: "pharos" }, latest: { type: "boolean", default: false },
        "expect-to": { type: "string" }, "min-value": { type: "string" },
        tiers: { type: "string" }, confirmations: { type: "string" }, follow: { type: "string" }, proof: { type: "string" },
      },
      positionals: [0, 1],
    },
    argv,
  );
  const network = choice("--network", values.network, NETWORKS);
  const hashArg = positionals[0];
  if (hashArg && values.latest) throw new UsageError("give a transaction hash or --latest, not both");
  if (!hashArg && !values.latest) throw new UsageError("give a transaction hash (0x + 64 hex digits) or --latest");
  if (hashArg && !HASH.test(hashArg)) throw new UsageError(`"${hashArg}" is not a transaction hash (0x + 64 hex digits)`);
  const to = values["expect-to"];
  if (to !== undefined && !isAddress(to, { strict: false })) throw new UsageError("--expect-to must be an address (0x + 40 hex digits)");
  try { if (values["min-value"] !== undefined) parseCoins(values["min-value"]); } catch (e) { throw new UsageError(`--min-value: ${(e as Error).message}`); }
  let tiers = DEFAULT_TIERS;
  try { if (values.tiers) tiers = parseTiers(values.tiers); } catch (e) { throw new UsageError(`--tiers: ${(e as Error).message}`); }
  let override: number | undefined;
  if (values.confirmations !== undefined) {
    override = Number(values.confirmations);
    if (!Number.isInteger(override) || override < 1) throw new UsageError("--confirmations must be a whole number ≥ 1");
  }
  const follow = values.follow === undefined ? 0 : Number(values.follow);
  if (!Number.isFinite(follow) || follow < 0 || follow > 600) throw new UsageError("--follow must be 0 to 600 seconds");

  const mcp = await connect(network);
  onExit(() => mcp.close());
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined;
  const trace: TraceEntry[] = [];
  const call = traced(mcp.call, trace);

  let hash = hashArg as Hex | undefined;
  if (!hash) {
    const found = await latestTransaction(call);
    if (!found) throw new UsageError("no transaction in the last 60 blocks: pass a hash");
    hash = found.hash;
    console.log(`latest transaction: ${hash} (block ${found.block})`);
  }
  const opts = { tiers, expect: { to: to as Hex | undefined, minValue: values["min-value"] }, override };
  const started = Date.now();
  const seen: { verdict: string; confirmations?: number; head: string }[] = [];
  let report: Report;
  for (;;) {
    report = await judge(call, hash, opts);
    seen.push({ verdict: report.verdict, confirmations: report.confirmations, head: report.facts.head.toString() });
    if (report.verdict !== "WAIT" || Date.now() - started >= follow * 1000) break;
    console.log(`WAIT  ${report.confirmations ?? 0}/${report.required ?? "?"} confirmations at head ${report.facts.head}; asking again in ${POLL_MS / 1000} s`);
    await wait(POLL_MS);
  }
  console.log(render(report, `${network} (chain ${mcp.chainId})`));
  console.log(`explorer ${explorerTx(network, hash)}`);

  if (values.proof) {
    const f = report.facts;
    const body = {
      verdict: report.verdict, rule: report.rule, confirmations: report.confirmations, required: report.required, tier: report.tier,
      waitBlocks: report.waitBlocks, waitSeconds: report.waitSeconds,
      facts: { ...f, valueWei: f.valueWei.toString(), block: f.block?.toString(), head: f.head.toString(), gasUsed: f.gasUsed?.toString() },
      explorer: explorerTx(network, hash), polls: seen, flow: trace,
    };
    console.log(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), body, meta!)}`);
  }
  return report.verdict === "SETTLED" ? 0 : report.verdict === "WAIT" ? 2 : 1;
}

if (isMain(import.meta.url)) await runCli(main);
