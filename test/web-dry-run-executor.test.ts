// The Dry-Run Executor demo endpoint: input validation, the streamed lamp events and the blocked path, on a fake Atlantic RPC.
import { encodeErrorResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { atlanticCall, type Rpc } from "../src/lib/atlantic-call.js";
import { handle, requestFor, runDemo, STEP_IDS } from "../tasks/dry-run-executor/web.js";

const REVERT = encodeErrorResult({ abi: parseAbi(["error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)"]), errorName: "ERC20InsufficientBalance", args: ["0x317bca01Bb101C0F1E86C21576a4e14D92B02975", 0n, 5n] });

/** A fake JSON-RPC: 1 gwei, 1 PHRS everywhere, 21000 gas; `revert` makes eth_call/estimate revert with code 3. */
function fakeRpc(o: { revert?: boolean } = {}) {
  const methods: string[] = [];
  const rpc: Rpc = {
    async request({ method, params }) {
      methods.push(method);
      switch (method) {
        case "eth_blockNumber": return "0x64";
        case "eth_getBalance": return "0xde0b6b3a7640000";
        case "eth_gasPrice": return "0x3b9aca00";
        case "eth_maxPriorityFeePerGas": return "0x0";
        case "eth_getBlockByNumber": return { number: "0x64", baseFeePerGas: "0x3b9aca00", timestamp: "0x1" };
        case "eth_call":
        case "eth_estimateGas":
          if (o.revert && (params as any[])[0]?.from) throw Object.assign(new Error("execution reverted"), { code: 3, data: REVERT });
          return method === "eth_call" ? (((params as any[])[0]?.from) ? "0x" : `0x${"0".repeat(64)}`) : "0x5208";
        default: throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { rpc, methods };
}

async function collect(scenario: string, rpc: Rpc) {
  const events: any[] = [];
  const { req } = requestFor(new URLSearchParams({ scenario }));
  await runDemo((e) => events.push(e), scenario as never, req, rpc);
  return events;
}

describe("dry-run-executor web", () => {
  it("rejects bad input with a 400 before doing any work", async () => {
    for (const qs of ["action=run&scenario=nope", "action=run&scenario=custom&from=0x1&to=0x2", "action=run&scenario=custom&from=0x317bca01Bb101C0F1E86C21576a4e14D92B02975&to=0x317bca01Bb101C0F1E86C21576a4e14D92B02975&value=abc", "action=run&scenario=custom&from=0x317bca01Bb101C0F1E86C21576a4e14D92B02975&to=0x317bca01Bb101C0F1E86C21576a4e14D92B02975&token=DOGE&amount=1", "action=run&scenario=custom&from=0x317bca01Bb101C0F1E86C21576a4e14D92B02975&to=0x317bca01Bb101C0F1E86C21576a4e14D92B02975&value=1&data=0xzz", "action=send"]) {
      const res = await handle(new Request(`http://x/api/dry-run-executor?${qs}`));
      expect(res.status, qs).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
  });

  it("info answers with the deploy stamp and the scenarios", async () => {
    const body = await (await handle(new Request("http://x/api/dry-run-executor?action=info"))).json();
    expect(body.deploy).toHaveProperty("env");
    expect(Object.keys(body.scenarios)).toContain("revert");
  });

  it("a passing simulation lights every lamp and never reaches a send", async () => {
    const { rpc, methods } = fakeRpc();
    const ev = await collect("send", rpc);
    expect(ev.filter((e) => e.type === "step").map((e) => e.id)).toEqual([...STEP_IDS]);
    const done = ev.at(-1);
    expect(done).toMatchObject({ type: "done", status: "simulated", ok: true, gas: 21000n, feePHRS: "0.000021" });
    expect(methods).not.toContain("eth_sendRawTransaction");
  });

  it("a revert is BLOCKED with the decoded reason", async () => {
    const ev = await collect("revert", fakeRpc({ revert: true }).rpc);
    expect(ev.find((e) => e.id === "call")).toMatchObject({ state: "refused" });
    expect(ev.find((e) => e.id === "decide")).toMatchObject({ state: "refused", label: "BLOCKED" });
    expect(ev.at(-1)).toMatchObject({ status: "blocked", failure: expect.stringContaining("ERC20InsufficientBalance") });
  });

  it("the Atlantic adapter refuses any tool that could send", async () => {
    const call = atlanticCall({ rpc: fakeRpc().rpc });
    await expect(call("send_raw_transaction" as never, {})).rejects.toThrow(/not available/);
  });
});
