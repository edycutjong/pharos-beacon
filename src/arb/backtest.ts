import type { Call, Market } from "./venues.js";
import { readDodo, readUniV3 } from "./venues.js";
import { fmtUnits, makeRecord, scanVenues, type ScanConfig, type ScanRecord } from "./scan.js";
import type { Hex } from "viem";

// Backtest on real history: the same two sources, the same decision rule, read AT pinned past blocks (eth_call with a block).

export async function secondsPerBlock(call: Call, head: bigint, span = 100_000n): Promise<number> {
  const [a, b] = await Promise.all([call("get_block", { block: head.toString() }), call("get_block", { block: (head - span).toString() })]);
  return (Number(BigInt(a!.timestamp)) - Number(BigInt(b!.timestamp))) / Number(span);
}

/** `count` blocks spaced `everySec` apart ending at the head, oldest first. */
export function pinBlocks(head: bigint, count: number, everySec: number, secPerBlock: number): bigint[] {
  const step = Math.max(1, Math.round(everySec / secPerBlock));
  return Array.from({ length: count }, (_, i) => head - BigInt((count - 1 - i) * step));
}

export interface BacktestSummary {
  scans: number;
  blocks: { first: string; last: string; hoursCovered: number };
  grossSpreadPositive: number;
  acted: number;
  skipped: number;
  skippedBecause: Record<string, number>;
  bestNet: string;
  medianBestGrossBps: number;
  failed: number;
}

export async function backtest(o: {
  call: Call; m: Market; uni: Hex; dodo: Hex; pins: bigint[]; cfg: ScanConfig; onScan?: (r: ScanRecord, i: number) => void;
}): Promise<{ records: ScanRecord[]; summary: BacktestSummary }> {
  const records: ScanRecord[] = [];
  let failed = 0;
  for (const [i, block] of o.pins.entries()) {
    try {
      const blk = await o.call("get_block", { block: block.toString() });
      if (!blk?.baseFeePerGas) throw new Error(`block ${block} has no base fee`);
      const cfg = { ...o.cfg, gasPriceWei: BigInt(blk.baseFeePerGas) };
      const venues = await Promise.all([readUniV3(o.call, o.uni, o.m, block), readDodo(o.call, o.dodo, o.m, block)]);
      const candidates = await scanVenues([venues[0], venues[1]], o.m, cfg);
      const rec = makeRecord({ network: "pharos", block, m: o.m, venues, cfg, candidates, at: new Date(Number(BigInt(blk.timestamp)) * 1000) });
      records.push(rec);
      o.onScan?.(rec, i);
    } catch (e) {
      failed++;
      o.onScan?.({ at: "", network: "pharos", block: block.toString(), market: { base: "", quote: "" }, sources: [], config: {} as ScanRecord["config"], candidates: [], best: null, decision: "SKIP", reason: `could not read this block: ${(e as Error).message.slice(0, 100)}` }, i);
    }
  }
  const d = o.m.quote.decimals;
  const acted = records.filter((r) => r.decision === "ACT");
  const because: Record<string, number> = {};
  for (const r of records.filter((x) => x.decision === "SKIP")) {
    const k = r.reason.startsWith("no positive gross spread") ? "no positive gross spread in either direction" : r.reason.includes("does not survive its costs") ? "gross spread did not survive costs" : "no route could be quoted";
    because[k] = (because[k] ?? 0) + 1;
  }
  const grosses = records.map((r) => r.best?.grossBps ?? 0).sort((a, b) => a - b);
  const bests = records.flatMap((r) => (r.best ? [r.best.net] : []));
  const first = records[0], last = records[records.length - 1];
  return {
    records,
    summary: {
      scans: records.length,
      blocks: { first: first?.block ?? "", last: last?.block ?? "", hoursCovered: first && last ? Number(((Date.parse(last.at) - Date.parse(first.at)) / 3.6e6).toFixed(1)) : 0 },
      grossSpreadPositive: records.filter((r) => (r.best?.gross ?? 0n) > 0n).length,
      acted: acted.length, skipped: records.length - acted.length, skippedBecause: because,
      bestNet: bests.length ? fmtUnits(bests.reduce((a, b) => (b > a ? b : a)), d) : "n/a",
      medianBestGrossBps: grosses.length ? Number(grosses[Math.floor(grosses.length / 2)]!.toFixed(1)) : 0, failed,
    },
  };
}
