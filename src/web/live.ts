// Shared plumbing for the read-only live demo endpoints (api/<task>.ts → tasks/<task>/web.ts): JSON and NDJSON responses,
// a per-instance concurrency gate, the deploy commit for the page footer, committed files read from GitHub at a pinned commit,
// and a step tracker that turns a run into the Sequence strip's lamp events.
import type { ChainMcp } from "../lib/mcp.js";

/** The commit the submitted proofs are pinned to; the pages and the endpoints read committed files from here. */
export const PINNED_COMMIT = "1004316";
export const REPO = "edycutjong/pharos-beacon";
export const rawUrl = (path: string) => `https://raw.githubusercontent.com/${REPO}/${PINNED_COMMIT}/${path}`;

export class InputError extends Error {
  override name = "InputError";
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export function deployInfo() {
  return { commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null, env: process.env.VERCEL_ENV ?? "local" };
}

export type StepState = "running" | "ok" | "refused" | "failed" | "skip";
export type LiveEvent =
  | { type: "start"; [k: string]: unknown }
  | { type: "step"; id: string; state: StepState; label?: string; ms?: number; detail?: unknown }
  | { type: "done"; totalMs: number; [k: string]: unknown }
  | { type: "error"; message: string; step?: string };
export type Emit = (e: LiveEvent) => void;

/** At most `max` runs at a time per server instance (best effort: Vercel may run several instances). */
export function concurrencyGate(max = 2) {
  let busy = 0;
  return {
    take: () => (busy < max ? (busy++, true) : false),
    release: () => void (busy = Math.max(0, busy - 1)),
  };
}

/** Stream a run as NDJSON. Errors become one {type:"error"} line; the gate slot is released at the end. */
export function ndjson(run: (emit: Emit) => Promise<void>, release?: () => void): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit: Emit = (e) => {
        if (open) controller.enqueue(enc.encode(`${JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`));
      };
      try {
        await run(emit);
      } catch (e) {
        emit({ type: "error", message: (e as Error).message ?? String(e) });
      } finally {
        open = false;
        release?.();
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

/** Explicit steps: begin(id) lights the lamp as running, end(id, …) settles it with the measured ms. */
export function stepper(emit: Emit) {
  const started = new Map<string, number>();
  let current: string | undefined;
  return {
    begin(id: string, label?: string) {
      started.set(id, Date.now());
      current = id;
      emit({ type: "step", id, state: "running", ...(label ? { label } : {}) });
    },
    end(id: string, state: Exclude<StepState, "running">, label: string, detail?: unknown) {
      const t = started.get(id);
      emit({ type: "step", id, state, label, ms: t === undefined ? 0 : Date.now() - t, ...(detail !== undefined ? { detail } : {}) });
      if (current === id) current = undefined;
    },
    get current() {
      return current;
    },
  };
}

type Call = ChainMcp["call"];

/**
 * Wrap a Chain-MCP-shaped `call` so the run's phases show on the Sequence strip without changing the task's code: `phaseOf`
 * names the phase of each tool call; when it changes, the previous phase's lamp settles with `labelOf(phase, calls)`.
 */
export function trackPhases(call: Call, emit: Emit, phaseOf: (tool: string, args: Record<string, unknown>, current: string | undefined) => string, labelOf: (phase: string, calls: number) => string) {
  const s = stepper(emit);
  let phase: string | undefined;
  let calls = 0;
  let total = 0;
  const seen = new Set<string>();
  const wrapped = (async (name: string, args: Record<string, unknown> = {}) => {
    const p = phaseOf(name, args, phase);
    if (p !== phase) {
      if (phase) s.end(phase, "ok", labelOf(phase, calls));
      phase = p;
      calls = 0;
      if (!seen.has(p)) seen.add(p);
      s.begin(p);
    }
    calls++;
    total++;
    return call(name as never, args);
  }) as Call;
  return {
    call: wrapped,
    /** Settle the open phase (ok, or failed with the error's message). */
    finish(error?: Error) {
      if (phase) s.end(phase, error ? "failed" : "ok", error ? error.message.slice(0, 160) : labelOf(phase, calls));
      phase = undefined;
    },
    seen: () => [...seen],
    total: () => total,
  };
}

const rawCache = new Map<string, { at: number; body: unknown }>();
/** A committed JSON file at the pinned commit, from GitHub raw (proof, plan and state files are not deployed). Cached 10 min. */
export async function pinnedJson<T = unknown>(path: string, f: typeof fetch = fetch): Promise<T> {
  if (!/^tasks\/[a-z0-9-]+\/[a-z0-9/_.-]+\.json$/.test(path)) throw new InputError(`not a committed task file: ${path}`);
  const hit = rawCache.get(path);
  if (hit && Date.now() - hit.at < 600_000) return hit.body as T;
  const res = await f(rawUrl(path), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`could not read ${path} at commit ${PINNED_COMMIT} from GitHub (HTTP ${res.status})`);
  const body = (await res.json()) as T;
  rawCache.set(path, { at: Date.now(), body });
  return body;
}

/** The `action` query parameter, checked against the list. */
export function actionOf<A extends string>(url: URL, allowed: readonly A[], fallback: A): A {
  const a = url.searchParams.get("action") ?? fallback;
  if (!(allowed as readonly string[]).includes(a)) throw new InputError(`action must be one of ${allowed.join(", ")}`);
  return a as A;
}

/** Route one request: an InputError is a 400 with the message, anything else a 500 that does not leak a stack. */
export async function guard(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InputError) return json({ error: e.message }, 400);
    return json({ error: (e as Error).message ?? "internal error" }, 500);
  }
}

export const busy = () => json({ error: "two live runs are already in progress on this server; try again in a few seconds", retryAfterSeconds: 5 }, 429, { "retry-after": "5" });
