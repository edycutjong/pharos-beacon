// Live demo endpoint for the Yield Optimizer (api/router.ts → this file). Read-only, Pharos mainnet only: it runs the CLI's own analyse()
// for ONE wallet and renders the same report. A MOVE is only ever an UNSIGNED plan for the owner's wallet: this file imports no signer.
// (The Atlantic test-vault move needs a key and the stdio Chain MCP, so it stays in the CLI; its recorded proofs are in the README.)
//   GET ?action=info
//   GET ?action=run&wallet=0x…[&holdDays=30][&haircut=0.5][&minNetUsd=1][&slippageBps=10][&block=N]   NDJSON (steps, then one "done" line with a View)
import { getAddress, isAddress, type Hex } from "viem";
import { pharos } from "../../src/lib/networks.js";
import { PROS_POOL, headerAt, readProsPrice } from "../../src/portfolio/read.js";
import { DEFAULT_RATE_OPTIONS, parseWindows } from "../../src/yield/model.js";
import { renderReport } from "../../src/yield/format.js";
import { NoPosition, analyse } from "../../src/yield/run.js";
import { MAINNET_VAULT_SOURCES, USDC_MAINNET, morphoUsdcSources } from "../../src/yield/sources.js";
import { InputError, stepper, trackPhases, type Emit } from "../../src/web/live.js";
import { numParam, serve, type Deps } from "../../src/web/mainnet-live.js";
import type { View } from "../../src/web/view.js";

export interface RunParams { wallet: Hex; holdDays: number; haircut: number; minNetUsd: number; slippageBps: number; block?: bigint }

export function parseRun(url: URL): RunParams {
  const q = url.searchParams;
  const wallet = (q.get("wallet") ?? "").trim();
  if (!isAddress(wallet, { strict: false })) throw new InputError("wallet must be a 0x address (40 hex digits)");
  const block = (q.get("block") ?? "").trim();
  if (block && !/^\d{1,10}$/.test(block)) throw new InputError("block must be a block number (digits only)");
  return {
    wallet: getAddress(wallet), holdDays: numParam(q, "holdDays", 30, 0.5, 365), haircut: numParam(q, "haircut", 0.5, 0, 1), minNetUsd: numParam(q, "minNetUsd", 1, 0, 1e6),
    slippageBps: numParam(q, "slippageBps", 10, 0, 500), ...(block ? { block: BigInt(block) } : {}),
  };
}

/** The header read comes first, then every source read is one "sources" phase (a lamp per phase change, not per call). */
const phaseOf = (tool: string, _a: unknown, cur: string | undefined) => (cur === undefined ? "header" : cur === "header" && tool !== "get_block_number" && tool !== "get_block" ? "sources" : cur);

export async function run(p: RunParams, emit: Emit, deps: Deps): Promise<void> {
  const t0 = Date.now();
  const conn = await deps.connect();
  emit({ type: "start", network: "pharos", endpoint: conn.endpoint });
  const t = trackPhases(conn.call, emit, phaseOf, (_ph, n) => `${n} call${n === 1 ? "" : "s"}`);
  try {
    const call = t.call;
    const h = await headerAt(call, p.block);
    const price = await readProsPrice(call, h.block);
    const nativeUsd = { value: price.price, basis: `PROS in USDC from the WPROS/USDC pool ${PROS_POOL} slot0 at block ${h.block}` };
    const m = await morphoUsdcSources(call, USDC_MAINNET, h.block, h.timestamp);
    let report;
    try {
      report = await analyse({
        call, chainId: pharos.id, network: "pharos", wallet: p.wallet, sources: [...MAINNET_VAULT_SOURCES, ...m.sources], usdc: USDC_MAINNET, assetDecimals: 6,
        windows: parseWindows("1d,7d,30d"), holdDays: p.holdDays, minNetUsd: p.minNetUsd, slippageBps: p.slippageBps, nativeUsd, block: p.block, skipped: m.skipped, rate: { ...DEFAULT_RATE_OPTIONS, haircut: p.haircut },
      });
    } catch (e) {
      if (e instanceof NoPosition) throw new InputError(`nothing to optimise: ${e.message}`);
      throw e;
    }
    t.finish();
    const s = stepper(emit);
    s.begin("recommend");
    const rec = report.recommendation;
    s.end("recommend", rec.decision === "MOVE" ? "ok" : "skip", rec.decision === "MOVE" ? "MOVE" : "STAY PUT");
    const view: View = {
      tone: rec.decision === "MOVE" ? "ok" : "warn",
      verdict: rec.decision === "MOVE" ? "MOVE" : "STAY PUT",
      note: `${rec.reason} Block ${report.block} on Pharos mainnet. Yield is measured as share-price growth, not a quoted APY. ${report.plan ? "The plan is unsigned: sign it with your own wallet." : "No transaction is prepared."}`,
      tables: [{
        head: ["Destination", "Net over the holding period", "At median rates", "Verdict"],
        rows: rec.evaluations.map((e) => [e.name, e.netUsd === null ? "cannot be valued" : `$${e.netUsd.toFixed(2)}`, e.netAtMedianUsd === null ? "—" : `$${e.netAtMedianUsd.toFixed(2)}`, e.verdict]),
      }],
      text: renderReport(report).join("\n"),
      evidence: [
        ["Wallet", { t: p.wallet, href: `https://www.pharosscan.xyz/address/${p.wallet}` }],
        ["Holds", report.held.source.name],
        ["Block", `${report.block}${p.block !== undefined ? " (pinned)" : " (the head, read first)"}`],
        ["Chain MCP reads", `${t.total()} calls`],
        ["Signed", "nothing: this page has no key"],
      ],
      summary: `${rec.decision === "MOVE" ? "MOVE" : "STAY PUT"}: ${rec.reason.slice(0, 160)}`,
    };
    emit({ type: "done", totalMs: Date.now() - t0, reads: t.total(), view });
  } catch (e) {
    t.finish(e as Error);
    throw e;
  } finally {
    await conn.close().catch(() => {});
  }
}

export const handle = serve("yield-optimizer", parseRun, run, { network: "Pharos mainnet (the Atlantic move runs from the CLI)" });
