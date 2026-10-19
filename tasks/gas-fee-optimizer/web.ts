// The live demo behind pharos.edycu.dev/gas-fee-optimizer (api/gas-fee-optimizer.ts). It runs the CLI's own sampler and
// hold loop (src/gas/optimizer.ts) on Atlantic, read-only: the hold ends with the decision (send now: gas at target, or
// the send-by time reached) and the page stops there. The real sends are on the page as recorded runs from the committed
// proofs. Reads come from the public Atlantic RPC (the Atlantic Chain MCP runs over stdio and cannot run on Vercel).
//   GET ?action=info
//   GET ?action=sample&count=1..8                                       gas samples, 3 s apart
//   GET ?action=hold&deadline=10..45&target=gwei:<n>|p:<1-100>[&window=5..50][&interval=2..10]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatEther, formatGwei, parseGwei } from "viem";
import { atlanticCall, ATLANTIC_RPC, type Rpc } from "../../src/lib/atlantic-call.js";
import { busy, deployInfo, gate, InputError, json, ndjson, type Emit } from "../../src/lib/demo-stream.js";
import { holdUntilFavourable, paidReport, takeSample, type Sample, type Target } from "../../src/gas/optimizer.js";
import { defaultLead } from "./index.js";

/** A plain PHRS transfer: what the CLI sends in every recorded run, used for the "what it would pay" line. */
export const TRANSFER_GAS = 21_000n;
export const LIMITS = { count: [1, 8], deadline: [10, 45], interval: [2, 10], window: [5, 50] } as const;

const int = (q: URLSearchParams, name: keyof typeof LIMITS, fallback: number): number => {
  const v = q.get(name);
  const n = v === null || v === "" ? fallback : Number(v);
  const [lo, hi] = LIMITS[name];
  if (!Number.isInteger(n) || n < lo || n > hi) throw new InputError(`${name} must be a whole number from ${lo} to ${hi}`);
  return n;
};

export interface HoldParams {
  deadlineS: number;
  leadS: number;
  intervalS: number;
  target: Target;
}

export function holdParams(q: URLSearchParams): HoldParams {
  const deadlineS = int(q, "deadline", 30);
  const intervalS = int(q, "interval", 3);
  const t = q.get("target") ?? "gwei:0.5";
  let target: Target;
  const m = /^(gwei|p):(\d{1,4}(?:\.\d{1,9})?)$/.exec(t);
  if (!m) throw new InputError("target must be gwei:<price> (e.g. gwei:0.5) or p:<percentile> (e.g. p:25)");
  if (m[1] === "gwei") {
    const n = Number(m[2]);
    if (!(n > 0 && n <= 1000)) throw new InputError("a gwei target must be above 0 and at most 1000");
    target = { kind: "price", wei: parseGwei(m[2]!) };
  } else {
    const p = Number(m[2]);
    if (!Number.isInteger(p) || p < 1 || p > 100) throw new InputError("a percentile target must be a whole number from 1 to 100");
    target = { kind: "percentile", p, window: int(q, "window", 20) };
  }
  return { deadlineS, leadS: defaultLead(undefined, deadlineS), intervalS, target };
}

const sampleView = (s: Sample) => ({ ...s, priceGwei: formatGwei(BigInt(s.priceWei)), baseGwei: formatGwei(BigInt(s.baseFeeWei)), priorityGwei: formatGwei(BigInt(s.priorityWei)) });

/** `count` samples, 3 s apart, streamed one by one. */
export async function runSample(emit: Emit, count: number, signal: AbortSignal, rpc?: Rpc, gapMs = 3_000): Promise<void> {
  const call = atlanticCall({ ...(rpc ? { rpc } : {}), maxCalls: count * 3 + 2 });
  const t0 = Date.now();
  emit({ type: "start", mode: "sample", count, via: `Atlantic RPC ${ATLANTIC_RPC} (read-only)` });
  const samples: Sample[] = [];
  for (let i = 0; i < count && !signal.aborted; i++) {
    const s0 = Date.now();
    const s = await takeSample(call);
    samples.push(s);
    emit({ type: "sample", i, ms: Date.now() - s0, ...sampleView(s) });
    if (i < count - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  const prices = samples.map((s) => BigInt(s.priceWei));
  const min = prices.reduce((a, b) => (b < a ? b : a));
  const max = prices.reduce((a, b) => (b > a ? b : a));
  emit({ type: "done", mode: "sample", samples: samples.map(sampleView), minGwei: formatGwei(min), maxGwei: formatGwei(max), totalMs: Date.now() - t0, summary: `${samples.length} samples · min ${formatGwei(min)} · max ${formatGwei(max)} gwei` });
}

/**
 * The CLI's hold loop, live: it samples every `intervalS` until the price is at or below the target or the send-by time
 * (deadline − lead) arrives, then decides. Nothing is sent from here; the decision and what a 21,000-gas transfer would
 * pay at the decision price against the request price are reported.
 */
export async function runHold(emit: Emit, p: HoldParams, rpc?: Rpc, now: () => Date = () => new Date()): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "beacon-gas-"));
  const stateFile = join(dir, "gas.json"); // this run's own history, never the committed state/gas.json
  try {
    const call = atlanticCall({ ...(rpc ? { rpc } : {}), maxCalls: 80 });
    const t0 = now().getTime();
    const deadline = new Date(t0 + p.deadlineS * 1000);
    const decideBy = new Date(deadline.getTime() - p.leadS * 1000);
    const targetText = p.target.kind === "price" ? `${formatGwei(p.target.wei)} gwei` : `p${p.target.p} of the last ${p.target.window} samples`;
    emit({ type: "start", mode: "hold", deadline: deadline.toISOString(), decideBy: decideBy.toISOString(), deadlineS: p.deadlineS, leadS: p.leadS, intervalS: p.intervalS, target: targetText, via: `Atlantic RPC ${ATLANTIC_RPC} (read-only)` });
    let i = 0;
    const sample = async () => {
      const s0 = Date.now();
      const s = await takeSample(call);
      emit({ type: "sample", i: i++, ms: Date.now() - s0, secondsToDeadline: Math.max(0, Math.round((deadline.getTime() - Date.now()) / 1000)), ...sampleView(s) });
      return s;
    };
    const lines: string[] = [];
    const d = await holdUntilFavourable({ deadline: decideBy, target: p.target, intervalMs: p.intervalS * 1000, stateFile, sample, log: (l) => lines.push(l) });
    const decisionPrice = d.decisionPriceWei ?? d.requestPriceWei;
    const rep = paidReport(TRANSFER_GAS, decisionPrice, d.requestPriceWei);
    const why = d.reason === "deadline reached" ? "send-by time reached (deadline − lead): sends now whatever the price" : "gas at or below target: sends now";
    emit({
      type: "done",
      mode: "hold",
      reason: d.reason,
      why,
      heldMs: d.heldMs,
      samplesTaken: d.samplesTaken,
      sampleErrors: d.sampleErrors,
      requestGwei: formatGwei(d.requestPriceWei),
      decisionGwei: formatGwei(decisionPrice),
      targetGwei: d.targetWei === null ? null : formatGwei(d.targetWei),
      secondsBeforeDeadline: Math.round((deadline.getTime() - Date.now()) / 100) / 10,
      wouldPayPHRS: formatEther(rep.paidWei),
      atRequestPHRS: formatEther(rep.atRequestPriceWei),
      savedPct: rep.savedPct,
      log: lines,
      totalMs: now().getTime() - t0,
      summary: `Decision after ${(d.heldMs / 1000).toFixed(1)} s and ${d.samplesTaken} samples: ${why}. Not sent from this page.`,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runGate = gate(2_000);

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams;
  const action = q.get("action") ?? "info";
  try {
    if (action === "info") return json(200, { deploy: deployInfo(), via: ATLANTIC_RPC, limits: LIMITS });
    if (action === "sample") {
      const count = int(q, "count", 6);
      const wait = runGate.take();
      if (wait) return busy(wait);
      return ndjson((emit, signal) => runSample(emit, count, signal), () => runGate.release());
    }
    if (action === "hold") {
      const p = holdParams(q);
      const wait = runGate.take();
      if (wait) return busy(wait);
      return ndjson((emit) => runHold(emit, p), () => runGate.release());
    }
    return json(400, { error: `unknown action ${JSON.stringify(action).slice(0, 40)}: use info, sample or hold` });
  } catch (e) {
    if (e instanceof InputError) return json(400, { error: e.message });
    throw e;
  }
}
