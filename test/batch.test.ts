import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, parseEther, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ChainToolError, type ChainMcp } from "../src/lib/mcp.js";
import { MULTICALL3, PlanError, batchCalldata, compare, multicallAbi, resolveActions, runBatch, simulateBatch, type Send } from "../src/batch/batch.js";
import { formatResult } from "../tasks/batch-executor/index.js";

const FROM = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975" as Hex;
const R1 = "0x1111111111111111111111111111111111111111";
const R2 = "0x2222222222222222222222222222222222222222";
const R3 = "0x3333333333333333333333333333333333333333";
const specs = [
  { type: "native", to: R1, value: "0.001" },
  { type: "erc20", token: "WPHRS", to: R2, amount: "0.002" },
  { type: "erc20", token: "WPHRS", to: R3, amount: "0.003" },
];
const errString = (m: string) => encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }], errorName: "Error", args: [m] });

/** A Chain MCP stand-in. `failing` = indexes of batch actions whose call reverts; `balances` move when the batch is "sent". */
function chain(o: { failing?: number[]; batchRevert?: Hex; aloneFail?: (to: string) => boolean } = {}) {
  const balances = new Map<string, bigint>();
  const calls: string[] = [];
  const call = (async (name: string, args: any) => {
    calls.push(name);
    switch (name) {
      case "get_block_number": return { blockNumber: "100" };
      case "get_block": return { baseFeePerGas: "0x3b9aca00" };
      case "get_gas_price": return { maxPriorityFeePerGasWei: "0" };
      case "get_balance": return { balanceWei: (balances.get(args.address.toLowerCase()) ?? 0n).toString() };
      case "eth_call": {
        const tx = args.transaction;
        if (tx.to === MULTICALL3) {
          if (o.batchRevert) throw new ChainToolError("eth_call", "execution reverted", 3, o.batchRevert);
          const [list] = decodeFunctionData({ abi: multicallAbi, data: tx.data }).args;
          const res = list.map((_, i) => (o.failing?.includes(i) ? { success: false, returnData: errString("insufficient allowance") } : { success: true, returnData: "0x" as Hex }));
          return { result: encodeAbiParameters([{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }], [res]) };
        }
        const holder = `0x${tx.data.slice(34, 74)}`;
        return { result: `0x${(balances.get(holder) ?? 0n).toString(16).padStart(64, "0")}` };
      }
      case "estimate_gas": {
        const tx = args.transaction;
        if (tx.to === MULTICALL3) return { gas: "90000" };
        if (o.aloneFail?.(tx.to)) throw new ChainToolError("estimate_gas", "execution reverted", 3, errString("insufficient balance"));
        return { gas: tx.data ? "50000" : "21000" };
      }
    }
    throw new Error(`unexpected tool ${name}`);
  }) as unknown as ChainMcp["call"];
  return { call, calls, balances };
}

describe("resolveActions", () => {
  it("turns native and ERC-20 actions into batch calls and the same actions sent alone", () => {
    const a = resolveActions(specs, FROM);
    expect(a).toHaveLength(3);
    expect(a[0]!.value).toBe(parseEther("0.001"));
    expect(a[1]!.data.startsWith("0x23b872dd")).toBe(true); // transferFrom, the batch's call
    expect(a[1]!.alone.data!.startsWith("0xa9059cbb")).toBe(true); // transfer, what you would send alone
    expect(batchCalldata(a).value).toBe(parseEther("0.001"));
  });

  it("needs at least 3 actions, each with its own recipient", () => {
    expect(() => resolveActions(specs.slice(0, 2), FROM)).toThrow(/at least 3/);
    expect(() => resolveActions([...specs, { type: "native", to: R1, value: "1" }], FROM)).toThrow(PlanError);
    expect(() => resolveActions([...specs, { type: "native", to: R1, value: "1" }], FROM)).toThrow(/appears twice/);
  });

  it("rejects bad actions with the action number", () => {
    expect(() => resolveActions([{ type: "swap" }, ...specs], FROM)).toThrow(/action 1: "type"/);
    expect(() => resolveActions([{ type: "native", to: "nope", value: "1" }, ...specs], FROM)).toThrow(/action 1: "to"/);
    expect(() => resolveActions([{ type: "erc20", token: "DOGE", to: R1, amount: "1" }, ...specs], FROM)).toThrow(/"token" must be one of/);
    expect(() => resolveActions([{ type: "native", to: R1, value: "0" }, ...specs], FROM)).toThrow(/above 0/);
    expect(() => resolveActions("x", FROM)).toThrow(/"actions" list/);
  });
});

describe("simulateBatch", () => {
  it("reports each action inside the batch and alone, and the single batch's gas", async () => {
    const s = await simulateBatch(chain().call, FROM, resolveActions(specs, FROM));
    expect(s.actions.map((x) => x.ok)).toEqual([true, true, true]);
    expect(s.actions.map((x) => x.aloneGas)).toEqual([21000n, 50000n, 50000n]);
    expect(s.batchGas).toBe(90000n);
  });

  it("names the failing action and its reason; the others stay ok", async () => {
    const s = await simulateBatch(chain({ failing: [1] }).call, FROM, resolveActions(specs, FROM));
    expect(s.actions.map((x) => x.ok)).toEqual([true, false, true]);
    expect(s.actions[1]!.failure).toBe("reverted: insufficient allowance");
  });

  it("an action that could not run alone has no individual estimate", async () => {
    const s = await simulateBatch(chain({ aloneFail: (to) => to.toLowerCase() === R1 }).call, FROM, resolveActions(specs, FROM));
    expect(s.actions[0]!.aloneGas).toBeUndefined();
    expect(s.actions[0]!.aloneFailure).toBe("reverted: insufficient balance");
  });

  it("a batch that reverts as a whole is a batch failure", async () => {
    const s = await simulateBatch(chain({ batchRevert: errString("paused") }).call, FROM, resolveActions(specs, FROM));
    expect(s.batchFailure).toBe("reverted: paused");
    expect(s.batchGas).toBeUndefined();
  });
});

describe("runBatch", () => {
  const send = (c: ReturnType<typeof chain>, apply: number[], gasUsed = 70000n): Send =>
    vi.fn(async () => {
      const actions = resolveActions(specs, FROM);
      apply.forEach((i) => c.balances.set(actions[i]!.watch.holder.toLowerCase(), actions[i]!.watch.amount));
      return { tx: `0x${"ab".repeat(32)}` as Hex, status: "success" as const, block: "101", gasUsed };
    });

  it("without --execute it only simulates", async () => {
    const c = chain();
    const s = vi.fn() as unknown as Send;
    const r = await runBatch(c.call, FROM, resolveActions(specs, FROM), { execute: false, dropFailing: false, send: s });
    expect(r.status).toBe("simulated");
    expect(s).not.toHaveBeenCalled();
  });

  it("all succeed: one send, every action applied, gas compared with the sum of the individual estimates", async () => {
    const c = chain();
    const r = await runBatch(c.call, FROM, resolveActions(specs, FROM), { execute: true, dropFailing: false, send: send(c, [0, 1, 2]) });
    expect(r.status).toBe("executed");
    expect(r.outcomes!.map((o) => o.applied)).toEqual([true, true, true]);
    expect(r.comparison).toMatchObject({ comparable: 3, individualGas: 121000n, batchGasUsed: 70000n, savedGas: 51000n, savedPct: "42.14", txAlone: 3, txBatch: 1 });
    expect(formatResult(r)).toContain("3 transactions to sign and send alone → 1 batch transaction");
  });

  it("partial failure: the failed action is named, the rest are applied and not undone", async () => {
    const c = chain({ failing: [1] });
    const r = await runBatch(c.call, FROM, resolveActions(specs, FROM), { execute: true, dropFailing: false, send: send(c, [0, 2]) });
    expect(r.outcomes!.map((o) => o.applied)).toEqual([true, false, true]);
    const text = formatResult(r);
    expect(text).toMatch(/2\. NOT APPLIED {2}send 0.002 WPHRS to .*\(reverted: insufficient allowance\)/);
    expect(text).toContain("2 of 3 applied; 1 failed on its own, the others were not undone");
  });

  it("--drop-failing removes the actions that would fail before the batch is built", async () => {
    const full = chain({ failing: [1] });
    const trimmed = vi.fn();
    let n = 0;
    const call = (async (name: string, args: any) => {
      if (name === "eth_call" && args.transaction.to === MULTICALL3) {
        n++;
        if (n === 1) return full.call(name, args); // first look: action 2 fails
        const [list] = decodeFunctionData({ abi: multicallAbi, data: args.transaction.data }).args;
        trimmed(list.length);
        return chain().call(name, args); // second look: the 2 left all pass
      }
      return full.call(name as never, args);
    }) as unknown as ChainMcp["call"];
    const r = await runBatch(call, FROM, resolveActions(specs, FROM), { execute: true, dropFailing: true, send: send(full, [0, 2]) });
    expect(trimmed).toHaveBeenCalledWith(2);
    expect(r.dropped).toEqual([{ label: expect.stringContaining("0.002 WPHRS"), failure: "reverted: insufficient allowance" }]);
    expect(r.outcomes).toHaveLength(2);
    expect(r.outcomes!.every((o) => o.applied)).toBe(true);
    expect(r.sim.actions.map((a) => a.ok)).toEqual([true, true]); // the trimmed batch's own flags, read by position
    expect(r.sim.actions.map((a) => a.action.index)).toEqual([0, 2]); // numbering stays the plan's
  });

  it("a batch that reverts as a whole is blocked and never sent", async () => {
    const c = chain({ batchRevert: errString("paused") });
    const s = vi.fn() as unknown as Send;
    const r = await runBatch(c.call, FROM, resolveActions(specs, FROM), { execute: true, dropFailing: false, send: s });
    expect(r.status).toBe("blocked");
    expect(s).not.toHaveBeenCalled();
  });

  it("when every action would fail and --drop-failing is set, nothing is sent", async () => {
    const c = chain({ failing: [0, 1, 2] });
    const s = vi.fn() as unknown as Send;
    const r = await runBatch(c.call, FROM, resolveActions(specs, FROM), { execute: true, dropFailing: true, send: s });
    expect(r.status).toBe("blocked");
    expect(r.dropped).toHaveLength(3);
    expect(s).not.toHaveBeenCalled();
  });

  it("never sends a failing PHRS action (its value would stay in Multicall3) unless it is dropped", async () => {
    const c = chain({ failing: [0] });
    const s = vi.fn() as unknown as Send;
    const r = await runBatch(c.call, FROM, resolveActions(specs, FROM), { execute: true, dropFailing: false, send: s });
    expect(r.status).toBe("blocked");
    expect(r.blockReason).toMatch(/action 1 would fail and its PHRS would stay stuck in Multicall3/);
    expect(s).not.toHaveBeenCalled();
  });

  it("a mined revert is reported as reverted", async () => {
    const c = chain();
    const s: Send = async () => ({ tx: `0x${"cd".repeat(32)}` as Hex, status: "reverted", block: "9", gasUsed: 1n });
    expect((await runBatch(c.call, FROM, resolveActions(specs, FROM), { execute: true, dropFailing: false, send: s })).status).toBe("reverted");
  });
});

describe("compare", () => {
  it("reports a negative saving as costing more", () => {
    const sim = { block: "1", gasPriceWei: 1n, batchGas: 100n, actions: [{ aloneGas: 30n }, { aloneGas: 30n }, { aloneGas: undefined }] } as never;
    const c = compare(sim, 100n);
    expect(c).toMatchObject({ comparable: 2, individualGas: 60n, savedGas: -40n, savedPct: "-66.66" });
  });
});

describe("batch-executor CLI", () => {
  const run = async (args: string[]) => {
    const { main } = await import("../tasks/batch-executor/index.js");
    return main({ onExit() {}, signal: new AbortController().signal }, args).then(() => "ok", (e: Error) => e.message);
  };
  it("asks for --plan", async () => {
    expect(await run([])).toContain("--plan <file.json> is required");
  });
  it("refuses a plan with fewer than 3 actions, naming the file", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const f = join(mkdtempSync(join(tmpdir(), "batch-")), "two.json");
    writeFileSync(f, JSON.stringify({ actions: specs.slice(0, 2) }));
    process.env.PRIVATE_KEY ??= "0x" + "11".repeat(32);
    expect(await run(["--plan", f])).toMatch(/two\.json: a batch needs at least 3 independent actions, the plan has 2/);
  });
});
