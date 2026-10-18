// Recurring Payment Agent (Medium · 100 pts): a schedule (weekly or monthly) with amount, token and recipient, paid on time
// from a ledger that makes every period payable once. Atlantic testnet only.
//   npm run recurring-payment-agent -- status --plan plans/rent.json [--now 2026-11-08T09:00:00Z]
//   npm run recurring-payment-agent -- run    --plan plans/rent.json --now <ISO> [--execute] [--discord] [--proof name]
// `--now` is an injected clock: it says what "today" is for the schedule (the demo plays two consecutive periods in minutes).
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { envOr } from "../../src/lib/env.js";
import { isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { withLock } from "../../src/lib/state.js";
import { consoleNotifier, discordNotifier, loadWebhook } from "../../src/watch/discord.js";
import { compactTable, historyRows, historyTable, loadLedger, parsePlan, runDue, wrapLine, type Port } from "../../src/recurring/agent.js";

const TASK = "recurring-payment-agent";
const HERE = fileURLToPath(new URL(".", import.meta.url));

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- status|run --plan plans/<file>.json [--now <ISO time>] [--execute] [--discord] [--compact] [--state file] [--proof name]`,
      options: {
        plan: { type: "string" }, now: { type: "string" }, state: { type: "string" },
        execute: { type: "boolean", default: false }, compact: { type: "boolean", default: false }, discord: { type: "boolean", default: false }, proof: { type: "string" },
      },
      positionals: [1, 1],
    },
    argv,
  );
  const cmd = positionals[0];
  if (cmd !== "status" && cmd !== "run") throw new UsageError(`unknown command ${cmd}: use status or run`);
  if (!values.plan) throw new UsageError("--plan <file.json> is required");
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new UsageError("--now must be a date, e.g. 2026-11-08T09:00:00Z");
  let plan;
  try { plan = parsePlan(JSON.parse(readFileSync(values.plan, "utf8"))); } catch (e) { throw new UsageError(`${values.plan}: ${(e as Error).message}`); }
  const file = values.state ?? envOr("RECURRING_STATE", join(HERE, "state", `${plan.id}.json`));
  // --compact: lines under 62 columns, for a narrow terminal (the demo video). Same facts, shorter table.
  const table = (l: ReturnType<typeof loadLedger>) => (values.compact ? compactTable(plan, l, now) : historyTable(plan, l, now));
  const say = (l: string) => (values.compact ? wrapLine(l).forEach((x) => console.log(x)) : console.log(l));
  if (values.now) say(`clock: injected --now ${now.toISOString()} (not the real time)`);

  if (cmd === "status") {
    console.log(table(loadLedger(file, plan)));
    return 0;
  }

  const mcp = await chainMcp("atlantic", { broadcast: values.execute });
  onExit(() => mcp.close());
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined; // before the run writes its ledger: `dirty` is about the code
  const signer = testnetSigner(mcp);
  const port: Port = {
    address: signer.address,
    nativeBalance: async () => BigInt((await mcp.call("get_balance", { address: signer.address })).balanceWei),
    tokenBalance: async (token) =>
      BigInt((await mcp.call("eth_call", { transaction: { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [signer.address] }) } })).result),
    receipt: async (hash) => {
      const r = await mcp.call("get_transaction_receipt", { hash });
      return r ? { status: r.status === "0x1" ? "success" : "reverted", blockNumber: BigInt(r.blockNumber), gasUsed: BigInt(r.gasUsed) } : null;
    },
    signer,
  };

  if (!values.execute) {
    // Dry run: nothing is signed, sent or written. It says what a run would do.
    const ledger = loadLedger(file, plan);
    const { rows } = historyRows(plan, ledger, now);
    const todo = rows.filter((r) => r.status !== "paid");
    console.log(todo.length ? `would process ${todo.length} period(s): ${todo.map((r) => `#${r.period} (${r.status})`).join(", ")} — add --execute to pay` : "nothing to pay: every period due so far is already paid");
    console.log(table(ledger));
    return 0;
  }

  const notifier = values.discord ? discordNotifier(loadWebhook()) : consoleNotifier((s) => console.log(`RECEIPT [console] ${s}`));
  say(`paying wallet ${values.compact ? `${signer.address.slice(0, 8)}…${signer.address.slice(-4)}` : signer.address} (Atlantic)`);
  const events = await withLock(file, () => runDue({ plan, file, port, now, notifier, log: say }));
  const ledger = loadLedger(file, plan);
  console.log(events.length ? "" : "nothing due at this clock");
  console.log(table(ledger));
  if (values.proof) {
    console.log(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), { plan, clock: { injected: Boolean(values.now), now: now.toISOString() }, events, ledger }, meta!)}`);
  }
  return events.some((e) => e.action === "failed" || e.action === "reconciled-failed") ? 1 : 0;
}

if (isMain(import.meta.url)) await runCli(main);
