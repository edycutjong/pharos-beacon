// Live demo for the Event/Log Monitor (web/event-log-monitor, api/event-log-monitor.ts). Read-only.
//   GET /api/event-log-monitor?action=health
//   GET /api/event-log-monitor?action=run&scenario=mainnet-usdc|atlantic-proof|custom[&network&contract&event&blocks]   NDJSON
// A run is the CLI's own watcher (src/watch: pollOnce with a cursor file) driven poll by poll: a backfill poll, a live
// poll a few seconds later, then a "restart" (a fresh reader of the same cursor file). Every event is printed once.
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { busyResponse, concurrency, deployInfo, InputError, json, ndjson, openReader, pickAddress, pickInt, pickNetwork, pinHead, type CallRecord, type Emit, type Reader } from "../../src/web/demo.js";
import { type Network } from "../../src/lib/mcp.js";
import { explorerTx, TOKENS } from "../../src/lib/networks.js";
import { readState } from "../../src/lib/state.js";
import { amountText, decodeLog, parseEvent } from "../../src/watch/decode.js";
import { tokenInfo } from "../../src/watch/token.js";
import { pollOnce, savedCursor, type WatchState } from "../../src/watch/watch.js";

/** Events a stranger may pick by name (full signatures stay a CLI feature). */
export const EVENTS = ["Transfer", "Approval", "Deposit", "Withdrawal"] as const;

export interface RunSpec {
  network: Network;
  contract: Hex;
  event: (typeof EVENTS)[number];
  /** Backfill this many blocks before the head (custom/mainnet). */
  blocks?: number;
  /** Replay a fixed window: start here, and pin the head for poll 1, poll 2 and the restart (the recorded Atlantic runs). */
  from?: bigint;
  pins?: readonly [bigint, bigint, bigint];
  /** Wait between the polls (ms). */
  pollMs: number;
}

export const SCENARIOS = {
  /** Real traffic, keyless: USDC transfers on Pacific mainnet through the hosted Chain MCP (the README's mainnet command). */
  "mainnet-usdc": { network: "pharos", contract: getAddress(TOKENS.pharos.USDC.address), event: "Transfer", blocks: 300, pollMs: 3000 },
  /** The recorded Atlantic window: the 4 WPHRS transfers the CLI caught on 2026-10-18 (live-run + restart-run-head proofs). */
  // Poll 1 stops where the recorded live run stopped (next block 31555651), the restart then reaches 31555680 like the
  // recorded restart-run-head: it must print only the two newer transfers (blocks 31555672 and 31555676).
  "atlantic-proof": { network: "atlantic", contract: getAddress(TOKENS.atlantic.WPHRS.address), event: "Transfer", from: 31555620n, pins: [31555650n, 31555665n, 31555680n], pollMs: 1500 },
} as const satisfies Record<string, RunSpec>;
export type Scenario = keyof typeof SCENARIOS | "custom";

/** Read and check the query string. Throws InputError with a message the page shows. */
export function parseRun(url: URL): RunSpec {
  const scenario = url.searchParams.get("scenario") ?? "mainnet-usdc";
  if (scenario in SCENARIOS) return { ...SCENARIOS[scenario as keyof typeof SCENARIOS] };
  if (scenario !== "custom") throw new InputError(`scenario must be one of ${[...Object.keys(SCENARIOS), "custom"].join(", ")}`);
  const event = url.searchParams.get("event") ?? "Transfer";
  if (!(EVENTS as readonly string[]).includes(event)) throw new InputError(`event must be one of ${EVENTS.join(", ")}`);
  return {
    network: pickNetwork(url.searchParams.get("network"), "pharos"),
    contract: getAddress(pickAddress(url.searchParams.get("contract"))),
    event: event as RunSpec["event"],
    blocks: pickInt(url.searchParams.get("blocks"), "blocks", 1, 1000, 300),
    pollMs: 3000,
  };
}

export interface EventRow {
  poll: number;
  block: string;
  logIndex: number;
  tx: Hex;
  explorer: string;
  from?: Hex;
  to?: Hex;
  amount: string;
  /** Other decoded parameters by name. */
  extra: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One demo run, streamed. `open` is injectable for tests. */
export async function run(spec: RunSpec, emit: Emit, open: (n: Network, onCall: (r: CallRecord) => void) => Promise<Reader> = (n, c) => openReader(n, c)): Promise<void> {
  const calls: CallRecord[] = [];
  const onCall = (r: CallRecord) => {
    calls.push(r);
    emit({ type: "call", ...r });
  };
  const evt = parseEvent(spec.event);
  emit({ type: "start", network: spec.network, contract: spec.contract, event: evt.signature, topic0: evt.topic0, pinned: spec.pins?.map(String) ?? null });

  let t = performance.now();
  const since = () => Math.round(performance.now() - t);
  const reader = await open(spec.network, onCall).catch((e) => {
    emit({ type: "step", id: "connect", state: "failed", label: "no connection", ms: since() });
    throw e;
  });
  const stateFile = join(tmpdir(), "beacon-web", `elm-${randomUUID()}.json`);
  try {
    emit({ type: "step", id: "connect", state: "ok", label: `chain ${reader.chainId}`, ms: since(), detail: { endpoint: reader.endpoint, via: reader.via } });
    let stage = 0;
    const call = spec.pins ? pinHead(reader.call, () => spec.pins![stage]!) : reader.call;

    t = performance.now();
    const head = BigInt((await call("get_block_number")).blockNumber);
    const info = await tokenInfo(call, spec.contract);
    emit({ type: "step", id: "token", state: "ok", label: info ? `${info.symbol} · ${info.decimals} dec` : "not an ERC-20", ms: since(), detail: { head: head.toString(), token: info ?? null } });

    const from = spec.from ?? (head >= BigInt(spec.blocks ?? 300) ? head - BigInt(spec.blocks ?? 300) : 0n);
    const printed = new Map<string, number>();
    const rows: EventRow[] = [];
    let poll = 0;
    const onLog = (log: Parameters<Parameters<typeof pollOnce>[0]["onLog"]>[0]) => {
      const e = decodeLog(evt, log);
      const key = `${e.tx.toLowerCase()}:${e.logIndex}`;
      printed.set(key, (printed.get(key) ?? 0) + 1);
      const extra = Object.fromEntries(Object.entries(e.fields).filter(([k]) => !["from", "to", "src", "dst", "value", "wad", "amount", "owner", "spender"].includes(k)));
      const row: EventRow = { poll, block: e.block.toString(), logIndex: e.logIndex, tx: e.tx, explorer: explorerTx(spec.network, e.tx), ...(e.from ? { from: e.from } : {}), ...(e.to ? { to: e.to } : {}), amount: amountText(e, info?.decimals, info?.symbol), extra };
      rows.push(row);
      emit({ type: "event", ...row });
    };
    const watchOpts = { call, address: spec.contract, topics: [evt.topic0], stateFile, from, onLog };

    // Poll 1: the backfill window, from `from` to the head.
    poll = 1;
    t = performance.now();
    const p1 = await pollOnce(watchOpts);
    emit({ type: "step", id: "poll1", state: "ok", label: `${p1.fresh} event${p1.fresh === 1 ? "" : "s"}`, ms: since(), detail: { from: from.toString(), to: p1.scannedTo?.toString() ?? null, fresh: p1.fresh, cursor: p1.next.toString() } });

    // Poll 2: one poll interval later, only what is new since the cursor.
    await sleep(spec.pollMs);
    poll = 2;
    stage = 1;
    t = performance.now();
    const p2 = await pollOnce(watchOpts);
    emit({ type: "step", id: "poll2", state: "ok", label: `+${p2.fresh} new`, ms: since(), detail: { from: p1.next.toString(), to: p2.scannedTo?.toString() ?? null, fresh: p2.fresh, cursor: p2.next.toString() } });

    // Restart: a new reader of the same cursor file, as a restarted process would be. `from` is ignored once a state exists.
    await sleep(Math.min(spec.pollMs, 1500));
    poll = 3;
    stage = 2;
    t = performance.now();
    const resumeAt = savedCursor(stateFile);
    const p3 = await pollOnce({ ...watchOpts, from: 0n });
    const repeated = [...printed.values()].filter((n) => n > 1).length;
    emit({ type: "step", id: "restart", state: repeated ? "failed" : "ok", label: `resumed · ${repeated} repeated`, ms: since(), detail: { resumedAt: resumeAt?.toString() ?? null, to: p3.scannedTo?.toString() ?? null, fresh: p3.fresh, cursor: p3.next.toString() } });

    const state = readState<WatchState | null>(stateFile, null);
    emit({
      type: "done",
      network: spec.network,
      endpoint: reader.endpoint,
      via: reader.via,
      chainId: reader.chainId,
      contract: spec.contract,
      token: info ?? null,
      event: evt.signature,
      topic0: evt.topic0,
      head: head.toString(),
      pinned: spec.pins?.map(String) ?? null,
      range: { from: from.toString(), to: (p3.scannedTo ?? p3.next - 1n).toString() },
      polls: 3,
      events: rows.length,
      repeated,
      state,
      calls: calls.length,
    });
  } finally {
    rmSync(stateFile, { force: true });
    rmSync(`${stateFile}.lock`, { force: true });
    await reader.close().catch(() => {});
  }
}

const gate = concurrency(4);

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "health";
  try {
    if (req.method !== "GET") return json({ error: "use GET" }, 405);
    if (action === "health") return json({ status: "ok", task: "event-log-monitor", scenarios: SCENARIOS, events: EVENTS, deploy: deployInfo() });
    if (action === "run") {
      const spec = parseRun(url);
      if (!gate.take()) return busyResponse("monitor run");
      return ndjson((emit) => run(spec, emit), () => gate.release());
    }
    return json({ error: `unknown action ${JSON.stringify(action)}; use health or run` }, 404);
  } catch (e) {
    if (e instanceof InputError) return json({ error: e.message }, 400);
    return json({ error: (e as Error).message }, 500);
  }
}
