// On-Chain Alert Bot (Easy · 50 pts): watch Pharos for conditions you configure and notify a real channel (Discord).
//   npm run on-chain-alert-bot -- --rules tasks/on-chain-alert-bot/rules.atlantic.json [--notify discord|console]
//     [--from-block head|N|head-N] [--poll-ms 3000] [--max-polls N] [--until-alerts N] [--state f] [--sent f] [--log f] [--verbose] [--proof label]
// Conditions (rules.ts): large-transfer ≥ N of a token, and any named event on a contract. One src/watch poller feeds
// both; every alert states what happened, the value and an explorer link; an alert is sent once per rule and event
// (the sent-set is persisted, so a restart never repeats it).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Hex } from "viem";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { readState, writeState } from "../../src/lib/state.js";
import { consoleNotifier, discordNotifier, loadWebhook, type Notifier } from "../../src/watch/discord.js";
import { tokenInfo } from "../../src/watch/token.js";
import { watch } from "../../src/watch/watch.js";
import { parseFrom } from "../event-log-monitor/index.js";
import { alertText, compileRules, match } from "./rules.js";

const TASK = "on-chain-alert-bot";

export interface SentEntry {
  at: string;
  tx: string;
  messageId?: string;
  notifier: string;
}
type Sent = Record<string, SentEntry>;
const checkSent = (v: unknown): Sent => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("alert sent-set has the wrong shape; refusing to guess (fix or remove it)");
  return v as Sent;
};

type Conn = Pick<ChainMcp, "call" | "close" | "endpoint" | "network" | "chainId" | "server">;

export async function main(
  { onExit, signal }: RunContext,
  argv = process.argv.slice(2),
  connect: (n: "atlantic" | "pharos") => Promise<Conn> = chainMcp,
  makeNotifier?: (kind: "discord" | "console", webhookFile?: string) => Notifier,
  sleep?: (ms: number, s?: AbortSignal) => Promise<void>,
): Promise<number> {
  const { values } = parseCli(
    {
      usage: `npm run ${TASK} -- --rules <rules.json> [--notify discord|console] [--from-block head|N|head-N] [--poll-ms 3000] [--max-polls N] [--until-alerts N] [--state f] [--sent f] [--log f] [--verbose] [--proof label]`,
      options: {
        rules: { type: "string" }, notify: { type: "string", default: "discord" }, "webhook-file": { type: "string" }, "from-block": { type: "string", default: "head" },
        "poll-ms": { type: "string", default: "3000" }, "max-polls": { type: "string" }, "until-alerts": { type: "string" },
        state: { type: "string" }, sent: { type: "string" }, log: { type: "string" }, verbose: { type: "boolean", default: false }, proof: { type: "string" },
      },
    },
    argv,
  );
  if (!values.rules) throw new UsageError("--rules <rules.json> is required (see tasks/on-chain-alert-bot/rules.atlantic.json)");
  const count = (flag: string, v: string | undefined, min: number) => {
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v) || Number(v) < min) throw new UsageError(`--${flag} must be a whole number >= ${min}`);
    return Number(v);
  };
  const pollMs = count("poll-ms", values["poll-ms"], 200)!;
  const maxPolls = count("max-polls", values["max-polls"], 1);
  const untilAlerts = count("until-alerts", values["until-alerts"], 1);
  const kind = choice("--notify", values.notify, ["discord", "console"] as const);
  if (values.proof !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(values.proof)) throw new UsageError("--proof takes a label of lower-case letters, digits and hyphens");

  let file: unknown;
  try {
    file = JSON.parse(readFileSync(values.rules, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot read the rules file ${values.rules}: ${(e as Error).message.split("\n")[0]}`);
  }
  const network = (file as { network?: "atlantic" | "pharos" })?.network === "pharos" ? "pharos" : "atlantic";
  const mcp = await connect(network);
  onExit(() => mcp.close());
  // The tokens named by large-transfer rules: their decimals turn "0.005" into base units and format every amount.
  const tokens = new Map<string, { decimals: number; symbol: string }>();
  for (const r of ((file as { rules?: { kind?: string; token?: string }[] })?.rules ?? [])) {
    if (r?.kind === "large-transfer" && typeof r.token === "string" && /^0x[0-9a-fA-F]{40}$/.test(r.token)) {
      const info = await tokenInfo(mcp.call, r.token as Hex);
      if (info) tokens.set(r.token.toLowerCase(), info);
    }
  }
  const compiled = compileRules(file, (t) => tokens.get(t.toLowerCase())?.decimals);
  const rules = compiled.rules;
  const infoOf = new Map<string, { decimals: number; symbol: string } | undefined>();
  for (const r of rules) if (!infoOf.has(r.address.toLowerCase())) infoOf.set(r.address.toLowerCase(), tokens.get(r.address.toLowerCase()) ?? (r.kind === "contract-event" ? await tokenInfo(mcp.call, r.address) : undefined));

  const notifier = (makeNotifier ?? ((k, wf) => (k === "console" ? consoleNotifier(() => {}) /* the ALERT block below is the console delivery */ : discordNotifier(loadWebhook(wf))))) (kind, values["webhook-file"]);
  const stem = basename(values.rules, ".json");
  const dir = join(tmpdir(), "beacon-on-chain-alert-bot"); // a try-out never writes into the repo (pass --state / --sent to keep them)
  const stateFile = values.state ?? join(dir, `${stem}.cursor.json`);
  const sentFile = values.sent ?? join(dir, `${stem}.sent.json`);
  const emit = (line: string) => {
    console.log(line);
    if (values.log) {
      mkdirSync(dirname(values.log), { recursive: true });
      appendFileSync(values.log, `${line}\n`);
    }
  };

  const head = BigInt((await mcp.call("get_block_number")).blockNumber);
  emit(`alert bot on ${network} (chain ${mcp.chainId}) via ${mcp.endpoint} · head ${head} · notify ${notifier.name} · ${rules.length} rule${rules.length === 1 ? "" : "s"}`);
  for (const r of rules) emit(`  rule ${r.id}: ${r.kind} on ${r.address}${r.minText ? ` (>= ${r.minText} ${tokens.get(r.address.toLowerCase())?.symbol ?? ""})` : ` (${r.spec.signature})`}`);

  const sent = readState<Sent>(sentFile, {}, checkSent);
  const delivered: { rule: string; key: string; tx: string; messageId?: string; text: string; at: string }[] = [];
  let skipped = 0;
  const stop = new AbortController();
  const r = await watch({
    call: mcp.call,
    address: [...new Set(rules.map((x) => x.address))],
    topics: [[...new Set(rules.map((x) => x.spec.topic0))]],
    stateFile, from: parseFrom(values["from-block"]!, head), pollMs, maxPolls, signal: AbortSignal.any([signal, stop.signal]), sleep,
    onLog: async (log) => {
      for (const a of match(rules, log)) {
        if (sent[a.key]) {
          skipped++;
          continue; // already alerted for this rule and event: no repeat
        }
        const info = infoOf.get(a.rule.address.toLowerCase());
        const text = alertText(a, network, info?.decimals, info?.symbol);
        const d = await notifier.send(text); // a throw leaves the log unhandled: the next poll tries again
        sent[a.key] = { at: d.timestamp, tx: a.event.tx, ...(d.id ? { messageId: d.id } : {}), notifier: notifier.name };
        writeState(sentFile, sent);
        delivered.push({ rule: a.rule.id, key: a.key, tx: a.event.tx, ...(d.id ? { messageId: d.id } : {}), text, at: d.timestamp });
        emit(`ALERT ${a.rule.id} → ${notifier.name}${d.id ? ` message ${d.id}` : ""}\n${text.split("\n").map((l) => `  | ${l}`).join("\n")}`);
        if (untilAlerts !== undefined && delivered.length >= untilAlerts) stop.abort();
      }
    },
    onPoll: (p) => values.verbose && emit(`poll ${p.polls}: head ${p.head}, scanned to ${p.scannedTo}, ${p.fresh} matching-filter log${p.fresh === 1 ? "" : "s"}`),
  });
  emit(`stopped after ${r.polls} polls: ${delivered.length} alert${delivered.length === 1 ? "" : "s"} sent, ${skipped} already sent earlier (not repeated); next block to scan ${r.next}`);
  if (values.proof !== undefined) {
    console.log(`proof: ${writeProof(new URL(`proof/${values.proof}.json`, import.meta.url), { network, rules: rules.map((x) => ({ id: x.id, kind: x.kind, address: x.address, event: x.spec.signature, min: x.minText })), notifier: notifier.name, startHead: head.toString(), polls: r.polls, alertsSent: delivered.length, alreadySent: skipped, nextBlock: r.next.toString(), delivered }, proofMeta(TASK, mcp))}`);
  }
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
