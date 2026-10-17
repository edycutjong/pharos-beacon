import { readFileSync } from "node:fs";
import { setTimeout as sleepFor } from "node:timers/promises";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

// Shared by the Chain MCP and Docs MCP clients: client identity, retry policy, error text. The rate limiter and the
// throttle-aware fetch are used by the Chain MCP client, whose hosted server enforces a per-IP limit.

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
/** How both MCP clients introduce themselves in `initialize`. */
export const CLIENT_INFO = { name: "beacon", version: pkg.version };

/** Sleep `ms`; with a signal, an abort ends the wait early and clears its timer (rejects with an AbortError). */
export const wait = (ms: number, signal?: AbortSignal): Promise<void> => sleepFor(ms, undefined, { signal });

/** A tool that answered with isError: true. The server reported it on purpose, so it is never retried. */
export class ToolError extends Error {
  override name = "ToolError";
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`${tool}: ${message}`);
  }
}

// 520-524 are Cloudflare's "origin unreachable / timed out" family; docs.pharos.xyz sits behind Cloudflare.
const TRANSIENT_HTTP = [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524];

/**
 * Worth retrying: a request timeout, a throttling/5xx response, or a dropped connection. Tool errors never are.
 * `timeouts: false` leaves request timeouts out, for calls that are slow rather than failing (askQuestion).
 */
export function isTransient(e: unknown, opts: { timeouts?: boolean } = {}): boolean {
  if (e instanceof StreamableHTTPError) return e.code !== undefined && TRANSIENT_HTTP.includes(e.code);
  if (e instanceof McpError) return e.code === ErrorCode.RequestTimeout && (opts.timeouts ?? true);
  if (e instanceof ToolError) return false;
  if ((e as { cause?: { code?: string } } | undefined)?.cause?.code === "ENOTFOUND") return false; // a wrong host name will not heal
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test((e as Error | undefined)?.message ?? "");
}

/** One short line for logs and CLI errors: the message cut to 300 chars (HTTP failures can embed a whole HTML page) plus the network cause code. */
export function describeError(e: unknown): string {
  const err = e as (Error & { cause?: { code?: string; message?: string } }) | undefined;
  let msg = String(err?.message ?? e).replace(/\s+/g, " ").trim();
  if (msg.length > 300) msg = `${msg.slice(0, 300)}…`;
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause && !msg.includes(String(cause)) ? `${msg} (${cause})` : msg;
}

export interface RetryOptions {
  /** Extra attempts after a transient failure (default 2: three tries, waiting 0.5 s then 1.5 s). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** A wait other than the default backoff for this failure (e.g. what Retry-After asked for); undefined keeps the backoff. */
  delayMs?: (attempt: number, e: unknown) => number | undefined;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions, transient: (e: unknown) => boolean = isTransient): Promise<T> {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? wait;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !transient(e)) throw e;
      await sleep(opts.delayMs?.(attempt, e) ?? 500 * 3 ** attempt);
    }
  }
}

/**
 * A URL path with every segment that could be a credential (longer than 16 characters, or not word-like) shown as "…".
 * An address or a 32-byte hash (0x + 40 or 64 hex digits) is kept: it is public on-chain evidence, e.g. an explorer link.
 */
export function safePath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => ((seg.length <= 16 && /^[A-Za-z0-9._~-]*$/.test(seg)) || /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(seg) ? seg : "…"))
    .join("/");
}

/**
 * The endpoint without userinfo, query string or key-like path segments (some RPC providers put the API key in the
 * path), so a token in an endpoint URL never reaches a log or a proof file. `https://mcp.pharos.xyz/mcp` stays whole.
 */
export function endpointLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${safePath(u.pathname)}`;
  } catch {
    return "the MCP endpoint";
  }
}

/**
 * Client-side request budget: at most `perMinute` requests in any 60 s, callers served in order. The hosted Chain MCP
 * allows 120 per minute per IP in a fixed window, so staying under it beats waiting out a 429. `perMinute <= 0`
 * disables the budget (a pause still applies). The budget is per process: two processes on one IP share the server's.
 */
export class RateLimiter {
  private readonly stamps: number[] = [];
  private tail: Promise<void> = Promise.resolve();
  private pausedUntil = 0;

  constructor(
    private budget: number,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = wait,
    private readonly now: () => number = Date.now,
  ) {}

  get perMinute(): number {
    return this.budget;
  }

  /** Lower the budget (a stricter caller wins); never raises it. */
  tighten(perMinute: number): void {
    if (perMinute > 0 && (this.budget <= 0 || perMinute < this.budget)) this.budget = perMinute;
  }

  /** Hold every caller for `ms` from now: the server asked for a pause (Retry-After). */
  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  /** Record `n` requests that were (or will be) sent without waiting, e.g. a DELETE on close. */
  note(n = 1): void {
    if (this.budget > 0) for (let i = 0; i < n; i++) this.stamps.push(this.now());
  }

  /**
   * Wait for `n` request slots. A take larger than the whole budget waits for an empty window. An abort rejects the
   * wait at once, also while it is queued behind another caller's.
   */
  take(n = 1, signal?: AbortSignal): Promise<void> {
    const turn = this.tail.then(async () => {
      for (;;) {
        signal?.throwIfAborted();
        const t = this.now();
        if (t < this.pausedUntil) {
          await this.sleep(this.pausedUntil - t, signal);
          continue;
        }
        if (this.budget <= 0) return;
        while (this.stamps.length && t - this.stamps[0] >= 60_000) this.stamps.shift();
        const over = this.stamps.length + n - this.budget;
        if (over <= 0 || this.stamps.length === 0) {
          for (let i = 0; i < n; i++) this.stamps.push(t);
          return;
        }
        await this.sleep(this.stamps[Math.min(over, this.stamps.length) - 1] + 60_000 - t, signal);
      }
    });
    this.tail = turn.catch(() => {});
    return signal ? untilAborted(turn, signal) : turn;
  }
}

/** `p`, or a rejection as soon as `signal` aborts, whichever comes first (a later rejection of `p` is then ignored). */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e: unknown) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

const limiters = new Map<string, RateLimiter>();
/** One limiter per endpoint per process, so every client of one server shares one budget; the stricter budget wins. */
export function limiterFor(key: string, perMinute: number): RateLimiter {
  const l = limiters.get(key);
  if (l) {
    l.tighten(perMinute);
    return l;
  }
  const fresh = new RateLimiter(perMinute);
  limiters.set(key, fresh);
  return fresh;
}

/** Seconds or an HTTP date, as sent in Retry-After; undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * A fetch for the SDK's HTTP transport that reports `429 Too Many Requests` and `503` (the hosted server's
 * session-capacity reply) with the wait the server asked for, then hands the response back unchanged. The SDK turns it
 * into an error and the caller's retry does the waiting, so a wait never runs past a request's own timeout and nothing
 * is resent after a caller has given up.
 */
export function throttleAwareFetch(onThrottle: (status: number, retryAfterMs: number | undefined) => void, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    if (res.status === 429 || res.status === 503) onThrottle(res.status, retryAfterMs(res.headers.get("retry-after")));
    return res;
  };
}

/** Refuse an endpoint URL that carries user:password@: fetch would echo it, credentials included, in its error text. */
export function rejectUserinfo(url: URL, what: string): void {
  if (url.username || url.password) throw new Error(`${what} must not carry credentials (user:password@)`);
}
