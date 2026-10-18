// Trend Watcher (Hard · 200 pts): a Skill with memory. Every run stores one observation of a metric and acts ONLY when the
// stored history shows `--steps` consecutive moves in one direction (default: 3 falls in a row). One spike never triggers.
//   npm run trend-watcher -- observe --metric balance --address 0x… [--network atlantic] [--steps 3] [--direction fall] [--block N] [--discord] [--proof name]
//   npm run trend-watcher -- history --metric balance --address 0x… [--last 12]
// Metrics: balance (native), supply (ERC-20 totalSupply, --token 0x… [--decimals 18]), basefee. Reads go through the Chain MCP.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envOr } from "../../src/lib/env.js";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { NETWORKS, chainMcp } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { withLock } from "../../src/lib/state.js";
import { consoleNotifier, discordNotifier, loadWebhook } from "../../src/watch/discord.js";
import { MIN_STEPS, describeMetric, evaluate, fmt, historyTable, loadTrend, observe, parseMetric, type MetricSpec } from "../../src/trend/watch.js";

const TASK = "trend-watcher";
const HERE = fileURLToPath(new URL(".", import.meta.url));

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- observe|history --metric balance|supply|basefee [--network atlantic|pharos] [--address 0x…] [--token 0x…] [--steps 3] [--direction fall|rise] [--block N] [--discord] [--proof name]`,
      options: {
        metric: { type: "string", default: "balance" }, network: { type: "string", default: "atlantic" },
        address: { type: "string" }, token: { type: "string" }, decimals: { type: "string" },
        steps: { type: "string", default: "3" }, direction: { type: "string", default: "fall" },
        block: { type: "string" }, last: { type: "string", default: "12" },
        discord: { type: "boolean", default: false }, proof: { type: "string" },
        // TREND_STATE: another history file (a recording that must not touch the committed one).
        state: { type: "string", default: envOr("TREND_STATE", join(HERE, "state/history.json")) },
      },
      positionals: [1, 1],
    },
    argv,
  );
  const cmd = positionals[0];
  if (cmd !== "observe" && cmd !== "history") throw new UsageError(`unknown command ${cmd}: use observe or history`);
  const network = choice("--network", values.network, NETWORKS);
  const steps = Number(values.steps);
  if (!Number.isInteger(steps) || steps < MIN_STEPS) throw new UsageError(`--steps must be a whole number ≥ ${MIN_STEPS} (a trend needs at least ${MIN_STEPS + 1} observations)`);
  const rule = { direction: choice("--direction", values.direction, ["fall", "rise"] as const), steps };
  const last = Number(values.last);
  if (!Number.isInteger(last) || last < 1) throw new UsageError("--last must be a whole number ≥ 1");
  let pin: bigint | undefined;
  if (values.block !== undefined) {
    if (!/^\d+$/.test(values.block)) throw new UsageError("--block must be a block number");
    pin = BigInt(values.block);
  }
  let spec: MetricSpec;
  try {
    spec = parseMetric({ metric: values.metric!, network, address: values.address, token: values.token, decimals: values.decimals === undefined ? undefined : Number(values.decimals) });
  } catch (e) { throw new UsageError((e as Error).message); }
  const file = values.state!;

  if (cmd === "history") {
    const st = loadTrend(file, spec);
    console.log(historyTable(spec, st.observations, rule, last));
    return 0;
  }

  const mcp = await chainMcp(network);
  onExit(() => mcp.close());
  // Taken before this run touches the history file: a proof's `dirty` is about the code, not about its own observation.
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined;
  const notifier = values.discord ? discordNotifier(loadWebhook()) : consoleNotifier((s) => console.log(`ACTION [console] ${s}`));
  const fired: string[] = [];
  const res = await withLock(file, () => observe({
    file, spec, rule, call: mcp.call, pinBlock: pin,
    act: async (message) => {
      const d = await notifier.send(message);
      fired.push(d.id ? `${notifier.name}:${d.id}` : notifier.name);
      if (d.id) console.log(`ACTION [discord] message ${d.id}: ${message}`);
    },
  }));
  const o = res.observation;
  console.log(`observed ${describeMetric(spec)}: ${fmt(spec, BigInt(o.value))} at block ${o.block} — ${res.added === "added" ? "stored" : res.added === "duplicate" ? "NOT stored: block already in the history (de-duplicated)" : "NOT stored: older than the newest stored block"}`);
  console.log(historyTable(spec, res.state.observations, rule, last));
  console.log(res.acted.length ? `acted ${res.acted.length}× (the trend was met)` : `no action: ${res.evaluation.state === "too-few" ? `only ${res.state.observations.length} of the ${steps + 1} observations a ${steps}-move trend needs` : `streak ${res.evaluation.streak} of ${steps}`}`);

  if (values.proof) {
    const ev = evaluate(res.state.observations, rule);
    console.log(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), { metric: spec, rule, observation: o, added: res.added, evaluation: ev, acted: res.acted.map((i) => ({ index: i + 1, block: res.state.observations[i]!.block, notifier: fired.shift() })), history: res.state.observations }, meta!)}`);
  }
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
