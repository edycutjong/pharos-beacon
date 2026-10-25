// Live demo endpoint for the Portfolio Assistant (api/router.ts → this file). Read-only, mainnet only: it runs the CLI's own reads and
// answerQuestion for ONE wallet and ONE question. No write path exists in this task; the page has no key.
//   GET ?action=info
//   GET ?action=run&wallet=0x…&q=<question, English or Bahasa Indonesia>[&block=N][&windowDays=7]   NDJSON (steps, then one "done" line with a View)
import { getAddress, isAddress, type Hex } from "viem";
import { secondsPerBlock } from "../../src/arb/backtest.js";
import { answerQuestion, sourceTable, type Reads } from "../../src/portfolio/ask.js";
import { FactBook, agreeing, headerAt, readSnapshot, vaultYield, type Snapshot } from "../../src/portfolio/read.js";
import { InputError, trackPhases, stepper, type Emit } from "../../src/web/live.js";
import { numParam, serve, type Deps } from "../../src/web/mainnet-live.js";
import type { View } from "../../src/web/view.js";

export interface RunParams { wallet: Hex; q: string; block?: bigint; windowDays: number }

export function parseRun(url: URL): RunParams {
  const q = url.searchParams;
  const wallet = (q.get("wallet") ?? "").trim();
  if (!isAddress(wallet, { strict: false })) throw new InputError("wallet must be a 0x address (40 hex digits)");
  const question = (q.get("q") ?? "").trim();
  if (!question) throw new InputError("q is the question to ask, e.g. what am I earning?");
  if (question.length > 200) throw new InputError("q must be 200 characters or fewer");
  const block = (q.get("block") ?? "").trim();
  if (block && !/^\d{1,10}$/.test(block)) throw new InputError("block must be a block number (digits only)");
  return { wallet: getAddress(wallet), q: question, ...(block ? { block: BigInt(block) } : {}), windowDays: numParam(q, "windowDays", 7, 1, 30) };
}

const phaseOf = (tool: string) => (tool === "get_block_number" || tool === "get_block" ? "header" : tool === "get_logs" ? "history" : "reads");
const labelOf = (phase: string, n: number) => `${n} call${n === 1 ? "" : "s"}`;

export async function run(p: RunParams, emit: Emit, deps: Deps): Promise<void> {
  const t0 = Date.now();
  const conn = await deps.connect();
  emit({ type: "start", network: "pharos", endpoint: conn.endpoint });
  const t = trackPhases(conn.call, emit, (tool) => phaseOf(tool), labelOf);
  try {
    const call = t.call;
    const head = await headerAt(call, p.block);
    const spb = await secondsPerBlock(call, head.block);
    const book = new FactBook();
    const snap = await readSnapshot(call, p.wallet, book, head.block);
    const blockForDays = (days: number) => head.block - BigInt(Math.round((days * 86_400) / spb));
    const reads: Reads = {
      snapshots: [snap],
      book,
      async earlier(sinceBlock, sinceDays) {
        const at = sinceBlock ?? blockForDays(sinceDays ?? p.windowDays);
        if (at >= head.block) throw new InputError(`the earlier block ${at} must be before the block read (${head.block})`);
        return [await readSnapshot(call, p.wallet, book, at)];
      },
      async yieldOf(pos, s: Snapshot, days) {
        const from = blockForDays(days);
        const h = await headerAt(call, from);
        return vaultYield(agreeing(call), pos, from, h.timestamp, s, book);
      },
    };
    const a = await answerQuestion(p.q, reads, p.windowDays);
    t.finish();
    const s = stepper(emit);
    s.begin("answer");
    s.end("answer", a.refused ? "refused" : "ok", a.refused ? "declined" : `${a.cites.length} cited fact${a.cites.length === 1 ? "" : "s"}`);
    const sources = a.cites.length ? sourceTable(book, a.cites) : "";
    const view: View = {
      tone: a.refused ? "warn" : "ok",
      verdict: a.refused ? "It would not guess" : `Answered (${a.lang === "id" ? "Bahasa Indonesia" : "English"}), ${a.cites.length} cited fact${a.cites.length === 1 ? "" : "s"}`,
      note: `Block ${head.block} on Pharos mainnet. Every number carries its [F…] id; the table below the answer gives the contract, the call and the block of each. What cannot be read is named, not guessed. Rules classify the question: no LLM.`,
      tables: [],
      text: [`Q: ${p.q}`, ...a.text.split("\n").map((l) => `A: ${l}`), ...(sources ? ["", "sources:", ...sources.split("\n").map((l) => `  ${l}`)] : []), ...(snap.unreadable.length ? ["", "not readable:", ...snap.unreadable.map((u) => `  ${u.protocol}: ${u.what} (${u.reason})`)] : [])].join("\n"),
      evidence: [
        ["Wallet", { t: p.wallet, href: `https://www.pharosscan.xyz/address/${p.wallet}` }],
        ["Block", `${head.block}${p.block !== undefined ? " (pinned)" : " (the head, read first)"}`],
        ["Chain MCP reads", `${t.total()} calls`],
        ["Intent", a.intent.type],
      ],
      summary: a.refused ? `Declined: ${a.refused}` : `${a.cites.length} cited facts at block ${head.block}.`,
    };
    emit({ type: "done", totalMs: Date.now() - t0, reads: t.total(), view });
  } catch (e) {
    t.finish(e as Error);
    throw e;
  } finally {
    await conn.close().catch(() => {});
  }
}

export const handle = serve("portfolio-assistant", parseRun, run, { intents: "holdings, where, earning, biggest, owe, total, changed, protocol", languages: ["en", "id"] });
