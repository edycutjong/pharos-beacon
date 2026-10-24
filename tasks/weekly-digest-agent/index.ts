// Weekly Digest Agent (Medium · 100 pts): a periodic summary of a wallet's activity (weekly by default, configurable) with key numbers
// against the previous period, the top three notable events and who is new, delivered to Discord and written as a Markdown file.
// Read-only (Chain MCP); the only thing it can send is the Discord message. It describes the last FINISHED period, so a second run in
// the same week returns the same digest and delivers nothing twice (the state file remembers the period and the previous numbers).
//   npm run weekly-digest-agent -- --wallet 0x… [--cadence weekly|daily|monthly|Nd] [--now ISO] [--state f] [--out dir]
//     [--deliver discord|console|none] [--baseline auto|none] [--force] [--compact] [--scan-blocks N] [--max-txs N] [--network pharos|atlantic]
//     [--print-schedule] [--proof label]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectActivity, parseWallet, rangeForTimes, type Call } from "../../src/activity/engine.js";
import { CRON, digestChat, digestCompact, digestMarkdown, metricsOf, parseCadence, periodAt, topEvents, type Metrics } from "../../src/activity/digest.js";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp, type ChainMcp, type Network } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { readState, writeState } from "../../src/lib/state.js";
import { consoleNotifier, discordNotifier, loadWebhook, type Notifier } from "../../src/watch/discord.js";

const TASK = "weekly-digest-agent";
type Conn = Pick<ChainMcp, "call" | "close" | "endpoint" | "network" | "chainId" | "server">;
interface DigestState { wallet: string; network: string; cadence: string; periodLabel: string; periodEnd: number; metrics: Metrics; delivered?: { id?: string; at: string }; file?: string }
const checkState = (v: unknown): DigestState | null => {
  if (v === null || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length === 0) return null;
  const s = v as DigestState;
  if (typeof s.periodEnd !== "number" || typeof s.wallet !== "string" || typeof s.periodLabel !== "string" || typeof s.metrics !== "object") throw new Error("digest state has the wrong shape; refusing to guess (fix or remove it)");
  return s;
};

export async function main(
  { onExit }: RunContext,
  argv = process.argv.slice(2),
  connect: (n: Network) => Promise<Conn> = chainMcp,
  makeNotifier?: (kind: "discord" | "console") => Notifier,
  clock: () => Date = () => new Date(),
): Promise<number> {
  const { values } = parseCli(
    {
      usage: `npm run ${TASK} -- --wallet 0x… [--cadence weekly|daily|monthly|Nd] [--now ISO] [--state f] [--out dir] [--deliver discord|console|none] [--baseline auto|none] [--force] [--compact] [--scan-blocks N] [--max-txs N] [--network pharos|atlantic] [--print-schedule] [--proof label]`,
      options: {
        wallet: { type: "string" }, cadence: { type: "string", default: "weekly" }, now: { type: "string" }, state: { type: "string" }, out: { type: "string" },
        deliver: { type: "string", default: "none" }, baseline: { type: "string", default: "auto" }, force: { type: "boolean", default: false }, "scan-blocks": { type: "string", default: "0" },
        "max-txs": { type: "string", default: "400" }, compact: { type: "boolean", default: false }, network: { type: "string", default: "pharos" }, "print-schedule": { type: "boolean", default: false }, proof: { type: "string" },
      },
    },
    argv,
  );
  if (!values.wallet) throw new UsageError("--wallet is required");
  let wallet;
  let cadence;
  try {
    wallet = parseWallet(values.wallet);
    cadence = parseCadence(values.cadence!);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const network = choice("--network", values.network, ["pharos", "atlantic"] as const);
  const deliver = choice("--deliver", values.deliver, ["discord", "console", "none"] as const);
  const baselineMode = choice("--baseline", values.baseline, ["auto", "none"] as const);
  const whole = (flag: string, v: string, min: number) => {
    if (!/^\d+$/.test(v) || Number(v) < min) throw new UsageError(`${flag} must be a whole number >= ${min}`);
    return Number(v);
  };
  const scanBlocks = whole("--scan-blocks", values["scan-blocks"]!, 0);
  const maxTxs = whole("--max-txs", values["max-txs"]!, 1);
  if (values.proof !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(values.proof)) throw new UsageError("--proof takes a label of lower-case letters, digits and hyphens");
  const nowDate = values.now ? new Date(values.now) : clock();
  if (Number.isNaN(nowDate.getTime())) throw new UsageError(`--now must be an ISO time like 2026-10-26T01:00:00Z (got ${JSON.stringify(values.now)})`);
  const nowTs = Math.floor(nowDate.getTime() / 1000);

  const cron = CRON[cadence];
  if (values["print-schedule"]) {
    console.log(`cadence ${cadence}: ${cron ? `cron "${cron}" (UTC)` : `every ${cadence.slice(0, -1)} days (no fixed cron: run it daily; it only produces a digest when a period has finished)`}`);
    console.log(`run: npm run ${TASK} -- --wallet ${wallet} --cadence ${cadence} --state <file> --deliver discord`);
    console.log("a run only builds a digest once per finished period; the rest say \"already delivered\" and exit 0, so a daily trigger is safe.");
    return 0;
  }

  const period = periodAt(nowTs, cadence, 0);
  const prevPeriod = periodAt(nowTs, cadence, 1);
  const state = values.state ? readState<DigestState | null>(values.state, null, checkState) : null;
  const same = state && state.wallet === wallet && state.network === network && state.cadence === cadence;
  // Built and (if delivery was asked for) delivered already: nothing to do. A period that was only written, with no delivery, is built again when delivery is requested.
  if (same && state.periodEnd >= period.toTs && !values.force && (state.delivered || deliver === "none")) {
    console.log(`already delivered: the ${cadence} digest for ${state.periodLabel} (${state.delivered ? `message ${state.delivered.id ?? "console"} at ${state.delivered.at}` : "written, not delivered"}); the next period ends on ${new Date((period.toTs + (period.toTs - period.fromTs) - 86_400) * 1000).toISOString().slice(0, 10)}. Use --force to build it again.`);
    return 0;
  }

  const mcp = await connect(network);
  onExit(() => mcp.close());
  const call: Call = mcp.call;
  const head = BigInt((await call("get_block_number")).blockNumber);
  const meta = values.proof !== undefined ? proofMeta(TASK, mcp) : undefined; // before any file is written: the proof records a clean tree
  console.log(`${cadence} digest for ${wallet} on ${network} (chain ${mcp.chainId}) via ${mcp.endpoint}`);
  console.log(`clock ${nowDate.toISOString()} · period ${period.label} UTC · previous ${prevPeriod.label}`);
  const range = await rangeForTimes(call, period.fromTs, period.toTs, head);
  console.log(`blocks ${range.fromBlock}–${range.toBlock} (${range.toBlock - range.fromBlock + 1n} blocks, pinned at head ${head})`);
  const activity = await collectActivity(call, network, wallet, range, { scanBlocks, maxTxs, progress: (l) => console.error(l) });
  const metrics = metricsOf(activity, period.label);

  let previous: Metrics | undefined;
  if (same && state.periodLabel === prevPeriod.label) {
    previous = state.metrics;
    console.log(`previous period's numbers: from the state file (${state.periodLabel}), no re-read`);
  } else if (baselineMode === "auto") {
    const pr = await rangeForTimes(call, prevPeriod.fromTs, prevPeriod.toTs, head).catch(() => undefined);
    if (pr) {
      previous = metricsOf(await collectActivity(call, network, wallet, pr, { scanBlocks, maxTxs, progress: (l) => console.error(l) }), prevPeriod.label);
      console.log(`previous period read: blocks ${pr.fromBlock}–${pr.toBlock}`);
    } else console.log("previous period holds no blocks: no comparison");
  }

  const events = topEvents(activity, previous);
  const input = { activity, metrics, ...(previous ? { previous } : {}), period, cadence, generatedAt: `${nowDate.toISOString().replace(/\.\d+Z$/, "Z")}${values.now ? " (clock set with --now)" : ""}`, events };
  const md = digestMarkdown(input);
  let file: string | undefined;
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    file = join(values.out, `digest-${wallet.slice(0, 8).toLowerCase()}-${cadence}-${dayStart(period.fromTs)}.md`);
    writeFileSync(file, md);
    console.log(`wrote ${file}`);
  }
  console.log(`\n${values.compact ? digestCompact(input) : md}`);

  let delivered: { id?: string; at: string; channel: string } | undefined;
  if (deliver !== "none") {
    const notifier = (makeNotifier ?? ((k) => (k === "console" ? consoleNotifier() : discordNotifier(loadWebhook()))))(deliver);
    const d = await notifier.send(digestChat(input));
    delivered = { ...(d.id ? { id: d.id } : {}), at: d.timestamp, channel: notifier.name };
    console.log(`delivered to ${notifier.name}${d.id ? ` (message id ${d.id})` : ""}`);
  }
  if (values.state) writeState(values.state, { wallet, network, cadence, periodLabel: period.label, periodEnd: period.toTs, metrics, ...(delivered ? { delivered } : {}), ...(file ? { file } : {}) } satisfies DigestState);

  if (values.proof !== undefined) {
    const body = {
      wallet, cadence, clock: nowDate.toISOString(), period: { label: period.label, fromTs: period.fromTs, toTs: period.toTs, fromBlock: range.fromBlock.toString(), toBlock: range.toBlock.toString(), head: head.toString() },
      previousLabel: prevPeriod.label, metrics, previous: previous ?? null, topEvents: events, coverage: activity.coverage, delivery: delivered ?? null, digestMarkdown: md, discordText: digestChat(input),
    };
    console.log(`proof: ${writeProof(new URL(`proof/${values.proof}.json`, import.meta.url), body, meta!)}`);
  }
  return 0;
}

const dayStart = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

if (isMain(import.meta.url)) await runCli(main);
