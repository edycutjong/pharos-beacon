import { envOr } from "./env.js"; // first: loads .env before anything reads the environment
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CLIENT_INFO, ToolError, endpointLabel, isTransient, rejectUserinfo, withRetry, type RetryOptions } from "./net.js";

// Retry policy and error text are shared with the Chain MCP client (src/lib/net.ts); re-exported for existing callers.
export { describeError, isTransient } from "./net.js";

// Developer Docs MCP: the hosted GitBook server for docs.pharos.xyz. Keyless, read-only, Streamable HTTP, stateless.
// Override the endpoint with PHAROS_DOCS_MCP_URL (shell, ~/.config/pharos/testnet.env or the repo .env; blank = default).
// Tools (tools/list, server "docs.pharos.xyz MCP Server" 0.27.2): searchDocumentation, getPage, askQuestion, sendFeedback.
// sendFeedback is deliberately not wrapped: it posts to the docs maintainers, so only a human decides to call it.
export const DOCS_MCP_URL = envOr("PHAROS_DOCS_MCP_URL", "https://docs.pharos.xyz/~gitbook/mcp");
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

export interface DocsOptions extends RetryOptions {
  /** Timeout in ms for each request, replacing the default (30 000; 90 000 for askQuestion). */
  timeoutMs?: number;
}

/** The server answered with isError: true (for example "Page not found"). Never retried. */
export class DocsToolError extends ToolError {
  override name = "DocsToolError";
}

/**
 * Connect to the Developer Docs MCP, with a fresh client per attempt so a failed attempt leaves nothing open.
 * Always `await client.close()` when done: a timed-out request stays open on the wire until then.
 */
export async function docsMcp(url: string = DOCS_MCP_URL, opts: DocsOptions = {}): Promise<Client> {
  const ms = opts.timeoutMs ?? TIMEOUT_MS;
  return withRetry(async () => {
    const client = new Client(CLIENT_INFO);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The SDK's connect timeout covers only the initialize request. A server that answers it and then stalls would
    // hang the handshake for minutes, so the whole handshake also races this deadline.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new McpError(ErrorCode.RequestTimeout, `connecting to ${endpointLabel(url)} timed out after ${ms} ms`)), ms);
    });
    try {
      const endpoint = new URL(url);
      rejectUserinfo(endpoint, "the Docs MCP URL");
      await Promise.race([client.connect(new StreamableHTTPClientTransport(endpoint), { timeout: ms }), deadline]);
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
