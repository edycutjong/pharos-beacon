// Whale-Watching Agent (Medium · 100 pts): tracks a configurable set of addresses on Pharos mainnet and reports their significant
// token moves: what moved, how much (decimals applied), from → to (labelled where known) and why it matters, then a summary across
// every watched address. Read-only (Chain MCP); the only thing it can send is a Discord message.
//   npm run whale-watching-agent -- [--watchlist f] [--from-block N|head-N] [--to-block N|head] [--state f] [--notify discord|console]
//     [--discord-max 5] [--sent f] [--proof label]
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { readState, writeState } from "../../src/lib/state.js";
import { consoleNotifier, discordNotifier, loadWebhook, type Notifier } from "../../src/watch/discord.js";
import { compactSummary, compactText, discordText, explain, isSignificant, kindResolver, loadTokens, makeNamer, parseWatchlist, reportText, scanMoves, summarise, summaryTable, fmtAmount, type Move, type Report } from "../../src/whale/scan.js";

const TASK = "whale-watching-agent";
const HERE = fileURLToPath(new URL(".", import.meta.url));

type Conn = Pick<ChainMcp, "call" | "close" | "endpoint" | "network" | "chainId" | "server">;
type Sent = Record<string, { at: string; messageId?: string }>;
const checkSent = (v: unknown): Sent => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("whale sent-set has the wrong shape; refusing to guess (fix or remove it)");
  return v as Sent;
};

/** `N`, `head` or `head-N` against the head read at the start of the run. */
export function parseBlock(flag: string, v: string, head: bigint): bigint {
  const m = /^(?:(\d+)|head(?:-(\d+))?)$/.exec(v);
  if (!m) throw new UsageError(`${flag} must be a block number, "head" or "head-N" (got ${JSON.stringify(v)})`);
  const n = m[1] !== undefined ? BigInt(m[1]) : head - BigInt(m[2] ?? 0);
  if (n < 0n) throw new UsageError(`${flag} resolves below block 0`);
  return n;
}

export async function main(
  { onExit }: RunContext,
  argv = process.argv.slice(2),
  connect: (n: "atlantic" | "pharos") => Promise<Conn> = chainMcp,
  makeNotifier?: (kind: "discord" | "console") => Notifier,
): Promise<number> {
  const { values } = parseCli(
    {
      usage: `npm run ${TASK} -- [--watchlist f] [--from-block N|head-N] [--to-block N|head] [--state f] [--notify discord|console] [--discord-max 5] [--sent f] [--compact] [--proof label]`,
      options: {
        watchlist: { type: "string", default: join(HERE, "watchlist.json") },
        "from-block": { type: "string", default: "head-5000" }, "to-block": { type: "string", default: "head" },
        compact: { type: "boolean", default: false }, state: { type: "string" }, notify: { type: "string" }, "discord-max": { type: "string", default: "5" }, sent: { type: "string" }, proof: { type: "string" },
      },
    },
    argv,
  );
  const kind = values.notify === undefined ? undefined : choice("--notify", values.notify, ["discord", "console"] as const);
  if (values.proof !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(values.proof)) throw new UsageError("--proof takes a label of lower-case letters, digits and hyphens");
  if (!/^\d+$/.test(values["discord-max"]!) || Number(values["discord-max"]) < 1) throw new UsageError("--discord-max must be a whole number >= 1");
  let wl;
  try {
    wl = parseWatchlist(JSON.parse(readFileSync(values.watchlist!, "utf8")));
  } catch (e) {
    throw new UsageError(`${values.watchlist}: ${(e as Error).message.split("\n")[0]}`);
  }

  const mcp = await connect(wl.network);
  onExit(() => mcp.close());
  const head = BigInt(((await mcp.call("get_block_number")) as { blockNumber: string }).blockNumber);
  const saved = values.state ? readState<{ next?: string }>(values.state, {}, (v) => (v && typeof v === "object" ? (v as { next?: string }) : {})).next : undefined;
  const from = saved !== undefined ? BigInt(saved) : parseBlock("--from-block", values["from-block"]!, head);
  const to = parseBlock("--to-block", values["to-block"]!, head);
  if (to < from) {
    console.log(`nothing to scan: the next block (${from}) is past ${to}`);
    return 0;
  }

  const tokens = await loadTokens(mcp.call, wl.tokens);
  const kindOf = kindResolver(mcp.call);
  const namer = makeNamer(wl, wl.network, tokens, kindOf);
  console.log(`whale watch on ${wl.network} (chain ${mcp.chainId}) via ${mcp.endpoint}`);
  console.log(`blocks ${from}–${to} (${to - from + 1n} blocks, pinned) · ${wl.addresses.length} addresses · ${tokens.map((t) => `${t.symbol} ≥ ${t.threshold}`).join(", ")}${saved !== undefined ? ` · resumed from ${values.state}` : ""}`);
  if (!values.compact) {
    if (wl.source) console.log(`watchlist source: ${wl.source}`);
    for (const w of wl.addresses) console.log(`  watching ${w.address}  ${w.label} · ${await kindOf(w.address)}`);
  }

  const all: Move[] = [];
  for (const t of tokens) {
    const moves = await scanMoves(mcp.call, t, wl.addresses.map((a) => a.address), from, to);
    all.push(...moves);
    const big = moves.filter(isSignificant).length;
    console.log(values.compact ? `scanned ${t.symbol}: ${moves.length} transfers, ${big} significant` : `scanned ${t.symbol}: ${moves.length} transfers touch a watched address, ${big} at or above ${t.threshold}`);
  }
  const significant = all.filter(isSignificant);
  const largest = new Map<string, bigint>();
  for (const m of significant) if ((largest.get(m.token.address) ?? 0n) < m.amountRaw) largest.set(m.token.address, m.amountRaw);
  console.log(values.compact ? `\n${all.length} transfers · ${significant.length} significant\n` : `\n${all.length} transfers touch a watched address · ${significant.length} at or above their token's threshold\n`);

  const reports: Report[] = [];
  for (const m of significant) {
    const r = await explain(mcp.call, m, wl, namer, kindOf, { largest: largest.get(m.token.address)! });
    reports.push(r);
    console.log(values.compact ? compactText(r, reports.length) : `${reportText(r, (tx) => explorerTx(wl.network, tx), reports.length)}\n`); // printed as each is explained, not all at the end
  }
  if (reports.length === 0) console.log("no significant moves in this window\n");

  const rows = summarise(wl, tokens, all);
  console.log(values.compact ? "summary across all watched addresses" : "summary across all watched addresses (significant moves only in/out/largest)");
  console.log(values.compact ? compactSummary(rows) : summaryTable(rows));
  const totals = tokens.map((t) => {
    const mine = significant.filter((m) => m.token.address === t.address);
    return `${t.symbol}: ${mine.length} significant, ${fmtAmount(mine.reduce((s, m) => s + m.amountRaw, 0n), t.decimals, t.symbol)} moved`;
  });
  console.log(values.compact ? `\n${totals.map((t) => `totals ${t}`).join("\n")}` : `\ntotals: ${totals.join(" · ")}`);

  const delivered: { key: string; messageId?: string; at: string }[] = [];
  let skipped = 0;
  if (kind) {
    const notifier = (makeNotifier ?? ((k) => (k === "console" ? consoleNotifier() : discordNotifier(loadWebhook()))))(kind);
    const sentFile = values.sent ?? join(tmpdir(), "beacon-whale-watching-agent", "sent.json");
    const sent = readState<Sent>(sentFile, {}, checkSent);
    // Largest first by multiple of the token's own threshold: raw base units are not comparable across 6- and 18-decimal tokens.
    const top = [...reports].sort((a, b) => b.multiple - a.multiple || (a.move.amountRaw < b.move.amountRaw ? 1 : -1)).slice(0, Number(values["discord-max"]));
    for (const r of top) {
      const key = `${r.move.tx}:${r.move.logIndex}`;
      if (sent[key]) {
        skipped++;
        continue;
      }
      const d = await notifier.send(discordText(r, (tx) => explorerTx(wl.network, tx)));
      sent[key] = { at: d.timestamp, ...(d.id ? { messageId: d.id } : {}) };
      writeState(sentFile, sent);
      delivered.push({ key, ...(d.id ? { messageId: d.id } : {}), at: d.timestamp });
    }
    console.log(`notify ${notifier.name}: ${delivered.length} sent${delivered.some((d) => d.messageId) ? ` (message ids ${delivered.map((d) => d.messageId).join(", ")})` : ""}, ${skipped} already sent earlier`);
  }

  if (values.state) writeState(values.state, { next: (to + 1n).toString() });
  if (values.proof !== undefined) {
    const body = {
      watchlistSource: wl.source,
      range: { from: from.toString(), to: to.toString(), head: head.toString() },
      watched: wl.addresses,
      thresholds: tokens.map((t) => ({ token: t.address, symbol: t.symbol, threshold: t.threshold })),
      transfersTouchingWatched: all.length,
      significant: reports.map((r) => ({
        tx: r.move.tx, logIndex: r.move.logIndex, block: r.move.block.toString(), timestamp: r.timestamp, token: r.move.token.symbol, direction: r.direction,
        amountRaw: r.move.amountRaw.toString(), amount: fmtAmount(r.move.amountRaw, r.move.token.decimals, r.move.token.symbol),
        from: r.move.from, fromName: r.fromName, to: r.move.to, toName: r.toName, why: r.why,
        balanceBefore: r.beforeRaw.toString(), balanceAfter: r.afterRaw.toString(),
      })),
      summary: rows.map((r) => ({ label: r.label, address: r.address, token: r.token, transfers: r.transfers, significant: r.significant, inRaw: r.inRaw.toString(), outRaw: r.outRaw.toString(), largestRaw: r.largestRaw.toString() })),
      ...(kind ? { notify: { kind, delivered, alreadySent: skipped } } : {}),
    };
    console.log(`proof: ${writeProof(new URL(`proof/${values.proof}.json`, import.meta.url), body, proofMeta(TASK, mcp))}`);
  }
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
