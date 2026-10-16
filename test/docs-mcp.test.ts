import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  askDocs,
  describeError,
  docsMcp,
  DocsToolError,
  docUrl,
  getDocPage,
  isTransient,
  listDocTools,
  parseSearchBlocks,
  searchDocs,
  type DocsClient,
} from "../src/lib/docs-mcp.js";
import { sleeps, startLocal } from "./helpers/local-mcp.js";

// Blocks recorded from the live server (2026-10-17). ATLANTIC and ZAN: searchDocumentation "Atlantic testnet RPC URL chain id";
// ZAN_BARE: the same ZAN page for the query "RPC", where the server sent no Content line at all.
const ATLANTIC =
  "Title: Atlantic Testnet\nLink: https://docs.pharos.xyz/getting-started/network/atlantic-testnet\nContent: RPC Public Endpoint\nhttps://atlantic.dplabs-internal.com\nWSS Public Endpoint\nwss://atlantic.dplabs-internal.com\nExplorer\nhttps://atlantic.pharosscan.xyz/\nChainID\n688689\nEnvironment\nAtlantic Testnet\nRatelimit\n500 times/5m\nMax Pending TXs (Addr)\n64\n\nFor the current node binary and Docker image versions, see Current Node Versions.";
const ZAN =
  "Title: ZAN RPC\nLink: https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan\nContent: After the API key is created, you can get the URLs that can be used for accessing Pharos Network. Search for Pharos in the Chain RPC section. Click Copy to the right of the HTTPS URL to quickly copy the URL.";
const ZAN_BARE = "Title: ZAN RPC\nLink: https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan";
// askQuestion reply shape (sources shortened).
const ASK =
  "Atlantic Testnet’s chain ID is **688689**. See [Atlantic Testnet](/getting-started/network/atlantic-testnet).\n\n# Sources\n\n- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)\n- [Node Management](https://docs.pharos.xyz/node-and-validator-guide/node-management)";

type Reply = { content: { type: string; text?: string }[]; isError?: boolean } | Error;
const text = (...blocks: string[]): Reply => ({ content: blocks.map((t) => ({ type: "text", text: t })) });
const toolError = (message: string): Reply => ({ content: [{ type: "text", text: message }], isError: true });

/** A stand-in for the SDK client: replies are consumed in order, every call is recorded. */
function fake(...replies: Reply[]) {
  const calls: { name: string; args: unknown; timeout?: number }[] = [];
  const client = {
    callTool: async (params: { name: string; arguments?: unknown }, _schema: unknown, options?: { timeout?: number }) => {
      calls.push({ name: params.name, args: params.arguments, timeout: options?.timeout });
      const r = replies.shift();
      if (!r) throw new Error("unexpected extra call");
      if (r instanceof Error) throw r;
      return r;
    },
    listTools: async () => ({
      tools: [
        { name: "searchDocumentation", description: "Search across the documentation", inputSchema: { type: "object" } },
        { name: "getPage", inputSchema: { type: "object" } },
      ],
    }),
  } as unknown as DocsClient;
  return { client, calls };
}


describe("parseSearchBlocks", () => {
  it("parses recorded blocks into ranked hits and keeps multi-line content", () => {
    const hits = parseSearchBlocks([ATLANTIC, ZAN]);
    expect(hits.map((h) => [h.rank, h.title, h.url])).toEqual([
      [1, "Atlantic Testnet", "https://docs.pharos.xyz/getting-started/network/atlantic-testnet"],
      [2, "ZAN RPC", "https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan"],
    ]);
    expect(hits[0].content).toContain("ChainID\n688689");
    expect(hits[1].content.startsWith("After the API key")).toBe(true);
  });

  it("accepts a hit with no Content line (the live server sends some)", () => {
    expect(parseSearchBlocks([ZAN_BARE])).toEqual([
      { rank: 1, title: "ZAN RPC", url: "https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan", content: "" },
    ]);
  });

  it("accepts a bare hit that ends in whitespace", () => {
    expect(parseSearchBlocks(["Title: ZAN RPC\nLink: https://docs.pharos.xyz/x\n"])[0]).toMatchObject({ title: "ZAN RPC", url: "https://docs.pharos.xyz/x", content: "" });
  });

  it("accepts CRLF line endings", () => {
    expect(parseSearchBlocks(["Title: A\r\nLink: https://docs.pharos.xyz/a\r\nContent: body"])[0]).toMatchObject({ title: "A", content: "body" });
  });

  it("throws on a block without Title and Link lines, naming the block", () => {
    expect(() => parseSearchBlocks([ATLANTIC, "Heading only, no link"])).toThrow(/block 2 has no "Title:" and "Link:" lines/);
  });
});

describe("searchDocs", () => {
  it("sends the trimmed query with a 30 s timeout and returns hits in order", async () => {
    const { client, calls } = fake(text(ATLANTIC, ZAN));
    const hits = await searchDocs(client, "  atlantic rpc ");
    expect(calls).toEqual([{ name: "searchDocumentation", args: { query: "atlantic rpc" }, timeout: 30_000 }]);
    expect(hits.map((h) => h.title)).toEqual(["Atlantic Testnet", "ZAN RPC"]);
  });

  it("returns every hit of a reply that mixes hits with and without Content", async () => {
    const { client } = fake(text(ATLANTIC, ZAN_BARE, ZAN));
    expect((await searchDocs(client, "rpc")).map((h) => h.content === "")).toEqual([false, true, false]);
  });

  it("honours limit and a custom timeout", async () => {
    const { client, calls } = fake(text(ATLANTIC, ZAN));
    expect((await searchDocs(client, "rpc", { limit: 1, timeoutMs: 5_000 })).map((h) => h.title)).toEqual(["Atlantic Testnet"]);
    expect(calls[0].timeout).toBe(5_000);
  });

  it("returns an empty array for zero blocks", async () => {
    const { client } = fake(text());
    expect(await searchDocs(client, "zzzz")).toEqual([]);
  });

  it("rejects a blank query and a bad limit without calling the server", async () => {
    const { client, calls } = fake();
    await expect(searchDocs(client, "   ")).rejects.toThrow(/query is empty/);
    await expect(searchDocs(client, "rpc", { limit: 0 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a server-side tool error as DocsToolError and does not retry it", async () => {
    const { client, calls } = fake(toolError("quota exceeded"));
    const err = await searchDocs(client, "rpc").catch((e) => e);
    expect(err).toBeInstanceOf(DocsToolError);
    expect(err.name).toBe("DocsToolError");
    expect(err.message).toBe("searchDocumentation: quota exceeded");
    expect(calls).toHaveLength(1);
  });

  it("retries a transient failure with backoff, then succeeds", async () => {
    const { client, calls } = fake(new StreamableHTTPError(503, "unavailable"), new TypeError("fetch failed"), text(ATLANTIC));
    const { waited, sleep } = sleeps();
    expect(await searchDocs(client, "rpc", { sleep })).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(waited).toEqual([500, 1500]);
  });

  it("retries a request timeout on a search", async () => {
    const { client, calls } = fake(new McpError(ErrorCode.RequestTimeout, "Request timed out"), text(ATLANTIC));
    expect(await searchDocs(client, "rpc", { sleep: async () => {} })).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("gives up after the retries and rethrows the last error", async () => {
    const down = () => new StreamableHTTPError(503, "unavailable");
    const { client, calls } = fake(down(), down(), down());
    const { waited, sleep } = sleeps();
    await expect(searchDocs(client, "rpc", { sleep })).rejects.toThrow(/Streamable HTTP error: unavailable/);
    expect(calls).toHaveLength(3);
    expect(waited).toEqual([500, 1500]);
  });

  it("does not retry a non-transient protocol error", async () => {
    const { client, calls } = fake(new McpError(ErrorCode.InvalidParams, "bad arguments"));
    await expect(searchDocs(client, "rpc", { sleep: async () => {} })).rejects.toThrow(/bad arguments/);
    expect(calls).toHaveLength(1);
  });

  it("fails loudly when the reply format drifts", async () => {
    const { client } = fake(text("some other format"));
    await expect(searchDocs(client, "rpc")).rejects.toThrow(/has no "Title:" and "Link:" lines/);
  });
});

describe("isTransient", () => {
  it("retries timeouts, throttling, 5xx (including Cloudflare 52x) and dropped connections", () => {
    expect(isTransient(new StreamableHTTPError(429, "slow down"))).toBe(true);
    expect(isTransient(new StreamableHTTPError(503, "down"))).toBe(true);
    expect(isTransient(new StreamableHTTPError(522, "connection timed out"))).toBe(true);
    expect(isTransient(new McpError(ErrorCode.RequestTimeout, "timed out"))).toBe(true);
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(new Error("read ECONNRESET"))).toBe(true);
  });

  it("retries a refused or reset connection but not an unknown host name", () => {
    const failed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
    expect(isTransient(failed("ECONNREFUSED"))).toBe(true);
    expect(isTransient(failed("ENOTFOUND"))).toBe(false);
  });

  it("can leave request timeouts out", () => {
    expect(isTransient(new McpError(ErrorCode.RequestTimeout, "timed out"), { timeouts: false })).toBe(false);
    expect(isTransient(new StreamableHTTPError(503, "down"), { timeouts: false })).toBe(true);
  });

  it("does not retry client errors, protocol errors or tool errors", () => {
    expect(isTransient(new StreamableHTTPError(404, "missing"))).toBe(false);
    expect(isTransient(new StreamableHTTPError(undefined, "unknown"))).toBe(false);
    expect(isTransient(new McpError(ErrorCode.InvalidParams, "bad"))).toBe(false);
    expect(isTransient(new Error("boom"))).toBe(false);
  });

  it("never retries a tool error, even when its text looks like a network failure", () => {
    expect(isTransient(new DocsToolError("getPage", "upstream fetch failed"))).toBe(false);
  });
});

describe("describeError", () => {
  it("keeps one short line: collapses whitespace and cuts a whole HTML page to 300 chars", () => {
    expect(describeError(new Error("line one\n\n   line two"))).toBe("line one line two");
    const long = describeError(new StreamableHTTPError(503, `<html>${"x".repeat(5_000)}</html>`));
    expect(long.length).toBeLessThanOrEqual(301);
    expect(long.endsWith("…")).toBe(true);
  });

  it("appends the network cause that 'fetch failed' hides", () => {
    expect(describeError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe("fetch failed (ENOTFOUND)");
    expect(describeError("boom")).toBe("boom");
  });
});

describe("docUrl / getDocPage", () => {
  it("accepts docs URLs and resolves root-relative links", () => {
    expect(docUrl("https://docs.pharos.xyz/getting-started/network/atlantic-testnet")).toBe("https://docs.pharos.xyz/getting-started/network/atlantic-testnet");
    expect(docUrl("/getting-started/network/atlantic-testnet?x=1#top")).toBe("https://docs.pharos.xyz/getting-started/network/atlantic-testnet?x=1#top");
    expect(docUrl("//docs.pharos.xyz/a")).toBe("https://docs.pharos.xyz/a");
    expect(docUrl("https://DOCS.PHAROS.XYZ:443/a")).toBe("https://docs.pharos.xyz/a");
  });

  it.each([
    ["another host", "https://evil.example/page"],
    ["a lookalike suffix", "https://docs.pharos.xyz.evil.example/a"],
    ["a trailing-dot host", "https://docs.pharos.xyz./a"],
    ["a subdomain", "https://x.docs.pharos.xyz/a"],
    ["a prefix lookalike", "https://evildocs.pharos.xyz/a"],
    ["a password-only userinfo", "https://:pw@docs.pharos.xyz/a"],
    ["our host inside the path", "https://evil.example/https://docs.pharos.xyz/a"],
    ["userinfo that names our host", "https://docs.pharos.xyz@evil.example/a"],
    ["userinfo on our host", "https://evil.example@docs.pharos.xyz/a"],
    ["a password on our host", "https://user:pw@docs.pharos.xyz/a"],
    ["another port", "https://docs.pharos.xyz:8443/a"],
    ["plain http", "http://docs.pharos.xyz/a"],
    ["a blob URL", "blob:https://docs.pharos.xyz/3b3a4c1e"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/plain,x"],
    ["file:", "file:///etc/passwd"],
    ["backslashes", "https:\\\\evil.example\\a"],
    ["a protocol-relative foreign host", "//evil.example/a"],
  ])("refuses %s", (_label, href) => {
    expect(() => docUrl(href)).toThrow(/only https:\/\/docs\.pharos\.xyz pages can be fetched/);
  });

  it("explains an unparsable URL", () => {
    expect(() => docUrl("https://")).toThrow(/not a URL/);
  });

  it("fetches a page by absolute or relative link", async () => {
    const { client, calls } = fake(text("# Atlantic Testnet\n\nChainID 688689"), text("# Atlantic Testnet"));
    expect(await getDocPage(client, "https://docs.pharos.xyz/getting-started/network/atlantic-testnet")).toContain("688689");
    await getDocPage(client, "/getting-started/network/atlantic-testnet");
    expect(calls.map((c) => c.args)).toEqual([
      { url: "https://docs.pharos.xyz/getting-started/network/atlantic-testnet" },
      { url: "https://docs.pharos.xyz/getting-started/network/atlantic-testnet" },
    ]);
  });

  it("does not call the server for a foreign host", async () => {
    const { client, calls } = fake();
    await expect(getDocPage(client, "https://evil.example/x")).rejects.toThrow(/only https:\/\/docs\.pharos\.xyz/);
    expect(calls).toHaveLength(0);
  });

  it("propagates 'Page not found' and rejects an empty page", async () => {
    const { client } = fake(toolError('Page not found: "https://docs.pharos.xyz/nope"'), text(""));
    await expect(getDocPage(client, "/nope")).rejects.toThrow(/getPage: Page not found/);
    await expect(getDocPage(client, "/empty")).rejects.toThrow(/no content/);
  });
});

describe("askDocs", () => {
  it("splits the answer from its cited sources and gives askQuestion a 90 s budget", async () => {
    const { client, calls } = fake(text(ASK));
    const r = await askDocs(client, " What is the Atlantic testnet chain id? ", "wire up a wallet");
    expect(calls[0]).toEqual({ name: "askQuestion", args: { question: "What is the Atlantic testnet chain id?", goal: "wire up a wallet" }, timeout: 90_000 });
    expect(r.answer).toBe("Atlantic Testnet’s chain ID is **688689**. See [Atlantic Testnet](/getting-started/network/atlantic-testnet).");
    expect(r.sources).toEqual([
      { title: "Atlantic Testnet", url: "https://docs.pharos.xyz/getting-started/network/atlantic-testnet" },
      { title: "Node Management", url: "https://docs.pharos.xyz/node-and-validator-guide/node-management" },
    ]);
    expect(r.text).toBe(ASK);
  });

  it("sends no goal when none is given, and tolerates a reply without sources", async () => {
    const { client, calls } = fake(text("Use the faucet."));
    const r = await askDocs(client, "how do I get PHRS?");
    expect(calls[0].args).toEqual({ question: "how do I get PHRS?" });
    expect(r).toEqual({ text: "Use the faucet.", answer: "Use the faucet.", sources: [] });
  });

  it("cuts at the LAST Sources heading, so one inside the answer body does not hide the list", async () => {
    const reply = "Intro.\n\n## Sources\nnot a list\n\nMore body.\n\n# Sources\n\n- [A](https://docs.pharos.xyz/a)\n";
    const r = await askDocs(fake(text(reply)).client, "q");
    expect(r.answer).toBe("Intro.\n\n## Sources\nnot a list\n\nMore body.");
    expect(r.sources).toEqual([{ title: "A", url: "https://docs.pharos.xyz/a" }]);
  });

  it("reads numbered items, relative links, brackets in titles and parentheses in URLs", async () => {
    const reply = "Answer.\n\n# Sources\n1. [One](/one)\n2. [Two [x]](https://docs.pharos.xyz/two_(b))\n* [Three](https://github.com/PharosNetwork/pharos-mcp)\nnot an item";
    const r = await askDocs(fake(text(reply)).client, "q");
    expect(r.sources).toEqual([
      { title: "One", url: "https://docs.pharos.xyz/one" },
      { title: "Two [x]", url: "https://docs.pharos.xyz/two_(b)" },
      { title: "Three", url: "https://github.com/PharosNetwork/pharos-mcp" },
    ]);
  });

  it("keeps https sources only: no javascript:, data:, file: or plain http links", async () => {
    const reply = "A.\n\n# Sources\n- [js](javascript:alert(1))\n- [plain](http://docs.pharos.xyz/a)\n- [file](file:///etc/passwd)\n- [data](data:text/plain,x)\n- [ok](https://docs.pharos.xyz/ok)";
    expect((await askDocs(fake(text(reply)).client, "q")).sources).toEqual([{ title: "ok", url: "https://docs.pharos.xyz/ok" }]);
  });

  it("is not slowed down by one enormous line in the Sources list", async () => {
    const reply = `A.\n\n# Sources\n- [${"](".repeat(50_000)}x\n- [ok](https://docs.pharos.xyz/ok)`;
    const t0 = performance.now();
    const r = await askDocs(fake(text(reply)).client, "q");
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(r.sources).toEqual([{ title: "ok", url: "https://docs.pharos.xyz/ok" }]);
  });

  it("does not retry an askQuestion timeout (it is slow, not failing) but does retry a transient HTTP error", async () => {
    const slow = fake(new McpError(ErrorCode.RequestTimeout, "Request timed out"));
    await expect(askDocs(slow.client, "q", undefined, { sleep: async () => {} })).rejects.toThrow(/timed out/);
    expect(slow.calls).toHaveLength(1);
    const flaky = fake(new StreamableHTTPError(503, "down"), text("Use the faucet."));
    expect((await askDocs(flaky.client, "q", undefined, { sleep: async () => {} })).answer).toBe("Use the faucet.");
    expect(flaky.calls).toHaveLength(2);
  });

  it("rejects a blank question", async () => {
    const { client, calls } = fake();
    await expect(askDocs(client, " ")).rejects.toThrow(/question is empty/);
    expect(calls).toHaveLength(0);
  });
});

describe("listDocTools", () => {
  it("maps tools/list to name, description and schema", async () => {
    const { client } = fake();
    expect(await listDocTools(client)).toEqual([
      { name: "searchDocumentation", description: "Search across the documentation", inputSchema: { type: "object" } },
      { name: "getPage", description: "", inputSchema: { type: "object" } },
    ]);
  });
});

// ---- through the real SDK client and transport, against a local stateless Streamable-HTTP MCP server ----

describe.each(["json", "sse"] as const)("docsMcp against a local MCP server (real SDK client and transport, %s replies)", (mode) => {
  it("connects, lists tools and searches end to end", async () => {
    const local = await startLocal(mode, { tool: () => ({ content: [{ type: "text", text: ATLANTIC }, { type: "text", text: ZAN_BARE }] }) });
    const client = await docsMcp(local.url);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "local-docs" });
      expect((await listDocTools(client)).map((t) => t.name)).toEqual(["searchDocumentation"]);
      const hits = await searchDocs(client, "rpc");
      expect(hits.map((h) => [h.title, h.content === ""])).toEqual([["Atlantic Testnet", false], ["ZAN RPC", true]]);
      expect(local.rpcs.find((r) => r.method === "tools/call")?.params).toMatchObject({ name: "searchDocumentation", arguments: { query: "rpc" } });
    } finally {
      await client.close();
    }
  });

  it("retries a 503 during the handshake with a fresh client", async () => {
    let failed = false;
    const local = await startLocal(mode, {
      intercept: (rpc, res) => {
        if (rpc.method !== "initialize" || failed) return false;
        failed = true;
        res.writeHead(503, { "content-type": "text/plain" }).end("busy");
        return true;
      },
    });
    const { waited, sleep } = sleeps();
    const client = await docsMcp(local.url, { sleep });
    await client.close();
    expect(local.rpcs.filter((r) => r.method === "initialize")).toHaveLength(2);
    expect(waited).toEqual([500]);
  });

  it("bounds a handshake that stalls after initialize by timeoutMs and leaves nothing open", async () => {
    const local = await startLocal(mode, { intercept: (rpc) => rpc.method === "notifications/initialized" }); // never answered
    const t0 = Date.now();
    const err = await docsMcp(local.url, { timeoutMs: 300, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(ErrorCode.RequestTimeout);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1_500);
    await vi.waitFor(() => expect(local.open.size).toBe(0), { timeout: 2_000 });
  });

  it("keeps a token in the endpoint URL out of the timeout message", async () => {
    const local = await startLocal(mode, { intercept: (rpc) => rpc.method === "notifications/initialized" });
    const err = await docsMcp(`${local.url}?token=SECRET`, { timeoutMs: 200, retries: 0 }).catch((e) => e);
    expect(err.message).toContain("/mcp timed out after 200 ms");
    expect(err.message).not.toContain("SECRET");
  });

  it("leaves no timer running after a successful connect and close", async () => {
    const local = await startLocal(mode, {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const client = await docsMcp(local.url, { timeoutMs: 60_000 });
      await client.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a malformed endpoint URL", async () => {
    const { waited, sleep } = sleeps();
    await expect(docsMcp("not a url", { sleep })).rejects.toThrow(/Invalid URL/);
    expect(waited).toEqual([]);
  });

  it("retries a 429 on a tool call", async () => {
    let throttled = false;
    const local = await startLocal(mode, {
      intercept: (rpc, res) => {
        if (rpc.method !== "tools/call" || throttled) return false;
        throttled = true;
        res.writeHead(429, { "content-type": "text/plain" }).end("slow down");
        return true;
      },
      tool: () => ({ content: [{ type: "text", text: ATLANTIC }] }),
    });
    const client = await docsMcp(local.url);
    try {
      expect(await searchDocs(client, "rpc", { sleep: async () => {} })).toHaveLength(1);
      expect(local.rpcs.filter((r) => r.method === "tools/call")).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("times out a stalled call: retried for a search, not retried for askQuestion", async () => {
    const local = await startLocal(mode, { intercept: (rpc) => rpc.method === "tools/call" }); // tool calls are never answered
    const client = await docsMcp(local.url);
    const calls = () => local.rpcs.filter((r) => r.method === "tools/call").length;
    try {
      await expect(askDocs(client, "why?", undefined, { timeoutMs: 200 })).rejects.toThrow(/timed out/i);
      expect(calls()).toBe(1);
      await expect(searchDocs(client, "x", { timeoutMs: 200, retries: 1, sleep: async () => {} })).rejects.toThrow(/timed out/i);
      expect(calls()).toBe(3); // the ask, then two search attempts
    } finally {
      await client.close();
    }
  });
});
