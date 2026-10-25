// Shared plumbing of the wave 4 demo endpoints (api/router.ts → tasks/<slug>/web.ts): one read-only Pharos mainnet connection through the
// hosted Chain MCP, the phase lamps, and the info/run handler. Nothing here signs or sends; the pages have no key.
import { chainMcp, type ChainMcp } from "../lib/mcp.js";
import { InputError, actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, type Emit } from "./live.js";

export type Call = ChainMcp["call"];
export interface Conn { call: Call; endpoint: string; close(): Promise<void> }
export interface Deps { connect: () => Promise<Conn> }
export const defaultDeps: Deps = {
  connect: async () => {
    const m = await chainMcp("pharos", { timeoutMs: 20_000 });
    return { call: m.call, endpoint: `hosted Chain MCP ${m.endpoint}`, close: () => m.close() };
  },
};

/** A bounded number from the query string, or the default; anything else is a 400 with the reason. */
export const numParam = (q: URLSearchParams, name: string, def: number, min: number, max: number): number => {
  const raw = (q.get(name) ?? "").trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new InputError(`${name} must be a number between ${min} and ${max}`);
  return n;
};

/** GET ?action=info → a small JSON; GET ?action=run&… → NDJSON from `run`, at most two at a time per instance. */
export function serve<P>(task: string, parse: (url: URL) => P, run: (p: P, emit: Emit, deps: Deps) => Promise<void>, info: Record<string, unknown>) {
  const gate = concurrencyGate(2);
  return (req: Request, deps: Deps = defaultDeps): Promise<Response> =>
    guard(async () => {
      const url = new URL(req.url);
      const action = actionOf(url, ["info", "run"] as const, "info");
      if (action === "info") return json({ task, reads: "hosted Chain MCP https://mcp.pharos.xyz/mcp (Pharos mainnet, read-only)", ...info, deploy: deployInfo() });
      const p = parse(url);
      if (!gate.take()) return busy();
      return ndjson((emit) => run(p, emit, deps), gate.release);
    });
}
