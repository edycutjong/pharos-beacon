// Audit-Log Agent (Medium · 100 pts): a plain-language activity report for a wallet over a date range, grouped into transfers in and
// out, swaps, approvals and contract interactions, with totals, notable transactions (linked) and a Markdown or CSV export.
// Read-only (Chain MCP); it never sends anything.
//   npm run audit-log-agent -- --wallet 0x… --from 2026-10-20 --to 2026-10-22 [--network pharos|atlantic] [--format md|csv|both]
//     [--out dir] [--scan-blocks N] [--max-txs N] [--baseline auto|none] [--proof label]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectActivity, dayUtc, parseWallet, rangeForTimes, type Activity, type Call, type Range } from "../../src/activity/engine.js";
import { compactReport, csvReport, markdownReport } from "../../src/activity/report.js";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp, type ChainMcp, type Network } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";

const TASK = "audit-log-agent";
type Conn = Pick<ChainMcp, "call" | "close" | "endpoint" | "network" | "chainId" | "server">;

/** `YYYY-MM-DD` as a UTC midnight in unix seconds. */
export function dateToTs(flag: string, v: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UsageError(`${flag} must be a date like 2026-10-22 (UTC)`);
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v) throw new UsageError(`${flag}: ${v} is not a real date`);
  return ms / 1000;
}

export async function main(
  { onExit }: RunContext,
  argv = process.argv.slice(2),
  connect: (n: Network) => Promise<Conn> = chainMcp,
  now: () => Date = () => new Date(),
): Promise<number> {
  const { values } = parseCli(
    {
      usage: `npm run ${TASK} -- --wallet 0x… (--from YYYY-MM-DD --to YYYY-MM-DD | --from-block N --to-block N) [--network pharos|atlantic] [--format md|csv|both] [--out dir] [--scan-blocks N] [--max-txs N] [--baseline auto|none] [--compact] [--proof label]`,
      options: {
        wallet: { type: "string" }, from: { type: "string" }, to: { type: "string" }, "from-block": { type: "string" }, "to-block": { type: "string" },
        network: { type: "string", default: "pharos" }, format: { type: "string", default: "md" }, out: { type: "string" },
        "scan-blocks": { type: "string", default: "0" }, "max-txs": { type: "string", default: "400" }, compact: { type: "boolean", default: false }, baseline: { type: "string", default: "auto" }, proof: { type: "string" },
      },
    },
    argv,
  );
  if (!values.wallet) throw new UsageError("--wallet is required");
  let wallet;
  try {
    wallet = parseWallet(values.wallet);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const network = choice("--network", values.network, ["pharos", "atlantic"] as const);
  const format = choice("--format", values.format, ["md", "csv", "both"] as const);
  const baselineMode = choice("--baseline", values.baseline, ["auto", "none"] as const);
  const whole = (flag: string, v: string, min: number) => {
    if (!/^\d+$/.test(v) || Number(v) < min) throw new UsageError(`${flag} must be a whole number >= ${min}`);
    return Number(v);
  };
  const scanBlocks = whole("--scan-blocks", values["scan-blocks"]!, 0);
  const maxTxs = whole("--max-txs", values["max-txs"]!, 1);
  if (values.proof !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(values.proof)) throw new UsageError("--proof takes a label of lower-case letters, digits and hyphens");
  const byDate = values.from !== undefined || values.to !== undefined;
  const byBlock = values["from-block"] !== undefined || values["to-block"] !== undefined;
  if (byDate === byBlock) throw new UsageError("give a period as --from and --to dates, or as --from-block and --to-block (not both, not neither)");

  const mcp = await connect(network);
  onExit(() => mcp.close());
  const call: Call = mcp.call;
  const head = BigInt((await call("get_block_number")).blockNumber);
  // Taken now, before any report file is written: the proof records whether the tree was clean when the run started.
  const meta = values.proof !== undefined ? proofMeta(TASK, mcp) : undefined;
  let range: Range;
  let prior: Range | undefined;
  if (byDate) {
    if (values.from === undefined || values.to === undefined) throw new UsageError("--from and --to go together");
    const fromTs = dateToTs("--from", values.from);
    const toTs = dateToTs("--to", values.to) + 86_400; // --to is inclusive: the period ends at the start of the next day
    if (toTs <= fromTs) throw new UsageError("--to must not be before --from");
    range = await rangeForTimes(call, fromTs, toTs, head);
    if (baselineMode === "auto") prior = await rangeForTimes(call, fromTs - (toTs - fromTs), fromTs, head).catch(() => undefined);
  } else {
    if (values["from-block"] === undefined || values["to-block"] === undefined) throw new UsageError("--from-block and --to-block go together");
    const fromBlock = BigInt(whole("--from-block", values["from-block"], 0));
    const toBlock = BigInt(whole("--to-block", values["to-block"], 0));
    if (toBlock < fromBlock) throw new UsageError("--to-block must not be before --from-block");
    range = { fromBlock, toBlock: toBlock > head ? head : toBlock };
    const len = range.toBlock - range.fromBlock + 1n;
    if (baselineMode === "auto" && fromBlock >= len) prior = { fromBlock: fromBlock - len, toBlock: fromBlock - 1n };
  }

  console.log(`audit log for ${wallet} on ${network} (chain ${mcp.chainId}) via ${mcp.endpoint}`);
  console.log(`period ${byDate ? `${values.from} to ${values.to} UTC · ` : ""}blocks ${range.fromBlock}–${range.toBlock} (${range.toBlock - range.fromBlock + 1n} blocks, pinned at head ${head})`);
  const opts = { scanBlocks, maxTxs, progress: (l: string) => console.error(l) };
  const activity = await collectActivity(call, network, wallet, range, opts);
  console.error(`read ${activity.items.length} items`);
  const baseline: Activity | undefined = prior ? await collectActivity(call, network, wallet, prior, { maxTxs }) : undefined;

  const generatedAt = now().toISOString().replace(/\.\d+Z$/, "Z");
  const md = markdownReport(activity, { generatedAt, ...(baseline ? { baseline } : {}) });
  const csv = csvReport(activity);
  const stem = `audit-${wallet.slice(0, 8).toLowerCase()}-${byDate ? `${values.from}_${values.to}` : `${range.fromBlock}-${range.toBlock}`}`;
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    if (format !== "csv") console.log(`wrote ${join(values.out, `${stem}.md`)}`), writeFileSync(join(values.out, `${stem}.md`), md);
    if (format !== "md") console.log(`wrote ${join(values.out, `${stem}.csv`)}`), writeFileSync(join(values.out, `${stem}.csv`), csv);
  }
  if (values.compact) console.log(`\n${compactReport(activity, baseline ? { baseline } : {})}`);
  else if (!values.out || format === "md") console.log(`\n${md}`);
  else if (format === "csv") console.log(`\n${csv}`);

  if (values.proof !== undefined) {
    const t = activity.items;
    const body = {
      wallet, range: { fromBlock: range.fromBlock.toString(), toBlock: range.toBlock.toString(), head: head.toString(), ...(range.fromTs !== undefined ? { from: dayUtc(range.fromTs), toExclusive: dayUtc(range.toTs!) } : {}) },
      baselineRange: prior ? { fromBlock: prior.fromBlock.toString(), toBlock: prior.toBlock.toString() } : null,
      coverage: activity.coverage, items: t.length, txs: new Set(t.map((i) => i.tx)).size,
      byCategory: Object.fromEntries(["transfer-in", "transfer-out", "swap", "approval", "contract-call"].map((c) => [c, t.filter((i) => i.category === c).length])),
      transactions: t.map((i) => ({ tx: i.tx, block: i.block.toString(), category: i.category, status: i.status, counterparty: i.counterparty, method: i.method ?? null })),
      reportMarkdown: md,
    };
    console.log(`proof: ${writeProof(new URL(`proof/${values.proof}.json`, import.meta.url), body, meta!)}`);
  }
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
