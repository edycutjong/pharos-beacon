// src/web/demo.ts: the Atlantic reader speaks the sponsor server's tool shapes over JSON-RPC, and reports errors the same way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChainToolError } from "../src/lib/mcp.js";
import { blockTag, pickAddress, pickInt, pinHead, rpcCall, timedCall } from "../src/web/demo.js";

afterEach(() => vi.unstubAllGlobals());
const rpcReply = (fn: (body: any) => unknown) =>
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(fn(JSON.parse(init.body)) as object) }))));

describe("demo plumbing", () => {
  it("normalizes block tags like the sponsor server", () => {
    expect(blockTag(undefined)).toBe("latest");
    expect(blockTag("31560420")).toBe("0x1e192e4");
    expect(blockTag(16)).toBe("0x10");
    expect(blockTag("pending")).toBe("pending");
    expect(() => blockTag("soon")).toThrow(ChainToolError);
  });

  it("shapes replies like the sponsor server", async () => {
    rpcReply((b) => ({ result: b.method === "eth_blockNumber" ? "0x64" : b.method === "eth_estimateGas" ? "0x5208" : "0xabcd" }));
    const call = rpcCall("https://rpc.example");
    expect(await call("get_block_number")).toEqual({ blockNumber: "100", blockNumberHex: "0x64" });
    expect(await call("estimate_gas", { transaction: { to: "0x838800b758277CC111B2d48Ab01e5E164f8E9471" } })).toEqual({ gas: "21000", gasHex: "0x5208" });
    expect(await call("eth_call", { transaction: { to: "0x838800b758277CC111B2d48Ab01e5E164f8E9471", data: "0x" }, block: "5" })).toEqual({ result: "0xabcd" });
  });

  it("a revert is a ChainToolError with code 3 and the revert bytes, as through the MCP", async () => {
    rpcReply(() => ({ error: { code: 3, message: "execution reverted", data: "0x08c379a0" } }));
    const e = await rpcCall("https://rpc.example")("eth_call", { transaction: { to: "0x838800b758277CC111B2d48Ab01e5E164f8E9471" } }).catch((x) => x);
    expect(e).toBeInstanceOf(ChainToolError);
    expect([e.code, e.data, e.reason]).toEqual([3, "0x08c379a0", "execution reverted"]);
  });

  it("refuses what the pages never need, and caps get_logs at 1000 blocks", async () => {
    rpcReply(() => ({ result: [] }));
    const call = rpcCall("https://rpc.example");
    await expect(call("send_raw_transaction", { rawTransaction: "0x00" })).rejects.toThrow(/does not offer/);
    await expect(call("get_logs", { fromBlock: "1", toBlock: "1001" })).rejects.toThrow(/too large/);
    expect(await call("get_logs", { fromBlock: "1", toBlock: "1000" })).toEqual([]);
  });

  it("times calls and pins the head", async () => {
    const seen: any[] = [];
    const base = (async (t: string) => (t === "get_block_number" ? { blockNumber: "500" } : { ok: true })) as any;
    const c = pinHead(timedCall(base, (r) => seen.push(r)), 120n);
    expect(await c("get_block_number")).toEqual({ blockNumber: "120", blockNumberHex: "0x78" });
    expect(seen[0]).toMatchObject({ tool: "get_block_number", ok: true });
  });

  it("checks public input", () => {
    expect(() => pickAddress("0x12")).toThrow(/address/);
    expect(pickInt(null, "n", 1, 5, 3)).toBe(3);
    expect(() => pickInt("9", "n", 1, 5, 3)).toThrow(/1 to 5/);
  });
});
