import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Hex, RpcLog } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainToolError, chainMcp, getLogsRange, logKey, parseToolResult, stdioEnv, type ChainMcp } from "../src/lib/mcp.js";
import { RateLimiter } from "../src/lib/net.js";
import { sleeps, startLocal, type LocalOptions, type ToolReply } from "./helpers/local-mcp.js";

const json = (data: unknown): ToolReply => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const rpcError = (message: string, code?: number, data?: unknown): ToolReply => ({
  content: [{ type: "text", text: JSON.stringify({ error: { message, ...(code === undefined ? {} : { code }), ...(data === undefined ? {} : { data }) } }, null, 2) }],
  isError: true,
});
const CHAIN = { pharos: 1672, atlantic: 688689 };
/** A clock that only moves when someone sleeps on it. */
function clock() {
  let now = 1_000_000;
  const waited: number[] = [];
  return { waited, now: () => now, sleep: async (ms: number) => void (waited.push(ms), (now += ms)) };
}
const toolCalls = (rpcs: { method: string; params?: any }[], name: string) => rpcs.filter((r) => r.method === "tools/call" && r.params?.name === name);

/** A hosted-style (stateful) Chain MCP that serves `chainId` and answers other tools with `tool`. */
function chainServer(chainId = CHAIN.pharos, tool?: (name: string, args: any) => ToolReply, intercept?: LocalOptions["intercept"]) {
  return startLocal("sse", {
    sessions: true,
    serverInfo: { name: "pharos-mcp-server", version: "0.1.0" },
    tools: [{ name: "get_chain_info" }, { name: "get_block_number" }],
    intercept,
    tool: (name, args) => (name === "get_chain_info" ? json({ chainId, chainIdMatches: true }) : (tool?.(name, args) ?? json({ blockNumber: "42" }))),
  });
}

describe("parseToolResult", () => {
  it("parses the JSON text block, including a JSON null (an unmined receipt)", () => {
    expect(parseToolResult("get_block_number", json({ blockNumber: "7" }))).toEqual({ blockNumber: "7" });
    expect(parseToolResult("get_transaction_receipt", { content: [{ type: "text", text: "null" }] })).toBeNull();
  });

  it("turns the server's error JSON into a ChainToolError with code and data (a revert is code 3)", () => {
    const e = (() => {
      try {
        parseToolResult("eth_call", rpcError("execution reverted: ", 3, "0x08c379a0"));
      } catch (err) {
        return err as ChainToolError;
      }
    })()!;
    expect(e).toBeInstanceOf(ChainToolError);
    expect(e).toMatchObject({ tool: "eth_call", reason: "execution reverted:", code: 3, data: "0x08c379a0" });
    expect(e.message).toBe("eth_call: execution reverted: (code 3)");
  });

  it("keeps a plain-text tool error as one short line", () => {
    expect(() => parseToolResult("get_logs", { content: [{ type: "text", text: "MCP error -32602:\n  Invalid arguments" }], isError: true })).toThrow(
      /^get_logs: MCP error -32602: Invalid arguments$/,
    );
  });

  it("rejects a reply without text and a reply that is not JSON, instead of returning it as data", () => {
    expect(() => parseToolResult("get_balance", { content: [] })).toThrow(/no text content/);
    expect(() => parseToolResult("get_balance", { toolResult: {} })).toThrow(/no text content/);
    expect(() => parseToolResult("get_balance", null)).toThrow(/no text content/);
    expect(() => parseToolResult("get_balance", { content: [{ type: "text", text: "<html>" }] })).toThrow(/not JSON: "<html>"/);
  });
});

describe("getLogsRange", () => {
  const log = (block: number, index: number) => ({ blockNumber: `0x${block.toString(16)}`, logIndex: `0x${index.toString(16)}` }) as RpcLog;

  it("walks the range in windows of at most 1000 blocks and returns logs in chain order", async () => {
    const calls: Record<string, unknown>[] = [];
    const call = (async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return args.fromBlock === "0" ? [log(5, 1), log(2, 0)] : args.fromBlock === "1000" ? [log(1500, 0)] : [log(2400, 3), log(2400, 1)];
    }) as unknown as ChainMcp["call"];
    const logs = await getLogsRange(call, { address: "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0", topics: ["0xdd"], fromBlock: 0n, toBlock: 2_499n });
    expect(calls.map((a) => [a.fromBlock, a.toBlock])).toEqual([["0", "999"], ["1000", "1999"], ["2000", "2499"]]);
    expect(calls[0]).toMatchObject({ address: "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0", topics: ["0xdd"] });
    expect(logs.map(logKey)).toEqual(["2:0", "5:1", "1500:0", "2400:1", "2400:3"]);
  });

  it("makes one call for a one-block range and honours a smaller window", async () => {
    const calls: unknown[] = [];
    const call = (async (_n: string, a: unknown) => (calls.push(a), [])) as unknown as ChainMcp["call"];
    await getLogsRange(call, { fromBlock: 7n, toBlock: 7n });
    await getLogsRange(call, { fromBlock: 0n, toBlock: 9n, window: 5 });
    expect(calls).toEqual([{ fromBlock: "7", toBlock: "7" }, { fromBlock: "0", toBlock: "4" }, { fromBlock: "5", toBlock: "9" }]);
  });

  it("rejects bad ranges and windows before calling the server, and a reply that is not a list", async () => {
    const call = (async () => ({ not: "an array" })) as unknown as ChainMcp["call"];
    await expect(getLogsRange(call, { fromBlock: 10n, toBlock: 9n })).rejects.toThrow(/bad block range/);
    await expect(getLogsRange(call, { fromBlock: -1n, toBlock: 9n })).rejects.toThrow(/bad block range/);
    await expect(getLogsRange(call, { fromBlock: 0n, toBlock: 9n, window: 1001 })).rejects.toThrow(/1\.\.1000/);
    await expect(getLogsRange(call, { fromBlock: 0n, toBlock: 9n })).rejects.toThrow(/not an array/);
  });
});

describe("chainMcp over HTTP (real SDK client and transport, hosted-style sessions)", () => {
  it("connects, checks the chain, calls a tool and ends the session on close", async () => {
    const local = await chainServer();
    const mcp = await chainMcp("pharos", { url: `${local.url}?token=SECRET`, perMinute: 0 }); // the label drops the query
    expect(mcp).toMatchObject({ network: "pharos", chainId: 1672, broadcast: false, endpoint: local.url, server: { name: "pharos-mcp-server" } });
    expect(await mcp.call("get_block_number")).toEqual({ blockNumber: "42" });
    expect((await mcp.listTools()).map((t) => t.name)).toEqual(["get_chain_info", "get_block_number"]);
    await mcp.close();
    expect(local.requests.filter((r) => r.method === "DELETE")).toEqual([{ method: "DELETE", session: "s1", status: 200 }]);
    expect(local.sessions.size).toBe(0);
    await expect(mcp.call("get_block_number")).rejects.toThrow(/closed/);
  });

  it("refuses an endpoint that serves another chain, without retrying, and leaves no session behind", async () => {
    const local = await chainServer(CHAIN.atlantic);
    const { waited, sleep } = sleeps();
    await expect(chainMcp("pharos", { url: local.url, perMinute: 0, sleep })).rejects.toThrow(/serves chain 688689, but pharos is chain 1672/);
    expect(local.rpcs.filter((r) => r.method === "initialize")).toHaveLength(1);
    expect(waited).toEqual([]);
    expect(local.sessions.size).toBe(0);
  });

  it("refuses a malformed URL, and a URL with credentials, without echoing either", async () => {
    await expect(chainMcp("pharos", { url: "https://user:SECRET@" })).rejects.toThrow(/^the Chain MCP URL \(PHAROS_MCP_URL or opts.url\) is not a valid URL$/);
    const err = await chainMcp("pharos", { url: "https://user:SECRET@mcp.example/mcp" }).catch((e) => e);
    expect(err.message).toMatch(/must not carry credentials/);
    expect(err.message).not.toContain("SECRET");
  });

  it("surfaces a tool error as ChainToolError and never retries it", async () => {
    const local = await chainServer(CHAIN.pharos, (name) => (name === "eth_call" ? rpcError("execution reverted: ", 3, "0x") : json({})));
    const mcp = await chainMcp("pharos", { url: local.url, perMinute: 0, sleep: async () => {} });
    try {
      await expect(mcp.call("eth_call", { transaction: { to: "0x00" } })).rejects.toMatchObject({ name: "ChainToolError", code: 3, data: "0x" });
      expect(toolCalls(local.rpcs, "eth_call")).toHaveLength(1);
    } finally {
      await mcp.close();
    }
  });

  it("retries a 5xx on a read tool", async () => {
    let failed = false;
    const local = await chainServer(CHAIN.pharos, () => json({ ok: true }), (rpc, res) => {
      if (rpc.params?.name !== "get_balance" || failed) return false;
      failed = true;
      res.writeHead(502, { "content-type": "text/plain" }).end("bad gateway");
      return true;
    });
    const { waited, sleep } = sleeps();
    const mcp = await chainMcp("pharos", { url: local.url, perMinute: 0, sleep });
    try {
      expect(await mcp.call("get_balance", { address: "0x00" })).toEqual({ ok: true });
      expect(waited).toEqual([500]);
      expect(toolCalls(local.rpcs, "get_balance")).toHaveLength(2);
    } finally {
      await mcp.close();
    }
  });

  it("never sends a transaction through a client opened without broadcast (every mainnet client)", async () => {
    const local = await chainServer();
    const mcp = await chainMcp("pharos", { url: local.url, perMinute: 0, broadcast: true }); // ignored off Atlantic
    try {
      expect(mcp.broadcast).toBe(false);
      await expect(mcp.call("send_raw_transaction", { rawTransaction: "0x02" })).rejects.toThrow(/without \{ broadcast: true \}/);
      expect(toolCalls(local.rpcs, "send_raw_transaction")).toHaveLength(0);
    } finally {
      await mcp.close();
    }
  });

  it("waits out a 429 for as long as Retry-After says (outside the request's own timeout), then asks again once", async () => {
    let throttled = false;
    const local = await chainServer(CHAIN.pharos, undefined, (rpc, res) => {
      if (rpc.params?.name !== "get_block_number" || throttled) return false;
      throttled = true;
      res.writeHead(429, { "retry-after": "7", "content-type": "application/json" }).end('{"error":"Too Many Requests"}');
      return true;
    });
    const c = clock();
    const mcp = await chainMcp("pharos", { url: local.url, limiter: new RateLimiter(0, c.sleep, c.now), sleep: c.sleep });
    try {
      expect(await mcp.call("get_block_number")).toEqual({ blockNumber: "42" });
      expect(c.waited).toEqual([500, 6_500]); // the retry backoff, then the rest of the 7 s pause in the limiter
      expect(toolCalls(local.rpcs, "get_block_number")).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 50));
      expect(toolCalls(local.rpcs, "get_block_number")).toHaveLength(2); // nothing resent after the caller got its answer
    } finally {
      await mcp.close();
    }
  });

  it("gives up at once on a 429 whose Retry-After is longer than one call should wait, and says so", async () => {
    const local = await chainServer(CHAIN.pharos, undefined, (rpc, res) => {
      if (rpc.params?.name !== "get_block_number") return false;
      res.writeHead(429, { "retry-after": "120", "content-type": "application/json" }).end('{"error":"Too Many Requests"}');
      return true;
    });
    const { waited, sleep } = sleeps();
    const mcp = await chainMcp("pharos", { url: local.url, perMinute: 0, sleep });
    try {
      const err = await mcp.call("get_block_number").catch((e) => e);
      expect(err).toBeInstanceOf(StreamableHTTPError);
      expect(err.message).toMatch(/the server asked to wait 120 s/);
      expect(waited).toEqual([]);
      expect(toolCalls(local.rpcs, "get_block_number")).toHaveLength(1);
    } finally {
      await mcp.close();
    }
  });

  it("waits out a 503 (session capacity) during the handshake, then connects", async () => {
    let busy = true;
    const local = await chainServer(CHAIN.pharos, undefined, (rpc, res) => {
      if (rpc.method !== "initialize" || !busy) return false;
      busy = false;
      res.writeHead(503, { "retry-after": "3", "content-type": "application/json" }).end('{"error":"Server at session capacity, try again shortly"}');
      return true;
    });
    const c = clock();
    const mcp = await chainMcp("pharos", { url: local.url, limiter: new RateLimiter(0, c.sleep, c.now), sleep: c.sleep });
    await mcp.close();
    expect(local.rpcs.filter((r) => r.method === "initialize")).toHaveLength(2);
    expect(c.waited).toEqual([500, 2_500]);
  });

  it("paces itself: a connect costs 4 requests, each call 1, and the call that would pass the budget waits", async () => {
    const local = await chainServer();
    const c = clock();
    const limiter = new RateLimiter(6, c.sleep, c.now);
    const mcp = await chainMcp("pharos", { url: local.url, limiter, sleep: c.sleep });
    try {
      expect(mcp.perMinute).toBe(6);
      await mcp.call("get_block_number");
      await mcp.call("get_block_number");
      expect(c.waited).toEqual([]);
      await mcp.call("get_block_number"); // 4 + 3 = 7 > 6: waits for the connect's slots to leave the window
      expect(c.waited).toEqual([60_000]);
      for (let i = 0; i < 5; i++) await mcp.listTools(); // listTools is paced too: 1 + 5 fills the window again
      expect(c.waited).toEqual([60_000]);
      await mcp.call("get_block_number");
      expect(c.waited).toEqual([60_000, 60_000]);
    } finally {
      await mcp.close();
    }
  });

  it("defaults to 100 requests per minute for the hosted endpoint, shared by every client of it", async () => {
    const local = await chainServer();
    const a = await chainMcp("pharos", { url: local.url });
    const b = await chainMcp("pharos", { url: local.url, perMinute: 50 });
    try {
      expect(b.perMinute).toBe(50);
      expect(a.perMinute).toBe(50); // one budget per endpoint: the stricter setting wins for both
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
    const other = await chainServer();
    const d = await chainMcp("pharos", { url: other.url });
    expect(d.perMinute).toBe(100);
    await d.close();
  });

  it("ends a wait at once when the client is closed, leaving no timer of its own behind", async () => {
    const local = await chainServer(CHAIN.pharos, undefined, (rpc, res) => {
      if (rpc.params?.name !== "get_block_number") return false;
      res.writeHead(429, { "retry-after": "30", "content-type": "application/json" }).end('{"error":"Too Many Requests"}');
      return true;
    });
    const mcp = await chainMcp("pharos", { url: local.url, perMinute: 0 });
    const t0 = Date.now();
    const pending = mcp.call("get_block_number").catch((e) => e);
    await new Promise((r) => setTimeout(r, 900)); // past the 0.5 s backoff: now waiting out the 30 s pause
    await mcp.close();
    const err = await pending;
    expect(err.message).toBe("the Chain MCP client is closed");
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it("reconnects once when the server has forgotten the session (eviction, deploy), and checks the chain again", async () => {
    const local = await chainServer();
    const mcp = await chainMcp("pharos", { url: local.url, perMinute: 0, sleep: async () => {} });
    try {
      local.sessions.clear();
      expect(await mcp.call("get_block_number")).toEqual({ blockNumber: "42" });
      expect(local.rpcs.filter((r) => r.method === "initialize")).toHaveLength(2);
      expect(toolCalls(local.rpcs, "get_chain_info")).toHaveLength(2);
    } finally {
      await mcp.close();
    }
    expect(local.requests.filter((r) => r.method === "DELETE").at(-1)).toMatchObject({ session: "s2", status: 200 });
  });

  it("lists tools again after the server forgot the session", async () => {
    const local = await chainServer();
    const mcp = await chainMcp("pharos", { url: local.url, perMinute: 0, sleep: async () => {} });
    try {
      local.sessions.clear();
      expect((await mcp.listTools()).map((t) => t.name)).toEqual(["get_chain_info", "get_block_number"]);
      expect(local.rpcs.filter((r) => r.method === "initialize")).toHaveLength(2);
    } finally {
      await mcp.close();
    }
  });

  it("bounds a stalled read by timeoutMs and retries it", async () => {
    const local = await chainServer(CHAIN.pharos, undefined, (rpc) => rpc.method === "tools/call" && rpc.params?.name !== "get_chain_info");
    const mcp = await chainMcp("pharos", { url: local.url, perMinute: 0, timeoutMs: 200, retries: 1, sleep: async () => {} });
    try {
      const err = await mcp.call("get_block_number").catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(ErrorCode.RequestTimeout);
      expect(toolCalls(local.rpcs, "get_block_number")).toHaveLength(2);
      await expect(mcp.call("get_block_number", {}, { retries: 0 })).rejects.toThrow(/timed out/i);
      expect(toolCalls(local.rpcs, "get_block_number")).toHaveLength(3); // a per-call retries: 0 is honoured
    } finally {
      await mcp.close();
    }
  });

  it("bounds a handshake that stalls after initialize, and leaves nothing open", async () => {
    const local = await chainServer(CHAIN.pharos, undefined, (rpc) => rpc.method === "notifications/initialized");
    const t0 = Date.now();
    const err = await chainMcp("pharos", { url: local.url, perMinute: 0, timeoutMs: 300, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toMatch(/connecting to .*\/mcp timed out after 300 ms/);
    expect(Date.now() - t0).toBeLessThan(1_500);
    await vi.waitFor(() => expect(local.open.size).toBe(0), { timeout: 2_000 });
  });

  it("leaves none of its own timers running after connect, a call and close", async () => {
    // Counts timers created from src/lib only: undici keeps its own keep-alive timers for pooled sockets.
    const local = await chainServer();
    const live = new Set<unknown>();
    const [set, clear] = [globalThis.setTimeout, globalThis.clearTimeout];
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
      const ours = /[\\/]src[\\/]lib[\\/]/.test(new Error().stack ?? "");
      const t = set(() => (live.delete(t), fn(...a)), ms);
      if (ours) live.add(t);
      return t;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((t: Parameters<typeof clearTimeout>[0]) => (live.delete(t), clear(t))) as typeof clearTimeout;
    try {
      const mcp = await chainMcp("pharos", { url: local.url, perMinute: 0 });
      await mcp.call("get_block_number");
      await mcp.close();
    } finally {
      [globalThis.setTimeout, globalThis.clearTimeout] = [set, clear];
    }
    expect(live.size).toBe(0);
  });
});

describe("chainMcp over stdio (Atlantic's local server)", () => {
  const helper = (f: string) => fileURLToPath(new URL(`./helpers/${f}`, import.meta.url));
  const saved = { bin: process.env.PHAROS_MCP_BIN, key: process.env.BEACON_TEST_SECRET };
  const counts = join(tmpdir(), `beacon-fake-chain-${process.pid}.json`);
  beforeEach(() => rmSync(counts, { force: true }));
  afterEach(() => {
    for (const [k, v] of [["PHAROS_MCP_BIN", saved.bin], ["BEACON_TEST_SECRET", saved.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("gives the child the safe defaults and PHAROS_* settings only: no key, nothing else from this process", async () => {
    process.env.PHAROS_MCP_BIN = helper("fake-chain-server.mjs");
    process.env.BEACON_TEST_SECRET = generatePrivateKey();
    const mcp = await chainMcp("atlantic", { perMinute: 0 });
    try {
      expect(mcp).toMatchObject({ network: "atlantic", chainId: 688689, broadcast: false, endpoint: "local stdio test/helpers/fake-chain-server.mjs" });
      expect(mcp.perMinute).toBe(0); // as asked; the default for the local server is 60 (checked below)
      const names = (await mcp.call("env_names")) as string[];
      expect(names).not.toContain("BEACON_TEST_SECRET");
      expect(names).not.toContain("PRIVATE_KEY");
      // macOS adds __CF_USER_TEXT_ENCODING to every process it starts; it does not come from this process.
      expect(names.filter((n) => !["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"].includes(n) && !n.startsWith("__CF_"))).toEqual(
        ["ENABLE_SEND_RAW_TRANSACTION", "PHAROS_CHAIN_ID", "PHAROS_NATIVE_SYMBOL", "PHAROS_RPC_URL"],
      );
    } finally {
      await mcp.close();
    }
  });

  it("paces the local server at 60 requests per minute by default", async () => {
    process.env.PHAROS_MCP_BIN = helper("fake-chain-server.mjs");
    const mcp = await chainMcp("atlantic");
    expect(mcp.perMinute).toBe(60);
    await mcp.close();
  });

  it("turns broadcasting on in the child only when asked", () => {
    expect(stdioEnv(false).ENABLE_SEND_RAW_TRANSACTION).toBe("false");
    expect(stdioEnv(true)).toMatchObject({ ENABLE_SEND_RAW_TRANSACTION: "true", PHAROS_CHAIN_ID: "688689", PHAROS_RPC_URL: "https://atlantic.dplabs-internal.com" });
  });

  it("starts a new local server when the old one exits, on the next call", async () => {
    process.env.PHAROS_MCP_BIN = helper("fake-chain-server.mjs");
    const mcp = await chainMcp("atlantic", { perMinute: 0, retries: 0 });
    try {
      await expect(mcp.call("crash")).rejects.toMatchObject({ code: ErrorCode.ConnectionClosed });
      expect(await mcp.call("get_chain_info")).toMatchObject({ chainId: 688689 });
    } finally {
      await mcp.close();
    }
  });

  it("retries a read that was in flight when the local server died, on a fresh server", async () => {
    process.env.PHAROS_MCP_BIN = helper("fake-chain-server.mjs");
    const mcp = await chainMcp("atlantic", { perMinute: 0, sleep: async () => {} });
    try {
      expect(await mcp.call("crash_once")).toEqual({ answered: true });
    } finally {
      await mcp.close();
    }
  });

  it("sends a broadcast once: a timed-out send_raw_transaction is not resent", async () => {
    process.env.PHAROS_MCP_BIN = helper("fake-chain-server.mjs");
    const mcp = await chainMcp("atlantic", { perMinute: 0, broadcast: true, timeoutMs: 300, sleep: async () => {} });
    try {
      expect(mcp.broadcast).toBe(true);
      await expect(mcp.call("send_raw_transaction", { rawTransaction: "0x02" })).rejects.toThrow(/timed out/i);
      expect(await mcp.call("calls")).toMatchObject({ send_raw_transaction: 1 });
    } finally {
      await mcp.close();
    }
  });

  it("explains a local server that cannot start with the tail of its stderr", async () => {
    process.env.PHAROS_MCP_BIN = helper("fake-broken-server.mjs");
    await expect(chainMcp("atlantic", { perMinute: 0, retries: 0 })).rejects.toThrow(/local server stderr: fake server: cannot open the RPC endpoint/);
  });

  it("says how to build the local server when it is missing", async () => {
    process.env.PHAROS_MCP_BIN = "/nonexistent/pharos-mcp/index.js";
    await expect(chainMcp("atlantic")).rejects.toThrow(/missing — run: npm run setup:mcp/);
  });
});
