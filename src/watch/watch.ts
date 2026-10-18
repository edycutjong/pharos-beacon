import type { Hex, RpcLog } from "viem";
import { getLogsRange, type ChainMcp } from "../lib/mcp.js";
import { wait } from "../lib/net.js";
import { readState, writeState } from "../lib/state.js";

// A log watcher shared by the Event/Log Monitor and the On-Chain Alert Bot. It polls the Chain MCP's get_logs from a
// cursor, hands each log it has not handled yet to `onLog`, and records progress in a state file so a restart resumes
// where it stopped and never handles the same log twice.
//
// State: `next` = the first block not scanned yet; `seen` = `txHash:logIndex` of every handled log in blocks not yet
// passed by the cursor. A log is recorded the moment `onLog` returns, before the cursor moves, so a crash between the
// two re-scans the block but skips the log. A throwing `onLog` is retried on the next poll, and nothing after it is
// handled before it (chain order is kept).

export interface WatchState {
  /** First block number not yet scanned (decimal string). */
  next: string;
  /** Handled logs still inside the unscanned-again window: `txHash:logIndex` → block number. */
  seen: Record<string, string>;
}

export interface WatchFilter {
  address?: Hex | Hex[];
  topics?: (Hex | Hex[] | null)[];
}

export interface WatchOptions extends WatchFilter {
  call: ChainMcp["call"];
  stateFile: string;
  /** Where a fresh state file starts: a block number, or "head" (default) = only events from now on. */
  from?: bigint | "head";
  /** Blocks behind the head that are treated as final (default 0). */
  confirmations?: bigint;
  pollMs?: number;
  /** Stop after this many polls (the proof run); unset = run until `signal` aborts. */
  maxPolls?: number;
  /** Stop once this many new logs were handled in this run. */
  untilEvents?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onLog: (log: RpcLog) => void | Promise<void>;
  /** Called after every poll (for a heartbeat line). */
  onPoll?: (p: { head: bigint; scannedTo: bigint; fresh: number; polls: number }) => void;
}

export interface WatchResult {
  polls: number;
  handled: number;
  /** First block not scanned yet when the run ended. */
  next: bigint;
}

/** The identity of a log: transaction hash and log index (a block number alone cannot tell two events in one block apart). */
export function eventKey(log: Pick<RpcLog, "transactionHash" | "logIndex">): string {
  if (!log.transactionHash || log.logIndex == null) throw new Error("log has no transactionHash/logIndex (pending log?)");
  return `${log.transactionHash.toLowerCase()}:${BigInt(log.logIndex)}`;
}

const checkState = (v: unknown): WatchState => {
  const s = v as Partial<WatchState> | null;
  if (!s || typeof s.next !== "string" || !/^\d+$/.test(s.next) || typeof s.seen !== "object" || s.seen === null) throw new Error("watch state file has the wrong shape; refusing to guess (fix or remove it)");
  return { next: s.next, seen: s.seen as Record<string, string> };
};

/**
 * One poll: scan from the cursor to (head − confirmations), handle the new logs in chain order, advance the cursor.
 * Returns the number of logs handled. The state is written after every handled log and after the cursor moves.
 */
export async function pollOnce(o: WatchOptions): Promise<{ head: bigint; scannedTo: bigint | null; fresh: number; next: bigint }> {
  const head = BigInt((await o.call("get_block_number")).blockNumber);
  const safe = head - (o.confirmations ?? 0n);
  let state = readState<WatchState | null>(o.stateFile, null, checkState);
  if (!state) {
    const start = o.from === undefined || o.from === "head" ? safe + 1n : o.from;
    state = { next: start.toString(), seen: {} };
    writeState(o.stateFile, state);
  }
  const next = BigInt(state.next);
  if (safe < next) return { head, scannedTo: null, fresh: 0, next };
  const logs = await getLogsRange(o.call, { address: o.address, topics: o.topics, fromBlock: next, toBlock: safe });
  let fresh = 0;
  for (const log of logs) {
    const key = eventKey(log);
    if (state.seen[key] !== undefined) continue;
    await o.onLog(log); // a throw leaves the log (and everything after it) for the next poll
    state.seen[key] = BigInt(log.blockNumber!).toString();
    writeState(o.stateFile, state);
    fresh++;
  }
  // Blocks below the new cursor are never scanned again, so their keys can go.
  const cursor = safe + 1n;
  state = { next: cursor.toString(), seen: Object.fromEntries(Object.entries(state.seen).filter(([, b]) => BigInt(b) >= cursor)) };
  writeState(o.stateFile, state);
  return { head, scannedTo: safe, fresh, next: cursor };
}

/** Poll until `signal` aborts, `maxPolls` is reached or `untilEvents` logs were handled. */
export async function watch(o: WatchOptions): Promise<WatchResult> {
  const pollMs = o.pollMs ?? 3_000;
  const sleep = o.sleep ?? wait;
  let polls = 0;
  let handled = 0;
  let next = 0n;
  while (!o.signal?.aborted) {
    const r = await pollOnce(o);
    polls++;
    handled += r.fresh;
    next = r.next;
    o.onPoll?.({ head: r.head, scannedTo: r.scannedTo ?? r.next - 1n, fresh: r.fresh, polls });
    if (o.maxPolls !== undefined && polls >= o.maxPolls) break;
    if (o.untilEvents !== undefined && handled >= o.untilEvents) break;
    try {
      await sleep(pollMs, o.signal);
    } catch {
      break; // aborted while sleeping
    }
  }
  return { polls, handled, next };
}
