import { encodeAbiParameters, encodeErrorResult, encodeFunctionData, encodeFunctionResult, erc20Abi, parseAbi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ChainToolError } from "../src/lib/mcp.js";
import { diagnose, ERRORS_ABI, formatDiagnosis, type Call } from "../tasks/dapp-support-agent/diagnose.js";
import { main } from "../tasks/dapp-support-agent/index.js";

const HASH = `0x${"11".repeat(32)}` as Hex;
const ME = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975" as Hex;
const OWNER = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B" as Hex;
const TOKEN = "0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8" as Hex;
const weth = parseAbi(["function withdraw(uint256)"]);

const revertWith = (data: Hex) => new ChainToolError("eth_call", "execution reverted", 3, data);

interface Setup {
  input?: Hex;
  status?: "0x0" | "0x1";
  gas?: bigint;
  gasUsed?: bigint;
  replay?: Error | null; // null = the replay succeeds
  estimate?: Error | bigint;
  balance?: bigint;
  allowance?: bigint;
  token?: boolean;
  tx?: null;
  receipt?: null;
}
/** A fake Chain MCP: a 6-decimal USDC token at TOKEN, one transaction at block 100. */
function fake(o: Setup = {}) {
  const gas = o.gas ?? 100_000n;
  const seen: { tool: string; args: any }[] = [];
  const call = (async (tool: string, args: any) => {
    seen.push({ tool, args });
    if (tool === "get_transaction") return o.tx === null ? null : { hash: HASH, from: ME, to: TOKEN, input: o.input ?? "0x", value: "0x0", gas: `0x${gas.toString(16)}` };
    if (tool === "get_transaction_receipt") return o.receipt === null ? null : { blockNumber: "0x64", status: o.status ?? "0x0", gasUsed: `0x${(o.gasUsed ?? 25_000n).toString(16)}` };
    if (tool === "estimate_gas") {
      if (typeof o.estimate === "bigint") return { gas: o.estimate.toString() };
      throw o.estimate ?? new Error("no estimate");
    }
    if (tool !== "eth_call") throw new Error(`unexpected ${tool}`);
    const data: Hex = args.transaction.data ?? "0x";
    if (args.transaction.gas) {
      if (o.replay === null) return { result: "0x" };
      throw o.replay ?? revertWith("0x");
    }
    const enc = (functionName: any, result: unknown) => ({ result: encodeFunctionResult({ abi: erc20Abi, functionName, result } as never) });
    if (data === encodeFunctionData({ abi: erc20Abi, functionName: "symbol" })) return o.token === false ? { result: "0x" } : enc("symbol", "USDC");
    if (data === encodeFunctionData({ abi: erc20Abi, functionName: "decimals" })) return o.token === false ? { result: "0x" } : enc("decimals", 6);
    if (data.startsWith("0x70a08231")) return enc("balanceOf", o.balance ?? 0n);
    if (data.startsWith("0xdd62ed3e")) return enc("allowance", o.allowance ?? 0n);
    throw new Error(`unexpected call ${data.slice(0, 10)}`);
  }) as unknown as Call;
  return { call, seen };
}
const err = (errorName: string, args: unknown[]) => revertWith(encodeErrorResult({ abi: ERRORS_ABI, errorName, args } as never));

describe("dapp-support-agent", () => {
  it("says a successful transaction did not fail", async () => {
    const d = await diagnose(fake({ status: "0x1" }).call, HASH);
    expect(d).toMatchObject({ outcome: "succeeded", cause: "succeeded", headline: "This transaction did not fail." });
  });
  it("handles an unknown hash and a pending transaction", async () => {
    expect(await diagnose(fake({ tx: null }).call, HASH)).toMatchObject({ outcome: "not-found", cause: "not-found" });
    expect(await diagnose(fake({ receipt: null }).call, HASH)).toMatchObject({ outcome: "pending", cause: "pending" });
  });
  it("insufficient balance: decodes the token error, applies decimals, replays at the block before", async () => {
    const f = fake({ replay: err("ERC20InsufficientBalance", [ME, 0n, 1_000_000_000_000_000n]) });
    const d = await diagnose(f.call, HASH);
    expect(d).toMatchObject({ outcome: "failed", cause: "insufficient-balance" });
    expect(d.headline).toBe("Your wallet does not hold enough USDC: it has 0 USDC and the transaction needed 1,000,000,000 USDC.");
    expect(d.fix[0]).toContain("holds no USDC: add at least 1,000,000,000 USDC before trying to send that much.");
    const replay = f.seen.find((s) => s.tool === "eth_call" && s.args.transaction.gas);
    expect(replay!.args.block).toBe("99");
    expect(replay!.args.transaction).toMatchObject({ from: ME, to: TOKEN, gas: "0x186a0" });
  });
  it("insufficient balance, wallet has some: tells how much to send or add", async () => {
    const d = await diagnose(fake({ replay: err("ERC20InsufficientBalance", [OWNER, 2_500_000n, 10_000_000n]) }).call, HASH);
    expect(d.headline).toContain("Wallet 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B does not hold enough USDC");
    expect(d.fix[0]).toBe("Send at most 2.5 USDC, or first add at least 7.5 USDC to wallet 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B.");
  });
  it("insufficient allowance: names the spender, the allowance and the approve fix", async () => {
    const d = await diagnose(fake({ replay: err("ERC20InsufficientAllowance", [ME, 0n, 1n]) }).call, HASH);
    expect(d.cause).toBe("insufficient-allowance");
    expect(d.fix[0]).toContain(`approve(${ME}, 0.000001 USDC or more)`);
  });
  it("amounts stay in raw units when the target is not a token", async () => {
    const d = await diagnose(fake({ token: false, replay: err("ERC20InsufficientBalance", [ME, 5n, 7n]) }).call, HASH);
    expect(d.headline).toContain("it has 5 (raw units) and the transaction needed 7 (raw units)");
  });
  it("revert reason string", async () => {
    const d = await diagnose(fake({ replay: revertWith(encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["Sale closed"] })) }).call, HASH);
    expect(d).toMatchObject({ cause: "revert-reason" });
    expect(d.headline).toContain('"Sale closed"');
  });
  it("panic code, access control and pause errors", async () => {
    const panic = revertWith(encodeAbiParameters([{ type: "uint256" }], [0x11n]).replace("0x", "0x4e487b71") as Hex);
    expect(await diagnose(fake({ replay: panic }).call, HASH)).toMatchObject({ cause: "panic" });
    expect((await diagnose(fake({ replay: err("OwnableUnauthorizedAccount", [ME]) }).call, HASH)).headline).toContain("not allowed");
    expect((await diagnose(fake({ replay: err("EnforcedPause", []) }).call, HASH)).headline).toBe("The contract is paused.");
  });
  it("a revert with an unknown selector is reported as unknown, with the selector", async () => {
    const d = await diagnose(fake({ replay: revertWith("0xdeadbeef00") }).call, HASH);
    expect(d.cause).toBe("unknown-error");
    expect(d.why).toContain("0xdeadbeef");
  });
  it("out of gas: replay says so; the fix uses estimate_gas with a 25% margin", async () => {
    const d = await diagnose(fake({ gas: 24_000n, gasUsed: 24_000n, replay: new ChainToolError("eth_call", "The execution has run out of gas.", -32015), estimate: 37_096n }).call, HASH);
    expect(d.cause).toBe("out-of-gas");
    expect(d.fix[0]).toContain("at least 46,370");
    expect(d.headline).toContain("24,000 units");
  });
  it("out of gas, but the call would also revert: says both", async () => {
    const d = await diagnose(fake({ gas: 24_000n, gasUsed: 24_000n, replay: new ChainToolError("eth_call", "out of gas", -32015), estimate: err("EnforcedPause", []) }).call, HASH);
    expect(d.cause).toBe("out-of-gas");
    expect(d.why).toContain("it would still fail");
    expect(d.fix.join(" ")).toContain("The contract is paused");
  });
  it("gas fully used while the replay succeeds is still out of gas", async () => {
    const d = await diagnose(fake({ gas: 30_000n, gasUsed: 30_000n, replay: null, estimate: new Error("x") }).call, HASH);
    expect(d.cause).toBe("out-of-gas");
    expect(d.evidence).toContain("the call used its whole gas limit");
  });
  it("empty revert on withdraw(uint256) with too little balance: inferred, and labelled as inferred", async () => {
    const input = encodeFunctionData({ abi: weth, functionName: "withdraw", args: [10n ** 24n] });
    const d = await diagnose(fake({ input, balance: 2_200_000n }).call, HASH);
    expect(d).toMatchObject({ cause: "insufficient-balance", facts: expect.objectContaining({ inferred: true }) });
    expect(d.why).toContain("inferred from the balance, not reported by the contract");
  });
  it("empty revert on transferFrom with enough balance but no allowance: insufficient-allowance (inferred)", async () => {
    const input = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [OWNER, ME, 5n] });
    const d = await diagnose(fake({ input, balance: 10n, allowance: 1n }).call, HASH);
    expect(d.cause).toBe("insufficient-allowance");
    expect(d.why).toContain("inferred from the allowance");
  });
  it("empty revert with nothing to infer says so plainly and never invents a cause", async () => {
    const d = await diagnose(fake({ input: "0x12345678" }).call, HASH);
    expect(d.cause).toBe("empty-revert");
    expect(d.headline).toBe("The contract refused the transaction without saying why.");
    const withBalance = await diagnose(fake({ input: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [OWNER, 5n] }), balance: 10n }).call, HASH);
    expect(withBalance.cause).toBe("empty-revert"); // enough balance: the inference does not fire
  });
  it("a failure the replay cannot reproduce is reported as such", async () => {
    const d = await diagnose(fake({ replay: null, gasUsed: 25_000n }).call, HASH);
    expect(d.cause).toBe("not-reproduced");
  });
  it("an unclassified replay error is passed on, not guessed", async () => {
    const d = await diagnose(fake({ replay: new ChainToolError("eth_call", "invalid opcode", -32000) }).call, HASH);
    expect(d).toMatchObject({ cause: "unknown-error" });
    expect(d.why).toContain("invalid opcode");
  });
  it("a network failure is an error, not a diagnosis", async () => {
    await expect(diagnose(fake({ replay: new Error("socket hang up") }).call, HASH)).rejects.toThrow("socket hang up");
  });
  it("formats a report with the sections a person reads", async () => {
    const text = formatDiagnosis(await diagnose(fake({ replay: err("EnforcedPause", []) }).call, HASH), { label: "atlantic", explorer: "https://x" });
    for (const h of ["Result       FAILED", "What happened", "Why", "What you can do", "Evidence (for the curious)", `https://x/tx/${HASH}`]) expect(text).toContain(h);
  });
});

describe("dapp-support-agent CLI", () => {
  const ctx = { onExit: () => {}, signal: new AbortController().signal };
  const run = async (argv: string[], f = fake({ replay: err("EnforcedPause", []) })) => {
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      const code = await main(ctx, argv, async (network) => ({ call: f.call, close: async () => {}, endpoint: "fake", network, chainId: 1, server: undefined }));
      return { code, out: out.join("\n") };
    } finally {
      console.log = log;
    }
  };
  it("prints the report for a hash, and JSON with --json", async () => {
    expect((await run([HASH])).out).toContain("The contract is paused.");
    expect(JSON.parse((await run([HASH, "--json"])).out)).toMatchObject({ hash: HASH, cause: "known-error" });
  });
  it("rejects a malformed hash, a missing hash, an unknown network and a bad proof label", async () => {
    await expect(run(["0x1234"])).rejects.toThrow("0x followed by 64 hex characters");
    await expect(run([])).rejects.toThrow("expected 1 argument");
    await expect(run([HASH, "--network", "mars"])).rejects.toThrow();
    await expect(run([HASH, "--proof", "../x"])).rejects.toThrow("--proof label");
  });
});
