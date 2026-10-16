import { readFileSync } from "node:fs";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

// Shared by the Chain MCP and Docs MCP clients: client identity, retry policy, error text, request pacing.

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
/** How both MCP clients introduce themselves in `initialize`. */
export const CLIENT_INFO = { name: "beacon", version: pkg.version };

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions, transient: (e: unknown) => boolean = isTransient): Promise<T> {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? wait;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !transient(e)) throw e;
      await sleep(500 * 3 ** attempt);
    }
  }
}

/** The endpoint without userinfo or query string, so a token placed in an endpoint URL never reaches a log or a proof file. */
export function endpointLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "the MCP endpoint";
  }
}

/**
 * Client-side request budget: at most `perMinute` requests in any 60 s, callers served in order. The hosted Chain MCP
 * allows 120 per minute per IP in a fixed window, so staying under it beats waiting out a 429. `perMinute <= 0` disables.
 */
export class RateLimiter {
  private readonly stamps: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly perMinute: number,
    private readonly sleep: (ms: number) => Promise<void> = wait,
    private readonly now: () => number = Date.now,
  ) {}

  take(): Promise<void> {
    if (this.perMinute <= 0) return Promise.resolve();
    const turn = this.tail.then(async () => {
      for (;;) {
        const t = this.now();
        while (this.stamps.length && t - this.stamps[0] >= 60_000) this.stamps.shift();
        if (this.stamps.length < this.perMinute) {
          this.stamps.push(t);
          return;
        }
        await this.sleep(this.stamps[0] + 60_000 - t);
      }
    });
    this.tail = turn.catch(() => {});
    return turn;
  }
}

const limiters = new Map<string, RateLimiter>();
/** One limiter per endpoint per process, so two clients to the same server share one budget. */
export function limiterFor(key: string, perMinute: number): RateLimiter {
  let l = limiters.get(key);
  if (!l || l.perMinute !== perMinute) limiters.set(key, (l = new RateLimiter(perMinute)));
  return l;
}

/** Seconds or an HTTP date, as sent in Retry-After; undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function sleepUnlessAborted(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => (signal.removeEventListener("abort", done), resolve());
    signal.addEventListener("abort", done, { once: true });
    void sleep(ms).then(done);
  });
}

export interface PatientFetchOptions {
  /** Resends after a 429 or 503 (default 3). */
  attempts?: number;
  /** Longest single wait honoured (default 65 s: one full fixed window plus slack); a longer Retry-After is returned as is. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, for logs. */
  onWait?: (ms: number, status: number) => void;
}

/**
 * A fetch for the SDK's HTTP transport that waits out `429 Too Many Requests` and `503` (the hosted server's
 * session-capacity reply), honouring Retry-After, then resends the same request. Both are refused before the server
 * handles the request, so the resend is safe. POST only: a DELETE on close is never held up.
 */
export function patientFetch(opts: PatientFetchOptions = {}, base: typeof fetch = fetch): typeof fetch {
  const attempts = opts.attempts ?? 3;
  const maxWaitMs = opts.maxWaitMs ?? 65_000;
  const sleep = opts.sleep ?? wait;
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const res = await base(input, init);
      if ((res.status !== 429 && res.status !== 503) || (init?.method ?? "GET").toUpperCase() !== "POST" || attempt >= attempts) return res;
      const ms = retryAfterMs(res.headers.get("retry-after")) ?? 1000 * 2 ** attempt;
      if (ms > maxWaitMs || init?.signal?.aborted) return res;
      await res.body?.cancel().catch(() => {});
      opts.onWait?.(ms, res.status);
      await sleepUnlessAborted(ms, sleep, init?.signal);
    }
  };
}
