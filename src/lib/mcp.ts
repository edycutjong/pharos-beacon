import { REPO_ROOT, envOr } from "./env.js"; // first: loads .env before anything reads the environment
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Hex, RpcBlock, RpcLog, RpcTransaction, RpcTransactionReceipt } from "viem";
import { CLIENT_INFO, ToolError, endpointLabel, isTransient, limiterFor, rejectUserinfo, throttleAwareFetch, wait, withRetry, type RateLimiter } from "./net.js";
import { atlantic, pharos } from "./networks.js";

export type Network = "pharos" | "atlantic";
export const NETWORKS = ["pharos", "atlantic"] as const satisfies readonly Network[];
/** The chain each network must serve. A connection to an endpoint that reports any other chain is refused. */
export const CHAIN_ID: Record<Network, number> = { pharos: pharos.id, atlantic: atlantic.id };

/** Hosted Pharos Chain MCP: mainnet, read-only, keyless, 120 requests per minute per IP. PHAROS_MCP_URL overrides it. */
export const chainMcpUrl = () => envOr("PHAROS_MCP_URL", "https://mcp.pharos.xyz/mcp");

/** The hosted server is mainnet-only, so Atlantic runs the same sponsor server locally over stdio (built by
 *  scripts/setup-testnet-mcp.sh). PHAROS_MCP_BIN overrides the path. */
export const testnetMcpBin = () => envOr("PHAROS_MCP_BIN", join(REPO_ROOT, ".cache/pharos-mcp/dist/src/index.js"));

/** What each sponsor tool returns (PharosNetwork/pharos-mcp, src/server.ts). Quantities are decimal strings or hex. */
export interface ChainToolResults {
  get_chain_info: {
    name: string;
    chainId: number;
    chainIdHex: Hex;
    expectedChainId: number;
    chainIdMatches: boolean;
    latestBlock: string;
    latestBlockHex: Hex;
    nativeSymbol: string;
    clientVersion: string;
    rpcUrl: string;
  };
  get_block_number: { blockNumber: string; blockNumberHex: Hex };
  get_balance: { address: Hex; balanceWei: string; balance: string; symbol: string; balanceHex: Hex };
  get_transaction_count: { nonce: string; nonceHex: Hex };
  get_gas_price: {
    gasPriceWei: string;
    gasPriceGwei: string;
    gasPriceHex: Hex;
    maxPriorityFeePerGasWei: string;
    maxPriorityFeePerGasGwei: string;
    maxPriorityFeePerGasHex: Hex;
  };
  get_block: RpcBlock | null;
  get_transaction: RpcTransaction | null;
  get_transaction_receipt: RpcTransactionReceipt | null;
  get_code: { code: Hex };
  get_storage_at: { value: Hex };
  eth_call: { result: Hex };
  estimate_gas: { gas: string; gasHex: Hex };
  get_logs: RpcLog[];
  send_raw_transaction: { txHash: Hex };
}
export type ChainTool = keyof ChainToolResults;

/**
 * A Chain MCP tool answered isError. `code` and `data` are the JSON-RPC error's when the server passed them on: a
 * revert is code 3 with the revert bytes in `data`. Never retried here: the server already retries its own RPC.
 */
export class ChainToolError extends ToolError {
  override name = "ChainToolError";
  constructor(
    tool: string,
    readonly reason: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(tool, code === undefined ? reason : `${reason} (code ${code})`);
  }
}

/** Every call on a closed client, including one that was waiting when close() ran, fails with this. */
export class ClientClosedError extends Error {
  override name = "ClientClosedError";
  constructor() {
    super("the Chain MCP client is closed");
  }
}

/** Parse one tools/call result: JSON on success, ChainToolError on isError, a missing text block or non-JSON text. */
export function parseToolResult(tool: string, reply: unknown): unknown {
  const res = (reply ?? {}) as { content?: unknown; isError?: unknown };
  const blocks = Array.isArray(res.content) ? (res.content as { type?: unknown; text?: unknown }[]) : [];
  const text = blocks.find((b) => b?.type === "text" && typeof b.text === "string")?.text as string | undefined;
  if (res.isError) {
    const e = errorFields(text);
    throw new ChainToolError(tool, e.message, e.code, e.data);
  }
  if (text === undefined) throw new ChainToolError(tool, "reply has no text content");
  try {
    return JSON.parse(text);
  } catch {
    throw new ChainToolError(tool, `reply is not JSON: ${JSON.stringify(text.slice(0, 80))}`);
  }
}

// The sponsor server reports failures as {"error":{"message","code","data"}}; anything else is kept as text.
function errorFields(text: string | undefined): { message: string; code?: number; data?: unknown } {
  if (!text) return { message: "error (no details)" };
  try {
    const e = (JSON.parse(text) as { error?: { message?: unknown; code?: unknown; data?: unknown } } | null)?.error;
    if (e && typeof e.message === "string") {
      return { message: e.message.trim() || "error", code: typeof e.code === "number" ? e.code : undefined, data: e.data };
    }
  } catch {
    // not JSON: fall through to the text
  }
  return { message: text.replace(/\s+/g, " ").trim().slice(0, 300) };
}

export interface ChainMcpOptions {
  /** Budget in ms for each request attempt and for the whole handshake (default 30 000; the SDK alone would wait 60 s). */
  timeoutMs?: number;
  /** Extra attempts after a transient failure of a read tool (default 2: waits 0.5 s, then 1.5 s, plus any pause the server asked for). */
  retries?: number;
  /**
   * Client-side requests per minute (0 = unlimited). Default 100 for the hosted endpoint (its limit is 120 per IP) and
   * 60 for the local server, whose upstream Atlantic RPC allows 500 per 5 min and costs 1–3 RPC calls per tool call.
   * Every client of one endpoint in this process shares one budget, and the stricter setting wins.
   */
  perMinute?: number;
  /** A limiter of your own instead of the shared one (tests). */
  limiter?: RateLimiter;
  /** Hosted endpoint for "pharos" (default PHAROS_MCP_URL, else https://mcp.pharos.xyz/mcp). */
  url?: string;
  /** Atlantic only: let the local server relay signed transactions (send_raw_transaction). Off unless a signer needs it. */
  broadcast?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface CallOptions {
  timeoutMs?: number;
  /** Extra attempts for this call (default: the client's `retries`; a broadcast is always sent once). */
  retries?: number;
}

export interface ChainMcp {
  readonly network: Network;
  /** Checked at connect: the endpoint reported exactly CHAIN_ID[network]. */
  readonly chainId: number;
  /** The server's name and version from initialize. */
  readonly server: { name: string; version: string } | undefined;
  /** Where reads come from, safe to print or store in a proof (no credentials, no home paths). */
  readonly endpoint: string;
  /** True only for an Atlantic client opened with `broadcast: true`. */
  readonly broadcast: boolean;
  /** The request budget per minute this client paces itself to (0 = unlimited). */
  readonly perMinute: number;
  /** Call one tool and return its parsed JSON. Read tools retry transient failures; a broadcast is sent once. */
  call<K extends ChainTool>(name: K, args?: Record<string, unknown>, opts?: CallOptions): Promise<ChainToolResults[K]>;
  call(name: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<unknown>;
  listTools(): Promise<{ name: string; description?: string }[]>;
  /** Ends the server session (DELETE on HTTP, so it does not idle for 30 min on the hosted server) and closes. */
  close(): Promise<void>;
}

const TIMEOUT_MS = 30_000;
const STDERR_TAIL = 2_000;
/** The longest Retry-After worth waiting for inside one call: one full fixed window plus slack. */
const MAX_THROTTLE_WAIT_MS = 65_000;
/** What one handshake costs the hosted server's limiter: initialize, notifications/initialized, the SDK's GET stream, get_chain_info. */
const HANDSHAKE_REQUESTS = 4;

type Transport = StreamableHTTPClientTransport | StdioClientTransport;
interface Conn {
  client: Client;
  transport: Transport;
}

/** The hosted server forgot the session (idle eviction, deploy, another instance): reconnect and retry. */
const sessionGone = (e: unknown) => e instanceof StreamableHTTPError && e.code === 404;
const throttled = (e: unknown) => e instanceof StreamableHTTPError && (e.code === 429 || e.code === 503);

/** Everything the local server gets besides the SDK's safe defaults (HOME, LOGNAME, PATH, SHELL, TERM, USER): never a key. */
export function stdioEnv(broadcast: boolean): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    PHAROS_RPC_URL: atlantic.rpcUrls.default.http[0],
    PHAROS_CHAIN_ID: String(atlantic.id),
    PHAROS_NATIVE_SYMBOL: atlantic.nativeCurrency.symbol,
    ENABLE_SEND_RAW_TRANSACTION: broadcast ? "true" : "false",
  };
}

// "local stdio PharosNetwork/pharos-mcp@9a3750c" when built by setup-testnet-mcp.sh, else the binary's repo-relative name.
function localServerLabel(bin: string): string {
  try {
    const commit = readFileSync(join(dirname(bin), "../../.commit"), "utf8").trim();
    return `local stdio PharosNetwork/pharos-mcp@${commit.slice(0, 7)}`;
  } catch {
    const rel = relative(REPO_ROOT, bin);
    return `local stdio ${rel.startsWith("..") ? basename(bin) : rel}`;
  }
}

/**
 * Connect to the Chain MCP for `network` and verify the chain it serves. Mainnet ("pharos") uses the hosted endpoint;
 * Atlantic spawns the sponsor server locally over stdio. Always `await mcp.close()` (a CLI does it in `onExit`).
 */
export async function chainMcp(network: Network = "pharos", opts: ChainMcpOptions = {}): Promise<ChainMcp> {
  const ms = opts.timeoutMs ?? TIMEOUT_MS;
  const expected = CHAIN_ID[network];
  const broadcast = network === "atlantic" && opts.broadcast === true;
  const stop = new AbortController(); // aborted by close(): ends any wait at once
  const sleep = opts.sleep ?? ((t: number) => wait(t, stop.signal).catch(() => Promise.reject(new ClientClosedError())));
  // Wait for request slots; close() ends the wait at once.
  const slots = (n: number) => limiter.take(n, stop.signal).catch((e: unknown) => Promise.reject(stop.signal.aborted ? new ClientClosedError() : e));

  // The latest 429/503 and the wait it asked for; the limiter holds every caller until then.
  let throttle: { at: number; ms: number | undefined } | undefined;
  let endpoint: string;
  let limiterKey: string;
  let makeTransport: () => { transport: Transport; stderr: () => string };
  if (network === "pharos") {
    const url = opts.url ?? chainMcpUrl();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("the Chain MCP URL (PHAROS_MCP_URL or opts.url) is not a valid URL");
    }
    rejectUserinfo(parsed, "the Chain MCP URL (PHAROS_MCP_URL or opts.url)");
    endpoint = limiterKey = endpointLabel(url);
    const fetchFn = throttleAwareFetch((_status, wantMs) => {
      throttle = { at: Date.now(), ms: wantMs };
      if (wantMs !== undefined && wantMs <= MAX_THROTTLE_WAIT_MS) limiter.pauseFor(wantMs);
    });
    makeTransport = () => ({ transport: new StreamableHTTPClientTransport(parsed, { fetch: fetchFn }), stderr: () => "" });
  } else {
    const bin = testnetMcpBin();
    if (!existsSync(bin)) throw new Error(`${bin} missing — run: npm run setup:mcp`);
    endpoint = localServerLabel(bin);
    limiterKey = `stdio ${bin}`;
    makeTransport = () => {
      const transport = new StdioClientTransport({ command: process.execPath, args: [bin], env: stdioEnv(broadcast), stderr: "pipe" });
      let tail = "";
      transport.stderr?.on("data", (chunk: Buffer) => void (tail = (tail + chunk.toString()).slice(-STDERR_TAIL)));
      return { transport, stderr: () => tail.trim() };
    };
  }
  const limiter = opts.limiter ?? limiterFor(limiterKey, opts.perMinute ?? (network === "pharos" ? 100 : 60));
  const handshakeCost = network === "pharos" ? HANDSHAKE_REQUESTS : 1;

  let conn: Conn | undefined;
  let opening: Promise<Conn> | undefined;
  const handshaking = new Set<Conn>(); // connections still in their handshake, so close() can end them at once
  let closed = false;

  async function shut(c: Conn): Promise<void> {
    if (c.transport instanceof StreamableHTTPClientTransport && c.transport.sessionId) {
      limiter.note(); // the DELETE is sent without waiting for a slot: closing should never stall
      let timer: ReturnType<typeof setTimeout> | undefined;
      const transport = c.transport;
      await Promise.race([transport.terminateSession().catch(() => {}), new Promise((r) => (timer = setTimeout(r, 5_000)))]);
      clearTimeout(timer);
    }
    await c.client.close().catch(() => {});
  }

  // Worth another attempt: transient trouble (unless the server asked for a longer pause than one call should wait),
  // a forgotten session, or a local server that went away.
  const retryable = (e: unknown) => {
    if (throttled(e) && throttle && Date.now() - throttle.at < 5_000 && (throttle.ms ?? 0) > MAX_THROTTLE_WAIT_MS) return false;
    return isTransient(e) || sessionGone(e) || (!closed && e instanceof McpError && e.code === ErrorCode.ConnectionClosed);
  };
  // Name the wait the server asked for when giving up on a 429/503, so the cause is never just "error POSTing".
  const explain = (e: unknown) => {
    if (throttled(e) && throttle && Date.now() - throttle.at < 5_000 && e instanceof Error) {
      e.message = `${e.message} — the server asked to wait ${throttle.ms === undefined ? "(no Retry-After)" : `${Math.round(throttle.ms / 1000)} s`}`;
    }
    return e;
  };

  // One handshake: a fresh client per attempt, raced against a deadline (the SDK times out only `initialize`, so a
  // server that stalls on `notifications/initialized` would hang), then the chain check. Failures leave nothing open.
  // `retries` is the client's setting for the first connect and 0 for a reconnect, which the call's own retry repeats.
  const open = (retries: number) =>
    withRetry(
      async (): Promise<Conn> => {
        await slots(handshakeCost);
        if (closed) throw new ClientClosedError();
        const { transport, stderr } = makeTransport();
        const client = new Client(CLIENT_INFO);
        const c = { client, transport };
        handshaking.add(c);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new McpError(ErrorCode.RequestTimeout, `connecting to ${endpoint} timed out after ${ms} ms`)), ms);
        });
        try {
          await Promise.race([client.connect(transport, { timeout: ms }), deadline]);
          const res = await Promise.race([client.callTool({ name: "get_chain_info", arguments: {} }, undefined, { timeout: ms }), deadline]);
          const info = parseToolResult("get_chain_info", res) as Partial<ChainToolResults["get_chain_info"]> | null;
          if (info?.chainId !== expected) {
            throw new Error(`${endpoint} serves chain ${info?.chainId ?? "unknown"}, but ${network} is chain ${expected}: refusing to read from it`);
          }
          // A local server that exits (crash, kill) drops the connection; the next attempt starts a new one.
          client.onclose = () => void (conn === c && (conn = undefined));
          return c;
        } catch (e) {
          await shut(c);
          if (closed) throw new ClientClosedError();
          const tail = stderr();
          if (tail && e instanceof Error) e.message = `${e.message} — local server stderr: ${tail.slice(-500)}`;
          throw explain(e);
        } finally {
          clearTimeout(timer);
          handshaking.delete(c);
        }
      },
      { retries, sleep },
      (e) => !closed && retryable(e),
    );

  async function current(retries: number): Promise<Conn> {
    if (closed) throw new ClientClosedError();
    if (conn) return conn;
    opening ??= open(retries)
      .then((c) => {
        if (closed) {
          void shut(c);
          throw new ClientClosedError();
        }
        return (conn = c);
      })
      .finally(() => (opening = undefined));
    return opening;
  }

  /** Run `fn` on the live session with the retry policy: a forgotten session is dropped, so the next attempt reconnects. */
  function withSession<T>(fn: (c: Conn) => Promise<T>, retries: number): Promise<T> {
    return withRetry(
      async () => {
        await slots(1); // first the slot, then the connection: a session dropped while waiting is not used
        const c = await current(0);
        try {
          return await fn(c);
        } catch (e) {
          if (closed) throw new ClientClosedError();
          if (sessionGone(e) && conn === c) {
            conn = undefined;
            void shut(c);
          }
          throw explain(e);
        }
      },
      { retries, sleep },
      (e) => !closed && retryable(e),
    );
  }

  async function call(name: string, args: Record<string, unknown> = {}, o: CallOptions = {}): Promise<unknown> {
    if (name === "send_raw_transaction" && !broadcast) {
      throw new Error('this Chain MCP client was opened without { broadcast: true }, so it never sends a transaction');
    }
    // A broadcast is never resent from here: the signer knows the hash and reconciles an unclear failure itself.
    const retries = name === "send_raw_transaction" ? 0 : (o.retries ?? opts.retries ?? 2);
    return withSession(async (c) => parseToolResult(name, await c.client.callTool({ name, arguments: args }, undefined, { timeout: o.timeoutMs ?? ms })), retries);
  }

  const first = await current(opts.retries ?? 2);
  return {
    network,
    chainId: expected,
    get server() {
      return (conn ?? first).client.getServerVersion();
    },
    endpoint,
    broadcast,
    get perMinute() {
      return limiter.perMinute;
    },
    call: call as ChainMcp["call"],
    listTools: () => withSession(async (c) => (await c.client.listTools(undefined, { timeout: ms })).tools, opts.retries ?? 2),
    async close() {
      closed = true;
      stop.abort();
      for (const h of handshaking) void shut(h); // a handshake in flight ends now, not at its deadline
      const c = conn ?? (await opening?.catch(() => undefined));
      conn = undefined;
      if (c) await shut(c);
    },
  };
}

/** The server's inclusive cap on one get_logs block span. */
export const MAX_LOG_WINDOW = 1000;

export interface LogQuery {
  address?: Hex | Hex[];
  topics?: (Hex | Hex[] | null)[];
  fromBlock: bigint;
  /** Pin it to a number so the range cannot move while it is read. */
  toBlock: bigint;
  /** Blocks per get_logs call, 1–1000 (default 1000). */
  window?: number;
}

/**
 * Logs over any block range: one get_logs call per window of at most 1000 blocks, returned in chain order (block, then
 * log index). Mainnet makes about 1.1 blocks/s, so a day is ~95 calls; the client's rate limit paces them.
 */
export async function getLogsRange(call: ChainMcp["call"], q: LogQuery): Promise<RpcLog[]> {
  const window = BigInt(q.window ?? MAX_LOG_WINDOW);
  if (window < 1n || window > BigInt(MAX_LOG_WINDOW)) throw new RangeError(`window must be 1..${MAX_LOG_WINDOW} blocks`);
  if (q.fromBlock < 0n || q.toBlock < q.fromBlock) throw new RangeError(`bad block range ${q.fromBlock}..${q.toBlock}`);
  const logs: RpcLog[] = [];
  for (let from = q.fromBlock; from <= q.toBlock; from += window) {
    const to = from + window - 1n < q.toBlock ? from + window - 1n : q.toBlock;
    const page = await call("get_logs", {
      ...(q.address ? { address: q.address } : {}),
      ...(q.topics ? { topics: q.topics } : {}),
      fromBlock: from.toString(),
      toBlock: to.toString(),
    });
    if (!Array.isArray(page)) throw new ChainToolError("get_logs", "reply is not an array");
    logs.push(...page);
  }
  return logs.sort(compareLogs);
}

const position = (v: Hex | null | undefined) => (v == null ? -1n : BigInt(v));

function compareLogs(a: RpcLog, b: RpcLog): number {
  const d = position(a.blockNumber) - position(b.blockNumber) || position(a.logIndex) - position(b.logIndex);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** A log's place in the chain, `block:logIndex`: a cursor and de-duplication key for monitors. */
export function logKey(log: Pick<RpcLog, "blockNumber" | "logIndex">): string {
  return `${position(log.blockNumber)}:${position(log.logIndex)}`;
}
