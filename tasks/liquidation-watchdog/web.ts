// Live demo endpoint for the Liquidation Watchdog (api/router.ts → this file). Read-only: it re-reads the 13 Morpho Blue borrowers of the
// recorded mainnet scan (seed.ts) through the Chain MCP, ranks them, applies the thresholds and an optional collateral-price shock. Nothing
// is signed and nothing is sent (no Discord either). The CLI finds borrowers itself; a cold discovery takes minutes, so the page does not.
//   GET ?action=info
//   GET ?action=run[&shock=0.05][&warn=1.3][&critical=1.1]   NDJSON (steps, then one "done" line with a View)
import { getAddress, type Hex } from "viem";
import { buildAlert, checkThresholds, fmtHf, fmtToken, levelOf, marketLabel, pct, short, type Level } from "../../src/liq/alert.js";
import { dropToLiquidation, evaluate, readPosition, snapshotMarket, type MarketSnapshot, type PositionHealth } from "../../src/liq/morpho.js";
import { InputError, stepper, type Emit } from "../../src/web/live.js";
import { numParam, serve, type Deps } from "../../src/web/mainnet-live.js";
import type { View } from "../../src/web/view.js";
import { SEED } from "./seed.js";

export interface RunParams { shock: number; warn: number; critical: number }

export function parseRun(url: URL): RunParams {
  const q = url.searchParams;
  const p = { shock: numParam(q, "shock", 0, 0, 0.5), warn: numParam(q, "warn", 1.3, 1, 5), critical: numParam(q, "critical", 1.1, 1, 5) };
  if (p.critical >= p.warn) throw new InputError("critical must be below warn");
  return p;
}

interface Row { snap: MarketSnapshot; p: PositionHealth; hf: number; level: Level }

export function viewOf(rows: Row[], head: bigint, p: RunParams): View {
  const t = checkThresholds({ warn: p.warn, critical: p.critical, rearm: 0.02 });
  const worst = rows[0];
  const alerts = rows.filter((r) => r.level !== "ok" && Number(r.p.debt) / 10 ** r.snap.loan.decimals >= 1);
  const alert = alerts[0] && buildAlert(alerts[0].level as Exclude<Level, "ok">, alerts[0].snap, { ...alerts[0].p, hfNumber: alerts[0].hf, dropToLiquidation: dropToLiquidation(alerts[0].hf) }, t, new Date(), p.shock);
  return {
    tone: alerts.length ? (alerts.some((r) => r.level !== "warn") ? "bad" : "warn") : "ok",
    verdict: `${alerts.length} of ${rows.length} positions at or below ${p.warn.toFixed(2)}${p.shock > 0 ? ` after a ${pct(p.shock, 1)} collateral drop` : ""}`,
    note: `Block ${head} on Pharos mainnet. Health = collateral × oracle price × LLTV ÷ debt, Morpho Blue's own rule, interest accrued to the head block. Dust positions (debt under 1 unit) are listed but never alerted. This page reads the 13 borrowers of the recorded scan; the CLI discovers borrowers itself.`,
    tables: [{
      head: ["#", "Market", "Account", "Health", "Drop to liquidation", "Debt", "Level"],
      rows: rows.map((r, i) => [String(i + 1), marketLabel(r.snap), { t: short(r.p.user), href: `https://www.pharosscan.xyz/address/${r.p.user}` }, fmtHf(r.hf), pct(dropToLiquidation(r.hf)),
        `${fmtToken(r.p.debt, r.snap.loan.decimals)} ${r.snap.loan.symbol}`, r.level]),
    }],
    ...(alert ? { text: alert.text } : {}),
    evidence: [
      ["Reads", `Morpho Blue ${rows.length} positions in ${new Set(rows.map((r) => r.snap.id)).size} markets, through the Chain MCP (read-only)`],
      ["Thresholds", `warn ${p.warn.toFixed(2)} · critical ${p.critical.toFixed(2)}${p.shock > 0 ? ` · scenario: collateral −${pct(p.shock, 1)}` : ""}`],
      ["Closest to the edge", worst ? `${short(worst.p.user)} at ${fmtHf(worst.hf)}` : "none"],
    ],
    summary: `${alerts.length} alert${alerts.length === 1 ? "" : "s"} of ${rows.length} positions; closest ${worst ? fmtHf(worst.hf) : "n/a"}.`,
  };
}

export async function run(p: RunParams, emit: Emit, deps: Deps): Promise<void> {
  const t0 = Date.now();
  const conn = await deps.connect();
  emit({ type: "start", network: "pharos", endpoint: conn.endpoint });
  const s = stepper(emit);
  try {
    s.begin("head");
    const head = BigInt((await conn.call("get_block_number")).blockNumber);
    const block = await conn.call("get_block", { block: head.toString() });
    if (!block) throw new Error(`the Chain MCP returned no block ${head}`);
    s.end("head", "ok", `block ${head}`);
    s.begin("markets");
    const ids = [...new Set(SEED.map(([m]) => m))] as Hex[];
    const snaps = new Map<string, MarketSnapshot>();
    for (const id of ids) snaps.set(id, await snapshotMarket(conn.call, id, BigInt(block.timestamp)));
    s.end("markets", "ok", `${ids.length} markets`);
    s.begin("positions");
    const t = checkThresholds({ warn: p.warn, critical: p.critical, rearm: 0.02 });
    const rows: Row[] = [];
    for (const [m, u] of SEED) {
      const snap = snaps.get(m)!;
      const pos = evaluate(getAddress(u), await readPosition(conn.call, m as Hex, getAddress(u)), snap, p.shock);
      if (pos.debt === 0n) continue;
      rows.push({ snap, p: pos, hf: pos.hfNumber, level: levelOf(pos.hfNumber, t) });
    }
    rows.sort((a, b) => a.hf - b.hf);
    s.end("positions", "ok", `${rows.length} open`);
    s.begin("rank");
    s.end("rank", "ok", "ranked");
    emit({ type: "done", totalMs: Date.now() - t0, view: viewOf(rows, head, p) });
  } catch (e) {
    s.end(s.current ?? "head", "failed", (e as Error).message.slice(0, 160));
    throw e;
  } finally {
    await conn.close().catch(() => {});
  }
}

export const handle = serve("liquidation-watchdog", parseRun, run, { positions: SEED.length, params: "shock 0–0.5, warn, critical" });
