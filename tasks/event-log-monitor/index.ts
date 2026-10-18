// Event/Log Monitor (Easy · 50 pts): watch a Pharos contract for one event and report each new occurrence as it happens.
//   npm run event-log-monitor -- --contract 0x… --event Transfer [--network atlantic|pharos] [--from-block head|N|head-N]
//     [--poll-ms 3000] [--max-polls N] [--until-events N] [--state file] [--log file] [--verbose] [--proof label]
// It polls the Chain MCP's get_logs (filtered by contract address AND the event's topic0), keeps a block cursor and a
// handled-set in a state file (src/watch), and prints each new event once: from, to, amount, tx hash, block.
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAddress, isAddress, type Hex } from "viem";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp, NETWORKS, type ChainMcp, type Network } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { amountText, decodeLog, parseEvent, type DecodedEvent } from "../../src/watch/decode.js";
import { tokenInfo } from "../../src/watch/token.js";
import { savedCursor, watch } from "../../src/watch/watch.js";

const TASK = "event-log-monitor";

/** `head`, `N`, or `head-N` (N blocks before the head, for a keyless backfill demo). */
export function parseFrom(v: string, head: bigint): bigint | "head" {
  if (v === "head") return "head";
  if (/^\d+$/.test(v)) return BigInt(v);
  const back = /^head-(\d+)$/.exec(v);
  if (back) return head >= BigInt(back[1]!) ? head - BigInt(back[1]!) : 0n;
  throw new UsageError(`--from-block must be head, a block number or head-N (got ${JSON.stringify(v)})`);
}

/** One event as a readable line block. */
export function formatEvent(e: DecodedEvent, network: Network, decimals?: number, symbol?: string): string {
  const rest = Object.entries(e.fields).filter(([k]) => !["from", "to", "src", "dst", "value", "wad", "amount"].includes(k));
  return [
    `${e.event}  block ${e.block}  log #${e.logIndex}`,
    `  from    ${e.from ?? "n/a"}`,
    `  to      ${e.to ?? "n/a"}`,
    `  amount  ${amountText(e, decimals, symbol)}`,
    ...rest.map(([k, v]) => `  ${k.padEnd(7)} ${v}`),
    `  tx      ${e.tx}`,
    `          ${explorerTx(network, e.tx)}`,
  ].join("\n");
}

type Conn = Pick<ChainMcp, "call" | "close" | "endpoint" | "network" | "chainId" | "server">;

export async function main({ onExit, signal }: RunContext, argv = process.argv.slice(2), connect: (n: Network) => Promise<Conn> = chainMcp, sleep?: (ms: number, s?: AbortSignal) => Promise<void>): Promise<number> {
  const { values } = parseCli(
    {
      usage: `npm run ${TASK} -- --contract 0x… --event Transfer [--network atlantic|pharos] [--from-block head|N|head-N] [--poll-ms 3000] [--max-polls N] [--until-events N] [--state file] [--log file] [--verbose] [--proof label]`,
      options: {
        contract: { type: "string" }, event: { type: "string", default: "Transfer" }, network: { type: "string", default: "atlantic" },
        "from-block": { type: "string", default: "head" }, "poll-ms": { type: "string", default: "3000" }, "max-polls": { type: "string" }, "until-events": { type: "string" },
        state: { type: "string" }, log: { type: "string" }, verbose: { type: "boolean", default: false }, proof: { type: "string" },
      },
    },
    argv,
  );
  if (!values.contract || !isAddress(values.contract)) throw new UsageError("--contract must be a contract address");
  const contract = getAddress(values.contract);
  const network = choice("--network", values.network, NETWORKS);
  const count = (flag: string, v: string | undefined, min: number) => {
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v) || Number(v) < min) throw new UsageError(`--${flag} must be a whole number >= ${min}`);
    return Number(v);
  };
  const pollMs = count("poll-ms", values["poll-ms"], 200)!;
  const maxPolls = count("max-polls", values["max-polls"], 1);
  const untilEvents = count("until-events", values["until-events"], 1);
  if (values.proof !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(values.proof)) throw new UsageError("--proof takes a label of lower-case letters, digits and hyphens");
  const spec = parseEvent(values.event!);
  // The default state lives in the temp dir, so a try-out never writes into the repo (pass --state to keep it elsewhere).
  const stateFile = values.state ?? join(tmpdir(), "beacon-event-log-monitor", `${network}-${contract.toLowerCase()}-${spec.item.name}.json`);
  const emit = (line: string) => {
    console.log(line);
    if (values.log) {
      mkdirSync(dirname(values.log), { recursive: true });
      appendFileSync(values.log, `${line}\n`);
    }
  };

  const mcp = await connect(network);
  onExit(() => mcp.close());
  const head = BigInt((await mcp.call("get_block_number")).blockNumber);
  const info = await tokenInfo(mcp.call, contract);
  emit(`watching ${spec.signature} on ${contract}${info ? ` (${info.symbol}, ${info.decimals} decimals)` : ""}`);
  emit(`${network} (chain ${mcp.chainId}) via ${mcp.endpoint} · head ${head} · poll ${pollMs} ms · state ${stateFile}`);

  const resume = savedCursor(stateFile);
  if (resume !== undefined) emit(`resuming from the saved cursor: next block ${resume} (--from-block is only used when there is no state file)`);
  const caught: { block: string; logIndex: number; tx: Hex; event: string; from?: Hex; to?: Hex; amountRaw?: string; amount: string }[] = [];
  const r = await watch({
    call: mcp.call, address: contract, topics: [spec.topic0], stateFile, from: parseFrom(values["from-block"]!, head), pollMs, maxPolls, untilEvents, signal, sleep,
    onLog: (log) => {
      const e = decodeLog(spec, log);
      emit(formatEvent(e, network, info?.decimals, info?.symbol));
      caught.push({ block: e.block.toString(), logIndex: e.logIndex, tx: e.tx, event: e.event, from: e.from, to: e.to, amountRaw: e.amountRaw?.toString(), amount: amountText(e, info?.decimals, info?.symbol) });
    },
    onPoll: (p) => values.verbose && emit(`poll ${p.polls}: head ${p.head}, scanned to ${p.scannedTo}, ${p.fresh} new`),
  });
  emit(`stopped after ${r.polls} polls: ${r.handled} new ${spec.item.name} event${r.handled === 1 ? "" : "s"}; next block to scan ${r.next}`);
  if (values.proof !== undefined) {
    console.log(`proof: ${writeProof(new URL(`proof/${values.proof}.json`, import.meta.url), { contract, event: spec.signature, topic0: spec.topic0, startHead: head.toString(), polls: r.polls, newEvents: r.handled, nextBlock: r.next.toString(), caught }, proofMeta(TASK, mcp))}`);
  }
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
