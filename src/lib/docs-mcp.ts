import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

// Developer Docs MCP: the hosted GitBook server for docs.pharos.xyz. Keyless, read-only, Streamable HTTP, stateless.
// Override the endpoint with the PHAROS_DOCS_MCP_URL environment variable (a shell variable, not read from .env).
// Tools (tools/list, server "docs.pharos.xyz MCP Server" 0.27.2): searchDocumentation, getPage, askQuestion, sendFeedback.
// sendFeedback is deliberately not wrapped: it posts to the docs maintainers, so only a human decides to call it.
export const DOCS_MCP_URL = process.env.PHAROS_DOCS_MCP_URL || "https://docs.pharos.xyz/~gitbook/mcp";
export const DOCS_ORIGIN = "https://docs.pharos.xyz";
const DOCS_HOST = "docs.pharos.xyz";

// Per-call budgets in ms. askQuestion writes an answer with an LLM and can take tens of seconds, so it gets a longer budget.
const TIMEOUT_MS = 30_000;
const ASK_TIMEOUT_MS = 90_000;

export interface DocHit {
  rank: number;
  title: string;
  url: string;
  /** Empty when the server returned the hit without a Content line. */
  content: string;
}

export interface DocsAnswer {
  /** The full askQuestion reply, markdown. */
  text: string;
  /** The reply without its trailing "# Sources" list. */
  answer: string;
  sources: { title: string; url: string }[];
}

export interface DocsToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** The slice of the SDK Client the helpers use, so a test can pass a plain object. */
export type DocsClient = Pick<Client, "callTool" | "listTools">;

export interface DocsOptions {
  /** Timeout in ms for each request, replacing the default (30 000; 90 000 for askQuestion). */
  timeoutMs?: number;
  /** Extra attempts after a transient failure (default 2: three tries, waiting 0.5 s then 1.5 s). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The server answered with isError: true (for example "Page not found"). Never retried. */
export class DocsToolError extends Error {
  override name = "DocsToolError";
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`${tool}: ${message}`);
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// 520-524 are Cloudflare's "origin unreachable / timed out" family; docs.pharos.xyz sits behind Cloudflare.
const TRANSIENT_HTTP = [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524];

/**
 * Worth retrying: a request timeout, a throttling/5xx response, or a dropped connection. Tool errors never are.
 * `timeouts: false` leaves request timeouts out, for calls that are slow rather than failing (askQuestion).
 */
export function isTransient(e: unknown, opts: { timeouts?: boolean } = {}): boolean {
  if (e instanceof StreamableHTTPError) return e.code !== undefined && TRANSIENT_HTTP.includes(e.code);
  if (e instanceof McpError) return e.code === ErrorCode.RequestTimeout && (opts.timeouts ?? true);
  if (e instanceof DocsToolError) return false;
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

async function withRetry<T>(fn: () => Promise<T>, opts: DocsOptions, transient: (e: unknown) => boolean = isTransient): Promise<T> {
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

/** The endpoint without userinfo or query string, so a token placed in PHAROS_DOCS_MCP_URL never reaches a log. */
function endpointLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "the Docs MCP endpoint";
  }
}

/**
 * Connect to the Developer Docs MCP, with a fresh client per attempt so a failed attempt leaves nothing open.
 * Always `await client.close()` when done: a timed-out request stays open on the wire until then.
 */
export async function docsMcp(url: string = DOCS_MCP_URL, opts: DocsOptions = {}): Promise<Client> {
  const ms = opts.timeoutMs ?? TIMEOUT_MS;
  return withRetry(async () => {
    const client = new Client({ name: "beacon", version: "0.2.0" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The SDK's connect timeout covers only the initialize request. A server that answers it and then stalls would
    // hang the handshake for minutes, so the whole handshake also races this deadline.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new McpError(ErrorCode.RequestTimeout, `connecting to ${endpointLabel(url)} timed out after ${ms} ms`)), ms);
    });
    try {
      await Promise.race([client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: ms }), deadline]);
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
    }
    return client;
  }, opts);
}

/** Call one Docs MCP tool and return its text blocks. Throws DocsToolError when the server reports isError. */
async function docsTool(client: DocsClient, name: string, args: Record<string, unknown>, opts: DocsOptions): Promise<string[]> {
  const slow = name === "askQuestion";
  const timeout = opts.timeoutMs ?? (slow ? ASK_TIMEOUT_MS : TIMEOUT_MS);
  return withRetry(
    async () => {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
      const blocks = (res.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "");
      if (res.isError) throw new DocsToolError(name, blocks.join("\n").trim() || "error");
      return blocks;
    },
    opts,
    (e) => isTransient(e, { timeouts: !slow }),
  );
}

export async function listDocTools(client: DocsClient, opts: DocsOptions = {}): Promise<DocsToolInfo[]> {
  const { tools } = await withRetry(() => client.listTools(undefined, { timeout: opts.timeoutMs ?? TIMEOUT_MS }), opts);
  return tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
}

// searchDocumentation returns one text block per hit, best first: "Title: …\nLink: …" and, for most hits, "\nContent: …"
// (content may span lines). Some hits carry no Content line at all, and the same page can have one for one query only.
const HIT = /^Title: (.*)\r?\nLink: (\S+)(?:\r?\nContent:[ \t]*([\s\S]*))?\s*$/;

/** Parse searchDocumentation blocks into ranked hits. A block without Title and Link lines throws, so format drift is loud. */
export function parseSearchBlocks(blocks: string[]): DocHit[] {
  return blocks.map((block, i) => {
    const m = HIT.exec(block);
    if (!m) throw new Error(`searchDocumentation block ${i + 1} has no "Title:" and "Link:" lines: ${JSON.stringify(block.slice(0, 80))}`);
    return { rank: i + 1, title: m[1].trim(), url: m[2], content: (m[3] ?? "").trim() };
  });
}

/** Ranked hits for a query, best first. An empty result is an empty array; a blank query throws. */
export async function searchDocs(client: DocsClient, query: string, opts: DocsOptions & { limit?: number } = {}): Promise<DocHit[]> {
  const q = query.trim();
  if (!q) throw new Error("searchDocs: query is empty");
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new RangeError("searchDocs: limit must be a positive integer");
  const hits = parseSearchBlocks(await docsTool(client, "searchDocumentation", { query: q }, opts));
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

/** Resolve a docs link (absolute, or root-relative like the ones inside answers). Any other host, scheme, port or userinfo is refused. */
export function docUrl(href: string): string {
  let u: URL;
  try {
    u = new URL(href, DOCS_ORIGIN);
  } catch {
    throw new Error(`not a URL: ${JSON.stringify(href.slice(0, 80))}`);
  }
  if (u.protocol !== "https:" || u.host !== DOCS_HOST || u.username || u.password) {
    throw new Error(`only ${DOCS_ORIGIN} pages can be fetched, got ${JSON.stringify(href.slice(0, 80))}`);
  }
  return `${DOCS_ORIGIN}${u.pathname}${u.search}${u.hash}`;
}

/** The full markdown of one docs page. */
export async function getDocPage(client: DocsClient, href: string, opts: DocsOptions = {}): Promise<string> {
  const markdown = (await docsTool(client, "getPage", { url: docUrl(href) }, opts)).join("\n").trim();
  if (!markdown) throw new Error(`getPage returned no content for ${href}`);
  return markdown;
}

const SOURCES_HEADING = /^#{1,6}[ \t]*Sources[ \t]*$/gim;
const SOURCE_ITEM = /^[ \t]*(?:[-*]|\d+\.)[ \t]+\[(.+)\]\((\S+)\)[ \t]*$/;
const MAX_SOURCE_LINE = 2_000; // SOURCE_ITEM backtracks badly on a huge single line, and no real source line is near this long

/** A synthesized answer with the pages it cites. `goal` tailors the answer to what the caller is trying to do. */
export async function askDocs(client: DocsClient, question: string, goal?: string, opts: DocsOptions = {}): Promise<DocsAnswer> {
  const q = question.trim();
  if (!q) throw new Error("askDocs: question is empty");
  const text = (await docsTool(client, "askQuestion", { question: q, ...(goal ? { goal } : {}) }, opts)).join("\n").trim();
  if (!text) throw new Error("askQuestion returned no content");

  // The reply ends with a "# Sources" list. Use the last such heading so one inside the answer body cannot cut it short.
  let cut = -1;
  for (const m of text.matchAll(SOURCES_HEADING)) cut = m.index;
  const sources: DocsAnswer["sources"] = [];
  if (cut >= 0) {
    for (const line of text.slice(cut).split(/\r?\n/).slice(1)) {
      const m = line.length <= MAX_SOURCE_LINE ? SOURCE_ITEM.exec(line) : null;
      if (!m) continue;
      try {
        const url = new URL(m[2], DOCS_ORIGIN);
        if (url.protocol === "https:") sources.push({ title: m[1], url: url.toString() }); // never javascript:, data:, file: or plain http
      } catch {
        // a malformed link in the list is skipped; the rest still count
      }
    }
  }
  return { text, answer: (cut >= 0 ? text.slice(0, cut) : text).trim(), sources };
}
