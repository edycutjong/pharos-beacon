import { encodeFunctionResult, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { MULTICALL3, multicallAbi } from "../src/batch/batch.js";
import { ChainToolError } from "../src/lib/mcp.js";
import { atlanticRpcCall } from "../src/web/atlantic-rpc.js";
import { handle, parseSim, type Deps } from "../tasks/batch-executor/web.js";
import { events, fakeRaw, req } from "./web-helpers.js";

const native = (n: number) => ({ type: "native", to: `0x${String(n).repeat(40)}`, value: "0.0001" });
const three = [native(1), native(2), native(3)];
const deps = (okFlags = [true, true, true]): Deps => ({
  fetch: fakeRaw({ "plans/one-fails.json": { actions: three } }),
  call: () => (async (name: string, args: { transaction?: { to?: string } }) => {
    if (name === "get_block_number") return { blockNumber: "77" };
    if (name === "get_block") return { baseFeePerGas: "0x3b9aca00" };
    if (name === "get_gas_price") return { maxPriorityFeePerGasWei: "0" };
    if (name === "eth_call") return { result: encodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3Value", result: okFlags.map((success) => ({ success, returnData: "0x" as const })) }) };
    if (name === "estimate_gas") return { gas: args.transaction?.to?.toLowerCase() === MULTICALL3.toLowerCase() ? "50000" : "21000" };
    throw new Error(`unexpected ${name}`);
  }) as never,
});

describe("batch-executor web endpoint", () => {
  it("validates the query and the typed plan", () => {
    expect(parseSim(new URL("http://x/?plan=one-fails&drop=1"))).toMatchObject({ plan: "one-fails", drop: true });
    expect(() => parseSim(new URL("http://x/?plan=../../x"))).toThrow(/plan/);
    expect(() => parseSim(new URL("http://x/?from=0x12"))).toThrow(/from/);
    expect(() => parseSim(new URL(`http://x/?plan=custom&actions=${encodeURIComponent(JSON.stringify(three.slice(0, 2)))}`))).toThrow(/at least 3/);
    expect(() => parseSim(new URL(`http://x/?plan=custom&actions=${encodeURIComponent(JSON.stringify(Array.from({ length: 9 }, (_, i) => native(i + 1))))}`))).toThrow(/at most 8/);
    expect(() => parseSim(new URL("http://x/?plan=custom&actions=nope"))).toThrow(/JSON/);
  });

  it("simulates a committed plan and compares estimate with estimate", async () => {
    const ev = await events(await handle(req("action=simulate&plan=one-fails"), deps()));
    const done = ev.find((e) => e.type === "done")!;
    expect(done.status).toBe("simulated");
    expect(done.comparison).toMatchObject({ aloneGas: "63000", batchGas: "50000", pct: "20.63", steps: { alone: 3, batch: 1 } });
    expect(ev.filter((e) => e.type === "step" && e.state !== "running").map((e) => e.id)).toEqual(["plan", "allowance", "prep", "batch-call", "alone", "batch-gas", "verdict"]);
  });

  it("names a failing action and gives no like-for-like figure, and a failing PHRS action is BLOCKED", async () => {
    const done = (await events(await handle(req("action=simulate&plan=one-fails"), deps([true, false, true])))).find((e) => e.type === "done")!;
    expect(done.sim[1]).toMatchObject({ n: 2, ok: false });
    expect(done.comparison).toBeNull();
    expect(done.status).toBe("blocked");
  });
});

describe("atlantic RPC adapter", () => {
  const rpc = (reply: (method: string) => unknown) =>
    atlanticRpcCall({ gapMs: 0, sleep: async () => {}, fetch: (async (_u: string, init: RequestInit) => Response.json({ jsonrpc: "2.0", id: 1, ...(reply(JSON.parse(String(init.body)).method) as object) })) as unknown as typeof fetch });

  it("answers in the Chain MCP's shapes", async () => {
    const call = rpc((m) => ({ result: m === "eth_blockNumber" ? toHex(31566858) : "0x2a" }));
    expect(await call("get_block_number")).toMatchObject({ blockNumber: "31566858" });
    expect(await call("get_transaction_count", { address: "0x" + "1".repeat(40), block: "100" })).toMatchObject({ nonce: "42" });
  });

  it("turns a revert into a ChainToolError with code 3 and the revert data, and retries throttling", async () => {
    let n = 0;
    const call = rpc(() => (++n === 1 ? { error: { code: -32011, message: "request too fast per second" } } : { error: { code: 3, message: "execution reverted", data: "0xdeadbeef" } }));
    const e = await call("eth_call", { transaction: { to: MULTICALL3 } }).catch((x) => x);
    expect(e).toBeInstanceOf(ChainToolError);
    expect(e).toMatchObject({ code: 3, data: "0xdeadbeef" });
    expect(n).toBe(2);
  });

  it("has no send", async () => {
    await expect(rpc(() => ({ result: "0x" }))("send_raw_transaction", {})).rejects.toThrow(/not available/);
  });
});
