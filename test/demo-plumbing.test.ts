import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAIN_ID, ChainToolError, MAX_LOG_WINDOW, type ChainMcp } from "../src/lib/mcp.js";
import { ATLANTIC_RPC, InputError, busyResponse, concurrency, deployInfo, json, ndjson, openReader, pickAddress, pickHash, pickInt, pickNetwork, pinHead, publicMessage, rpcCall, timedCall, blockTag, type CallRecord } from "../src/web/demo.js";

const WPROS_ADDR = "0x838800b758277CC111B2d48Ab01e5E164f8E9471";
const HASH = `0x${"ab".repeat(32)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Replace fetch with a script of replies, one per attempt; the JSON-RPC bodies sent are collected. */
function script(...replies: (Response | Error)[]) {
  const sent: any[] = [];
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    sent.push(JSON.parse(init.body));
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return r.clone();
  }));
  return sent;
}
const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
const lines = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

describe("responses", () => {
  it("json stringifies bigints and sets no-store", async () => {
    const res = json({ n: 5n }, 202, { "x-a": "b" });
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-a")).toBe("b");
    expect(await res.json()).toEqual({ n: "5" });
  });

  it("deployInfo reads the Vercel environment", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abcdef0123");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(deployInfo()).toEqual({ commit: "abcdef0", env: "preview" });
  });

  it("publicMessage keeps the first line, cut to 300 characters", () => {
    expect(publicMessage(new Error("first\nsecond"))).toBe("first");
    expect(publicMessage("y".repeat(400))).toHaveLength(300);
    expect(publicMessage(42)).toBe("42");
  });

  it("ndjson streams events, turns a throw into an error line and always calls onEnd", async () => {
    const onEnd = vi.fn();
    const res = ndjson(async (emit) => {
      emit({ type: "a", n: 7n });
      throw new Error("boom\ndetails");
    }, onEnd);
    expect(res.headers.get("content-type")).toMatch(/x-ndjson/);
    expect(await lines(res)).toEqual([{ type: "a", n: "7" }, { type: "error", message: "boom" }]);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("concurrency admits up to max and never goes negative on a stray release", () => {
    const c = concurrency(2);
    expect([c.take(), c.take(), c.take()]).toEqual([true, true, false]);
    expect(c.busy).toBe(2);
    c.release();
    expect(c.take()).toBe(true);
    c.release(); c.release(); c.release();
    expect(c.busy).toBe(0);
  });

  it("busyResponse is a 429 with retry-after", async () => {
    const res = busyResponse("scan");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    expect((await res.json()).error).toBe("another scan is running on this server right now; try again in a few seconds");
  });
});

describe("input checks", () => {
  it("pickNetwork takes pharos or atlantic, the fallback when blank, and rejects the rest", () => {
    expect(pickNetwork("pharos")).toBe("pharos");
    expect(pickNetwork("atlantic")).toBe("atlantic");
    expect(pickNetwork(null)).toBe("atlantic");
    expect(pickNetwork("", "pharos")).toBe("pharos");
    expect(() => pickNetwork("mars")).toThrow(InputError);
  });

  it("pickHash lower-cases a 32-byte hash and explains a bad one", () => {
    expect(pickHash(`  0x${"AB".repeat(32)} `)).toBe(HASH);
    expect(() => pickHash("0x12")).toThrow("a transaction hash is 0x followed by 64 hex characters");
    expect(() => pickHash(null, "the id")).toThrow("the id is 0x followed");
  });

  it("pickAddress accepts any-case addresses and rejects others", () => {
    expect(pickAddress(WPROS_ADDR.toLowerCase())).toBe(WPROS_ADDR.toLowerCase());
    expect(() => pickAddress("0x12")).toThrow("the contract must be an address");
    expect(() => pickAddress(null, "the wallet")).toThrow("the wallet must be an address");
  });

  it("pickInt bounds a whole number and falls back when absent", () => {
    expect(pickInt(null, "n", 1, 10, 5)).toBe(5);
    expect(pickInt("", "n", 1, 10, 5)).toBe(5);
    expect(pickInt("10", "n", 1, 10, 5)).toBe(10);
    for (const bad of ["0", "11", "-1", "1.5", "abc", "1234567890"]) expect(() => pickInt(bad, "n", 1, 10, 5)).toThrow("n must be a whole number from 1 to 10");
  });
});

describe("timedCall", () => {
  it("reports a successful call with its arguments", async () => {
    const seen: CallRecord[] = [];
    const call = timedCall((async (t: string) => ({ tool: t })) as never, (r) => seen.push(r));
    expect(await call("get_block_number", { a: 1 } as never)).toEqual({ tool: "get_block_number" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tool: "get_block_number", args: { a: 1 }, ok: true });
  });

  it("reports a tool error with its code, a plain error by its first line, and rethrows", async () => {
    const seen: CallRecord[] = [];
    const bad = timedCall((async () => { throw new ChainToolError("eth_call", "execution reverted", 3); }) as never, (r) => seen.push(r));
    await expect(bad("eth_call")).rejects.toBeInstanceOf(ChainToolError);
    const plain = timedCall((async () => { throw new Error("socket\nstack"); }) as never, (r) => seen.push(r));
    await expect(plain("get_block")).rejects.toThrow("socket");
    const noCode = timedCall((async () => { throw new ChainToolError("t", "just a reason"); }) as never, (r) => seen.push(r));
    await expect(noCode("t")).rejects.toThrow();
    expect(seen.map((s) => s.error)).toEqual([{ reason: "execution reverted", code: 3 }, { reason: "socket" }, { reason: "just a reason" }]);
    expect(seen.every((s) => s.ok === false)).toBe(true);
  });
});

describe("rpcCall", () => {
  const call = rpcCall("https://rpc.example");

  it("get_chain_info combines chain id and head", async () => {
    script(ok("0xa8231"), ok("0x10"));
    const info = (await call("get_chain_info")) as any;
    expect(info).toMatchObject({ chainId: 688689, chainIdHex: "0xa8231", expectedChainId: 688689, chainIdMatches: true, latestBlock: "16", rpcUrl: "https://rpc.example" });
  });

  it("get_block passes the tag and the includeTransactions flag", async () => {
    const sent = script(ok({ number: "0x5" }));
    expect(await call("get_block", { block: "5", includeTransactions: true })).toEqual({ number: "0x5" });
    expect(sent[0]).toMatchObject({ method: "eth_getBlockByNumber", params: ["0x5", true] });
  });

  it("get_transaction and get_transaction_receipt validate the hash and map to the right method", async () => {
    const sent = script(ok({ hash: HASH }));
    await call("get_transaction", { hash: HASH });
    await call("get_transaction_receipt", { hash: HASH });
    expect(sent.map((s) => s.method)).toEqual(["eth_getTransactionByHash", "eth_getTransactionReceipt"]);
    await expect(call("get_transaction", { hash: "0x12" })).rejects.toThrow("hash must be a 32-byte hex hash");
  });

  it("get_balance returns wei, ether and the symbol", async () => {
    script(ok("0xde0b6b3a7640000"));
    expect(await call("get_balance", { address: WPROS_ADDR })).toEqual({ address: WPROS_ADDR, balanceWei: "1000000000000000000", balance: "1", symbol: "PHRS", balanceHex: "0xde0b6b3a7640000" });
    await expect(call("get_balance", { address: "nope" })).rejects.toThrow("address must be a valid EVM address");
  });

  it("refuses an invalid RPC quantity", async () => {
    script(ok("not hex"));
    await expect(call("get_block_number")).rejects.toThrow("Invalid RPC quantity: not hex");
  });

  it("eth_call checks the transaction fields", async () => {
    script(ok("0x"));
    await expect(call("eth_call", { transaction: { to: "nope" } })).rejects.toThrow("to must be a valid EVM address");
    await expect(call("eth_call", { transaction: { to: WPROS_ADDR, data: "zz" } })).rejects.toThrow("data must be 0x-prefixed hexadecimal data");
    await expect(call("eth_call", { transaction: { to: WPROS_ADDR, value: 5 } })).rejects.toThrow("value must be 0x-prefixed");
    expect(await call("eth_call", { transaction: { to: WPROS_ADDR, from: "", gas: null } })).toEqual({ result: "0x" });
  });

  it("get_logs enforces an ordered range inside the node's window", async () => {
    const sent = script(ok([]));
    await call("get_logs", { fromBlock: 10, toBlock: 20, address: WPROS_ADDR, topics: [HASH] });
    expect(sent[0].params[0]).toEqual({ fromBlock: "0xa", toBlock: "0x14", address: WPROS_ADDR, topics: [HASH] });
    await expect(call("get_logs", { fromBlock: 20, toBlock: 10 })).rejects.toThrow("toBlock must be greater than or equal to fromBlock");
    await expect(call("get_logs", { fromBlock: 0, toBlock: MAX_LOG_WINDOW })).rejects.toThrow(`Block range too large: ${MAX_LOG_WINDOW + 1} blocks requested, maximum is ${MAX_LOG_WINDOW}.`);
    await call("get_logs", {}); // tags: no window check
    expect(sent.at(-1).params[0]).toEqual({ fromBlock: "latest", toBlock: "latest" });
  });

  it("does not offer send tools", async () => {
    await expect(call("send_raw_transaction", {})).rejects.toThrow("the demo's Atlantic reader does not offer send_raw_transaction");
  });

  it("blockTag rejects a negative or unsafe number", () => {
    expect(() => blockTag(-1)).toThrow("block must be non-negative");
    expect(() => blockTag(1.5)).toThrow("block must be non-negative");
    expect(blockTag("0xAB")).toBe("0xab");
  });
});

describe("rpc retries", () => {
  it("retries a 429 and a network failure, then succeeds", async () => {
    vi.useFakeTimers();
    const sent = script(new Response("slow down", { status: 429 }), new Error("ECONNRESET"), ok("0x64"));
    const p = rpcCall("https://rpc.example")("get_block_number");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await p).toEqual({ blockNumber: "100", blockNumberHex: "0x64" });
    expect(sent).toHaveLength(3);
  });

  it("gives up after three attempts with the last failure", async () => {
    vi.useFakeTimers();
    script(new Response("x", { status: 503 }));
    const p = rpcCall("https://rpc.example")("get_block_number").catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await p).message).toBe("the Atlantic RPC answered HTTP 503");
  });

  it("wraps a thrown non-Error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => { throw "offline"; }));
    const p = rpcCall("https://rpc.example")("get_block_number").catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await p).message).toBe("offline");
  });

  it("a non-JSON answer is a tool error, and an error member keeps its message", async () => {
    script(new Response("<html>", { status: 200 }));
    await expect(rpcCall("https://rpc.example")("get_block_number")).rejects.toThrow("the Atlantic RPC answered HTTP 200 without JSON");
    script(Response.json({ error: { message: "  " } }));
    await expect(rpcCall("https://rpc.example")("get_block_number")).rejects.toThrow("error");
  });
});

describe("openReader", () => {
  it("pharos goes through the hosted MCP client and keeps its close", async () => {
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({ chainId: 1672, endpoint: "https://mcp.example", call: async () => "x", close })) as unknown as typeof import("../src/lib/mcp.js").chainMcp;
    const seen: CallRecord[] = [];
    const r = await openReader("pharos", (c) => seen.push(c), open);
    expect(r).toMatchObject({ network: "pharos", chainId: 1672, endpoint: "https://mcp.example", via: "hosted Chain MCP" });
    await r.call("get_block_number");
    expect(seen).toHaveLength(1);
    await r.close();
    expect(close).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("pharos", { retries: 1, timeoutMs: 20_000 });
    const plain = await openReader("pharos", undefined, open);
    expect(plain.call).toEqual(expect.any(Function));
  });

  it("atlantic checks the chain id before it hands out the reader", async () => {
    script(ok("0xa8231"), ok("0x1"));
    const r = await openReader("atlantic");
    expect(r).toMatchObject({ network: "atlantic", chainId: CHAIN_ID.atlantic, endpoint: ATLANTIC_RPC, via: "direct JSON-RPC" });
    await expect(r.close()).resolves.toBeUndefined();
    script(ok("0x1"), ok("0x1"));
    await expect(openReader("atlantic", () => {})).rejects.toThrow(`serves chain 1, not Atlantic (${CHAIN_ID.atlantic}): refusing to read from it`);
  });
});

describe("pinHead", () => {
  const chain = (n: number) => (async (t: string) => (t === "get_block_number" ? { blockNumber: String(n) } : { other: t })) as unknown as ChainMcp["call"];

  it("never reports a head beyond the pin, and passes other tools through", async () => {
    const call = pinHead(chain(500), 300n);
    expect(await call("get_block_number")).toEqual({ blockNumber: "300", blockNumberHex: "0x12c" });
    expect(await call("get_chain_info")).toEqual({ other: "get_chain_info" });
  });

  it("reports the real head when it is behind the pin, and accepts a moving pin", async () => {
    expect(await pinHead(chain(100), 300n)("get_block_number")).toEqual({ blockNumber: "100", blockNumberHex: "0x64" });
    let cap = 10n;
    const call = pinHead(chain(100), () => cap);
    expect(((await call("get_block_number")) as any).blockNumber).toBe("10");
    cap = 50n;
    expect(((await call("get_block_number")) as any).blockNumber).toBe("50");
  });
});
