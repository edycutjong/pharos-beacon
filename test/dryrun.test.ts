import { encodeAbiParameters, encodeErrorResult, encodeFunctionData, erc20Abi, parseEther, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ChainToolError, type ChainMcp } from "../src/lib/mcp.js";
import { dryRun, type Send } from "../src/dryrun/run.js";
import { decodeTransfer, explainRevertData, simulate } from "../src/dryrun/simulate.js";
import { formatResult } from "../tasks/dry-run-executor/index.js";

const FROM = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975" as Hex;
const TO = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B" as Hex;
const TOKEN = "0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8" as Hex;

/** A Chain MCP stand-in with mutable balances; eth_call/estimate_gas behaviour is injected. */
function chain(o: { eth_call?: (a: any) => unknown; estimate_gas?: unknown; native?: Record<string, bigint>; tokens?: Record<string, bigint> } = {}) {
  const native = { [FROM.toLowerCase()]: parseEther("1"), [TO.toLowerCase()]: parseEther("2"), ...o.native };
  const tokens = { [FROM.toLowerCase()]: 5_000_000n, [TO.toLowerCase()]: 0n, ...o.tokens };
  const calls: string[] = [];
  const call = (async (name: string, args: any) => {
    calls.push(name);
    switch (name) {
      case "get_block_number": return { blockNumber: "100" };
      case "get_balance": return { balanceWei: native[args.address.toLowerCase()]!.toString() };
      case "get_block": return { baseFeePerGas: "0x3b9aca00" }; // 1 gwei
      case "get_gas_price": return { maxPriorityFeePerGasWei: "0" };
      case "eth_call": {
        if (o.eth_call) { const v = o.eth_call(args); if (v instanceof Error) throw v; if (v) return v; }
        // balanceOf(address)
        const data: string = args.transaction.data ?? "";
        if (data.startsWith("0x70a08231")) return { result: `0x${tokens[`0x${data.slice(34, 74)}`]!.toString(16).padStart(64, "0")}` };
        return { result: "0x" };
      }
      case "estimate_gas": {
        if (o.estimate_gas instanceof Error) throw o.estimate_gas;
        return { gas: String(o.estimate_gas ?? 21000) };
      }
    }
    throw new Error(`unexpected tool ${name}`);
  }) as unknown as ChainMcp["call"];
  return { call, calls, native, tokens };
}

const nativeReq = { from: FROM, to: TO, value: parseEther("0.1") };
const revert = (data: Hex) => new ChainToolError("eth_call", "execution reverted", 3, data);

describe("simulate", () => {
  it("predicts success, the fee and the balances after a native send", async () => {
    const s = await simulate(chain().call, nativeReq);
    expect(s.ok).toBe(true);
    expect(s.gas).toBe(21000n);
    expect(s.costWei).toBe(21000n * 1_000_000_000n);
    const [sender, recipient] = s.changes;
    expect(sender!.after).toBe(parseEther("1") - parseEther("0.1") - 21000n * 1_000_000_000n);
    expect(recipient!.after).toBe(parseEther("2.1"));
  });

  it("decodes Error(string) revert reasons", async () => {
    const data = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }], errorName: "Error", args: ["sale closed"] });
    const s = await simulate(chain({ eth_call: () => revert(data) }).call, nativeReq);
    expect(s.ok).toBe(false);
    expect(s.failure).toBe("reverted: sale closed");
    expect(s.gas).toBeUndefined();
    expect(s.changes[0]!.after).toBe(s.changes[0]!.before); // a failed call changes nothing
  });

  it("decodes token errors, and says so when a revert has no reason", async () => {
    const data = encodeErrorResult({ abi: [{ type: "error", name: "ERC20InsufficientBalance", inputs: [{ type: "address", name: "sender" }, { type: "uint256", name: "balance" }, { type: "uint256", name: "needed" }] }], errorName: "ERC20InsufficientBalance", args: [FROM, 0n, 10n] });
    expect(explainRevertData(data)).toBe(`reverted: ERC20InsufficientBalance(${FROM}, 0, 10)`);
    expect(explainRevertData("0x")).toBe("reverted without a reason");
    expect(explainRevertData("0xdeadbeef")).toMatch(/selector 0xdeadbeef/);
  });

  it("reports a node refusal that is not a revert", async () => {
    const s = await simulate(chain({ eth_call: () => new ChainToolError("eth_call", "insufficient funds for gas * price + value", -32000) }).call, nativeReq);
    expect(s.ok).toBe(false);
    expect(s.failure).toMatch(/node refused the call: insufficient funds/);
  });

  it("fails when value + fee exceeds the balance even if the call itself would run", async () => {
    const s = await simulate(chain({ native: { [FROM.toLowerCase()]: parseEther("0.1") } }).call, nativeReq);
    expect(s.ok).toBe(false);
    expect(s.failure).toMatch(/not enough PHRS for value \+ fee/);
  });

  it("fails when gas estimation fails", async () => {
    const s = await simulate(chain({ estimate_gas: new ChainToolError("estimate_gas", "execution reverted", 3) }).call, nativeReq);
    expect(s.ok).toBe(false);
    expect(s.failure).toMatch(/gas estimation failed/);
  });

  it("reads token balances for an ERC-20 transfer and predicts both sides", async () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TO, 1_500_000n] });
    expect(decodeTransfer(data)).toEqual({ to: TO, amount: 1_500_000n });
    expect(decodeTransfer("0xdeadbeef")).toBeNull();
    const s = await simulate(chain().call, { from: FROM, to: TOKEN, value: 0n, data, token: { symbol: "USDC", decimals: 6 } });
    const usdc = s.changes.filter((c) => c.asset === "USDC");
    expect(usdc.map((c) => [c.who, c.before, c.after])).toEqual([["sender", 5_000_000n, 3_500_000n], ["recipient", 0n, 1_500_000n]]);
  });
});

describe("dryRun gate", () => {
  it("never calls the sender when the simulation fails", async () => {
    const send = vi.fn<Send>(async () => { throw new Error("must not be called"); });
    const r = await dryRun(chain({ eth_call: () => revert("0x") }).call, nativeReq, { execute: true, send });
    expect(r.status).toBe("blocked");
    expect(send).not.toHaveBeenCalled();
    expect(formatResult(r)).toMatch(/BLOCKED: the simulation failed, so nothing was signed or sent/);
  });

  it("does not send without --execute", async () => {
    const send = vi.fn<Send>();
    const r = await dryRun(chain().call, nativeReq, { execute: false, send });
    expect(r.status).toBe("simulated");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends once on a pass and compares the prediction with the chain", async () => {
    const c = chain();
    const send: Send = async (_req, gas) => {
      expect(gas).toBe(21000n);
      // the chain moves: value + the fee actually paid (20,000 gas used at the same price)
      c.native[FROM.toLowerCase()] = c.native[FROM.toLowerCase()]! - parseEther("0.1") - 20_000n * 1_000_000_000n;
      c.native[TO.toLowerCase()] = c.native[TO.toLowerCase()]! + parseEther("0.1");
      return { tx: `0x${"ab".repeat(32)}`, status: "success", block: "101", gasUsed: 20_000n, effectiveGasPrice: 1_000_000_000n };
    };
    const r = await dryRun(c.call, nativeReq, { execute: true, send });
    expect(r.status).toBe("executed");
    expect(r.accuracy!.gas).toEqual({ predicted: 21000n, actual: 20000n, errorPct: "-4.76" });
    expect(r.accuracy!.feeWei).toEqual({ predicted: 21_000_000_000_000n, actual: 20_000_000_000_000n });
    const [sender, recipient] = r.accuracy!.changes;
    expect(recipient!.delta).toBe(0n);
    expect(sender!.delta).toBe(1_000_000_000_000n); // we over-predicted the fee by 1,000 gas × 1 gwei
    expect(formatResult(r)).toMatch(/gas 21000 → 20000 used \(-4\.76%\)/);
  });

  it("reports a reverted send without an accuracy block", async () => {
    const send: Send = async () => ({ tx: `0x${"cd".repeat(32)}`, status: "reverted", block: "102", gasUsed: 21000n });
    const r = await dryRun(chain().call, nativeReq, { execute: true, send });
    expect(r.status).toBe("reverted");
    expect(r.accuracy).toBeUndefined();
  });
});
