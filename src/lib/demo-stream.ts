// Small helpers shared by the read-only demo endpoints (api/<task>.ts → tasks/<task>/web.ts): JSON replies, an NDJSON
// stream the page reads line by line to light its Sequence strip, a one-run-at-a-time gate, and the deploy stamp.

export type Emit = (event: Record<string, unknown>) => void;

/** JSON with bigints as decimal strings. */
export const toJson = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(toJson(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

/** A 400 the page shows as is. */
export class InputError extends Error {
  override name = "InputError";
}

/**
 * Stream `work` as NDJSON: every emit() is one line; a thrown error becomes {"type":"error"}. `release` runs when the
 * work ends (the gate's slot), whether it finished, failed or the reader went away.
 */
export function ndjson(work: (emit: Emit, signal: AbortSignal) => Promise<void>, release: () => void = () => {}): Response {
  const enc = new TextEncoder();
  const stop = new AbortController();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (e) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(toJson(e) + "\n"));
        } catch {
          closed = true;
        }
      };
      try {
        await work(emit, stop.signal);
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message.split("\n")[0]!.slice(0, 400) : String(e) });
      } finally {
        release();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      closed = true;
      stop.abort();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

export interface Gate {
  /** 0 = the slot is taken (call release() when done); otherwise the ms to wait. */
  take(now?: number): number;
  release(): void;
}

/** One run at a time per server instance, at most one start per `gapMs` (best effort: Vercel may run several instances). */
export function gate(gapMs = 3_000): Gate {
  let last = -Infinity;
  let busy = false;
  return {
    take(now = Date.now()) {
      if (busy) return gapMs;
      const wait = last + gapMs - now;
      if (wait > 0) return wait;
      last = now;
      busy = true;
      return 0;
    },
    release() {
      busy = false;
    },
  };
}

export const busy = (ms: number) => json(429, { error: `Another run is in progress on this server. Try again in ${Math.ceil(ms / 1000)} s.` }, { "retry-after": String(Math.ceil(ms / 1000)) });

/** The commit and environment this deployment was built from (Vercel sets these; locally both are null/"local"). */
export function deployInfo() {
  return { commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null, env: process.env.VERCEL_ENV ?? "local" };
}

export const ms = (t0: number) => Date.now() - t0;
