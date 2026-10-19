// Live demo for the Doc-Search CLI (web/doc-search-cli, api/doc-search-cli.ts). Read-only, keyless.
//   GET /api/doc-search-cli?action=health
//   GET /api/doc-search-cli?action=ask&q=<question>        NDJSON
// It runs the CLI's own `search()` (askQuestion, the no-answer gate, searchDocumentation for the closest pages) and its
// `format()`, so the page prints exactly what `pharos-docs "<question>"` prints, with the same exit code.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { busyResponse, concurrency, deployInfo, InputError, json, ndjson, publicMessage, type Emit } from "../../src/web/demo.js";
import { docsMcp, DOCS_MCP_URL, type DocsClient } from "../../src/lib/docs-mcp.js";
import { EXIT_NOT_FOUND, format, search } from "./index.js";

export const MAX_QUESTION = 200;

/** The question from the query string: trimmed, control characters removed, 3–200 characters. */
export function parseQuestion(url: URL): string {
  const q = (url.searchParams.get("q") ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (q.length < 3) throw new InputError("ask a question of at least 3 characters");
  if (q.length > MAX_QUESTION) throw new InputError(`keep the question under ${MAX_QUESTION} characters`);
  return q;
}

/** A Docs client that reports every tool call (start and end), so the strip can light as the CLI works. */
export function observed(client: DocsClient, on: (e: { phase: "start" | "end"; tool: string; ms?: number; ok?: boolean; error?: string }) => void): DocsClient {
  return {
    listTools: client.listTools.bind(client),
    callTool: (async (params: Parameters<Client["callTool"]>[0], ...rest: unknown[]) => {
      const t0 = performance.now();
      on({ phase: "start", tool: params.name });
      try {
        const res = await (client.callTool as (...a: unknown[]) => Promise<{ isError?: boolean }>)(params, ...rest);
        on({ phase: "end", tool: params.name, ms: Math.round(performance.now() - t0), ok: res?.isError !== true });
        return res;
      } catch (e) {
        on({ phase: "end", tool: params.name, ms: Math.round(performance.now() - t0), ok: false, error: publicMessage(e) });
        throw e;
      }
    }) as DocsClient["callTool"],
  };
}

type Connect = () => Promise<DocsClient & { close(): Promise<void> }>;

export async function ask(question: string, emit: Emit, connect: Connect = () => docsMcp(DOCS_MCP_URL, { retries: 1 })): Promise<void> {
  emit({ type: "start", question, endpoint: DOCS_MCP_URL });
  let t = performance.now();
  const client = await connect().catch((e) => {
    emit({ type: "step", id: "connect", state: "failed", label: "no connection", ms: Math.round(performance.now() - t) });
    throw e;
  });
  try {
    emit({ type: "step", id: "connect", state: "ok", label: "Docs MCP", ms: Math.round(performance.now() - t) });
    let asked = false;
    let gateDone = false;
    const tools: { tool: string; ms: number; ok: boolean; error?: string }[] = [];
    const watched = observed(client, (e) => {
      if (e.phase === "start") {
        // searchDocumentation is only called when the answer did not pass the gate: light the gate as refused first.
        if (e.tool === "searchDocumentation" && asked && !gateDone) {
          gateDone = true;
          emit({ type: "step", id: "gate", state: "refused", label: "no good answer", ms: 0 });
        }
        return;
      }
      tools.push({ tool: e.tool, ms: e.ms!, ok: e.ok!, ...(e.error ? { error: e.error } : {}) });
      emit({ type: "call", tool: e.tool, ms: e.ms, ok: e.ok, ...(e.error ? { error: e.error } : {}) });
      if (e.tool === "askQuestion") {
        asked = true;
        emit({ type: "step", id: "ask", state: e.ok ? "ok" : "failed", label: e.ok ? "answer written" : "askQuestion failed", ms: e.ms });
      }
      if (e.tool === "searchDocumentation") emit({ type: "step", id: "closest", state: e.ok ? "ok" : "failed", label: e.ok ? "closest pages" : "search failed", ms: e.ms });
    });
    t = performance.now();
    const r = await search(watched, question);
    if (!asked) emit({ type: "step", id: "ask", state: "failed", label: "askQuestion failed", ms: Math.round(performance.now() - t) });
    if (!gateDone) emit({ type: "step", id: "gate", state: r.found ? "ok" : "refused", label: r.found ? `kept · ${r.sources.length} sources` : "no good answer", ms: 0 });
    if (r.found) emit({ type: "step", id: "closest", state: "skip", label: "not needed" });
    const exitCode = r.found ? 0 : EXIT_NOT_FOUND;
    emit({ type: "done", result: r, text: format(r), exitCode, tools, endpoint: DOCS_MCP_URL });
  } finally {
    await client.close().catch(() => {});
  }
}

// askQuestion runs a language model on the docs' side: keep the public page from queueing many at once.
const gate = concurrency(3);

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "health";
  try {
    if (req.method !== "GET") return json({ error: "use GET" }, 405);
    if (action === "health") return json({ status: "ok", task: "doc-search-cli", endpoint: DOCS_MCP_URL, maxQuestion: MAX_QUESTION, deploy: deployInfo() });
    if (action === "ask") {
      const q = parseQuestion(url);
      if (!gate.take()) return busyResponse("docs question");
      return ndjson((emit) => ask(q, emit), () => gate.release());
    }
    return json({ error: `unknown action ${JSON.stringify(action)}; use health or ask` }, 404);
  } catch (e) {
    if (e instanceof InputError) return json({ error: e.message }, 400);
    return json({ error: (e as Error).message }, 500);
  }
}
