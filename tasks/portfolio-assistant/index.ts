// Portfolio Assistant (Hard · 200 pts): answers natural-language questions about a wallet's balances, positions and yields on Pharos
// mainnet. Every number carries the contract, the call and the block it was read from; what it cannot read it says so.
//   npm run portfolio-assistant -- ask "what am I earning?" "where is my USDC?" --wallet 0x… [--wallet 0x…] [--block N] [--window-days 7] [--proof name]
//   npm run portfolio-assistant -- report --wallet 0x…        (every position, no question)
// Read-only by construction: no write path exists in this task, and a test greps the sources to keep it that way.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Hex } from "viem";
import { secondsPerBlock } from "../../src/arb/backtest.js";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { answerQuestion, sourceTable, type Answer, type Reads } from "../../src/portfolio/ask.js";
import { FactBook, agreeing, headerAt, readSnapshot, vaultYield, type Snapshot } from "../../src/portfolio/read.js";

const TASK = "portfolio-assistant";
const HERE = fileURLToPath(new URL(".", import.meta.url));

export const REPORT_QUESTION = "what do I hold?";

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- ask "<question>"… | report  --wallet 0x… [--wallet 0x…] [--block N] [--window-days 7] [--proof name]`,
      options: { wallet: { type: "string", multiple: true }, block: { type: "string" }, "window-days": { type: "string", default: "7" }, proof: { type: "string" } },
      positionals: [1, 40],
    },
    argv,
  );
  const cmd = choice("command", positionals[0], ["ask", "report"] as const);
  const questions = cmd === "report" ? [REPORT_QUESTION] : positionals.slice(1);
  if (cmd === "ask" && questions.length === 0) throw new UsageError('ask needs at least one question, e.g. ask "what am I earning?"');
  if (cmd === "report" && positionals.length > 1) throw new UsageError("report takes no question");
  const wallets = (values.wallet ?? []).map((w) => {
    if (!isAddress(w)) throw new UsageError(`--wallet must be an address, got ${JSON.stringify(w)}`);
    return getAddress(w);
  });
  if (!wallets.length) throw new UsageError("--wallet is required (an address on Pharos mainnet; repeat it for several wallets)");
  const windowDays = Number(values["window-days"]);
  if (!Number.isFinite(windowDays) || windowDays <= 0 || windowDays > 60) throw new UsageError("--window-days must be a number between 0 and 60");
  if (values.block !== undefined && !/^\d{1,12}$/.test(values.block)) throw new UsageError("--block must be a block number");
  const pinned = values.block === undefined ? undefined : BigInt(values.block);

  const mcp = await chainMcp("pharos");
  onExit(() => mcp.close());
  let readCalls = 0;
  const call = ((...a: Parameters<typeof mcp.call>) => (readCalls++, (mcp.call as (...x: unknown[]) => unknown)(...a))) as typeof mcp.call;
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined;
  const started = Date.now();
  const lines: string[] = [];
  const log = (s: string) => (lines.push(s), console.log(s));

  const head = await headerAt(call, pinned);
  const spb = await secondsPerBlock(call, head.block);
  const book = new FactBook();
  const snapshots: Snapshot[] = [];
  for (const w of wallets) snapshots.push(await readSnapshot(call, w as Hex, book, head.block));
  const blockForDays = (days: number) => head.block - BigInt(Math.round((days * 86_400) / spb));

  const reads: Reads = {
    snapshots,
    book,
    async earlier(sinceBlock, sinceDays) {
      const at = sinceBlock ?? blockForDays(sinceDays ?? windowDays);
      if (at >= head.block) throw new UsageError(`the earlier block ${at} must be before the block read (${head.block})`);
      const out: Snapshot[] = [];
      for (const w of wallets) out.push(await readSnapshot(call, w as Hex, book, at)); // every read twice, see agreeing()
      return out;
    },
    async yieldOf(pos, snap, days) {
      const from = blockForDays(days);
      const h = await headerAt(call, from);
      return vaultYield(agreeing(call), pos, from, h.timestamp, snap, book);
    },
  };

  log(`Pharos mainnet (chain 1672), block ${head.block} (${spb.toFixed(3)} s/block) · wallets: ${wallets.join(", ")}`);
  const answers: (Answer & { sources: string })[] = [];
  for (const q of questions) {
    const a = await answerQuestion(q, reads, windowDays);
    const sources = a.cites.length ? sourceTable(book, a.cites) : "";
    answers.push({ ...a, sources });
    log(`\nQ: ${q}`);
    log(a.text.split("\n").map((l) => `A: ${l}`).join("\n"));
    if (sources) log(`sources:\n${sources.split("\n").map((l) => `  ${l}`).join("\n")}`);
  }

  if (values.proof) {
    const file = join(HERE, "proof", `${values.proof}.json`);
    const body = {
      block: head.block.toString(),
      wallets,
      windowDays,
      answers: answers.map((a) => ({ question: a.question, lang: a.lang, intent: a.intent.type, refused: a.refused ?? null, text: a.text, cites: a.cites, sources: a.sources })),
      facts: [...book.facts.values()].filter((f) => answers.some((a) => a.cites.includes(f.id))).map((f) => ({ id: f.id, label: f.label, raw: f.raw.toString(), decimals: f.decimals, symbol: f.symbol, contract: f.source.contract, call: f.source.call, block: f.source.block.toString() })),
      unreadable: snapshots.flatMap((s) => s.unreadable.map((u) => ({ wallet: s.wallet, ...u }))),
      readCalls,
      seconds: Math.round((Date.now() - started) / 1000),
    };
    // the same run as readable text (the JSON holds the answers as escaped strings)
    writeFileSync(join(HERE, "proof", `${values.proof}.txt`), lines.join("\n") + "\n");
    log(`\nproof: ${writeProof(file, body, meta!)} (+ ${values.proof}.txt)`);
  }
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
