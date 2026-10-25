import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, parseUnits, type Hex } from "viem";
import { geminiJson } from "../src/pay/llm.js";
import { parseAmount, parseRules, parseWithLlm } from "../src/pay/parse.js";
import { preparePayment } from "../src/pay/prepare.js";
import { main as nlMain } from "../tasks/natural-language-payment-agent/index.js";

const FROM = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975" as Hex;
const TO = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B";
const WPHRS = "0x838800b758277CC111B2d48Ab01e5E164f8E9471";
const ctx = { onExit() {}, signal: new AbortController().signal };

/** A fake Chain MCP: balances in wei / base units, decimals per token. */
function fakeCall(o: { phrs?: bigint; token?: bigint; decimals?: number; estimateFails?: boolean } = {}) {
  const calls: string[] = [];
  const call = (async (tool: string, args: any) => {
    calls.push(tool);
    switch (tool) {
      case "get_balance": return { balanceWei: String(o.phrs ?? parseUnits("10", 18)) };
      case "eth_call": {
        const data: string = args.transaction.data;
        if (data.startsWith("0x313ce567")) return { result: `0x${BigInt(o.decimals ?? 18).toString(16).padStart(64, "0")}` };
        return { result: `0x${(o.token ?? parseUnits("5", 18)).toString(16).padStart(64, "0")}` };
      }
      case "get_transaction_count": return { nonce: "7" };
      case "estimate_gas": if (o.estimateFails) throw new Error("revert"); return { gas: "21000" };
      case "get_block": return { baseFeePerGas: "0x3b9aca00" };
      case "get_gas_price": return { maxPriorityFeePerGasWei: "0" };
    }
    throw new Error(`unexpected ${tool}`);
  }) as any;
  return { call, calls };
}

describe("parseAmount", () => {
  it("reads both decimal conventions and refuses the ambiguous one", () => {
    expect(parseAmount("0.5")).toEqual({ value: "0.5" });
    expect(parseAmount("0,5")).toEqual({ value: "0.5" });
    expect(parseAmount("1,234.56")).toEqual({ value: "1234.56" });
    expect(parseAmount("1.234,56")).toEqual({ value: "1234.56" });
    expect(parseAmount("1.000.000")).toEqual({ value: "1000000" });
    expect(parseAmount("1.000")).toMatchObject({ ask: "thousands-or-decimal" });
    expect(parseAmount("1,000")).toMatchObject({ ask: "thousands-or-decimal" });
    expect(parseAmount("0.001")).toEqual({ value: "0.001" });
    expect(parseAmount("abc")).toBeUndefined();
  });
});

describe("parseRules", () => {
  it("parses English and Bahasa", () => {
    expect(parseRules([`send 0.01 PHRS to ${TO}`])).toMatchObject({ draft: { amount: "0.01", token: "PHRS", recipient: TO }, questions: [], lang: "en" });
    expect(parseRules([`kirim 0,5 usdc ke ${TO}`])).toMatchObject({ draft: { amount: "0.5", token: "USDC", recipient: TO }, questions: [], lang: "id" });
  });
  it("asks instead of guessing", () => {
    expect(parseRules([`send 100 to ${TO}`]).questions).toHaveLength(1);
    expect(parseRules([`send 100 to ${TO}`]).questions[0]).toMatch(/Which token/);
    expect(parseRules([`send 50 dollars to ${TO}`]).questions[0]).toMatch(/USDC or USDT/);
    expect(parseRules(["send USDC"]).questions).toHaveLength(2);
    expect(parseRules([`kirim 1.000 USDC ke ${TO}`]).questions[0]).toMatch(/seribu atau satu koma nol/);
    expect(parseRules([`send 1,000 USDC to ${TO}`]).questions[0]).toMatch(/one thousand or one point zero/);
    expect(parseRules([`send 5 USDC to ${TO} and 7 USDT to ${FROM}`]).questions.join()).toMatch(/more than one payment/);
  });
  it("asks instead of misreading glued or signed numbers", () => {
    for (const x of ["1e3 PHRS", "1 500 PHRS", "-5 PHRS"]) expect(parseRules([`send ${x} to ${TO}`]).questions.length, x).toBeGreaterThan(0);
  });
  it("fills the gap from a follow-up turn", () => {
    expect(parseRules([`send 100 to ${TO}`, "USDC"])).toMatchObject({ draft: { amount: "100", token: "USDC", recipient: TO }, questions: [] });
  });
});

describe("parseWithLlm: the model proposes, code disposes", () => {
  const llm = (json: unknown) => async () => ({ json, model: "fake" });
  it("accepts what the text supports", async () => {
    const p = await parseWithLlm([`pay ${TO} 0.01 phrs`], llm({ amount: "0.01", token: "PHRS", recipient: TO }));
    expect(p).toMatchObject({ draft: { amount: "0.01", token: "PHRS", recipient: TO }, questions: [], parser: "fake" });
  });
  it("drops a recipient the user never typed", async () => {
    const p = await parseWithLlm(["send 5 USDC to my landlord"], llm({ amount: "5", token: "USDC", recipient: FROM }));
    expect(p.draft.recipient).toBeUndefined();
    expect(p.questions.join()).toMatch(/Which address/);
  });
  it("does not let the model turn 1.000 into 1000", async () => {
    const p = await parseWithLlm([`send 1.000 USDC to ${TO}`], llm({ amount: "1000", token: "USDC", recipient: TO }));
    expect(p.draft.amount).toBeUndefined();
    expect(p.questions.join()).toMatch(/1\.000/);
  });
  it("drops an amount the rules cannot find in the text, and will not swap the token", async () => {
    const a = await parseWithLlm([`send some PHRS to ${TO}`], llm({ amount: "100", token: "PHRS", recipient: TO }));
    expect(a.draft.amount).toBeUndefined();
    expect(a.questions.join()).toMatch(/How much/);
    const b = await parseWithLlm([`send 5 USDC to ${TO}, I hold PHRS`], llm({ amount: "5", token: "PHRS", recipient: TO }));
    expect(b.draft.token).toBe("USDC");
  });
  it("keeps an unknown token so validation can name it", async () => {
    const p = await parseWithLlm([`send 3 DOGE to ${TO}`], llm({ amount: "3", token: "DOGE", recipient: TO }));
    expect(p.draft.token).toBe("DOGE");
  });
});

describe("geminiJson", () => {
  it("is undefined without keys, rotates keys on 503 and parses fenced JSON", async () => {
    expect(geminiJson({ creds: undefined })).toBeUndefined();
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '```json\n{"a":1}\n```' }] } }] }) });
    const llm = geminiJson({ creds: { keys: ["k1", "k2"], model: "m" }, fetchImpl: f as any, sleep: async () => {} })!;
    expect(await llm("s", "u")).toEqual({ json: { a: 1 }, model: "m" });
    expect(f.mock.calls.map((c) => c[1].headers["x-goog-api-key"])).toEqual(["k1", "k2"]);
  });
});

describe("preparePayment", () => {
  it("prepares an unsigned native transfer with a wallet request", async () => {
    const { call } = fakeCall();
    const p = await preparePayment({ amount: "0.01", token: "PHRS", recipient: TO }, { call, from: FROM });
    expect(p.ok).toBe(true);
    expect(p.tx).toMatchObject({ chainId: 688689, to: TO, value: parseUnits("0.01", 18), nonce: 7, gas: 21000n });
    expect(p.walletRequest?.params[0]).toMatchObject({ from: FROM, to: TO, value: "0x2386f26fc10000", type: "0x2" });
    expect(p.summary).toMatch(/UNSIGNED/);
  });
  it("encodes an ERC-20 transfer and appends the reference to the calldata", async () => {
    const { call } = fakeCall();
    const p = await preparePayment({ amount: "0.001", token: "WPHRS", recipient: TO, reference: "NV-17" }, { call, from: FROM });
    const base = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TO as Hex, parseUnits("0.001", 18)] });
    expect(p.tx).toMatchObject({ to: WPHRS, value: 0n });
    expect(p.tx?.data).toBe(`${base}${Buffer.from("NV-17").toString("hex")}`);
  });
  it("puts the reference in native transfer data", async () => {
    const p = await preparePayment({ amount: "0.001", token: "PHRS", recipient: TO, reference: "INV-1" }, { call: fakeCall().call, from: FROM });
    expect(p.tx?.data).toBe(`0x${Buffer.from("INV-1").toString("hex")}`);
  });
  const refuse = async (draft: any, o?: any) => (await preparePayment(draft, { call: fakeCall(o).call, from: FROM })).checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(" | ");
  it("refuses bad recipients", async () => {
    expect(await refuse({ amount: "1", token: "PHRS", recipient: "alice.eth" })).toMatch(/no name service/);
    expect(await refuse({ amount: "1", token: "PHRS", recipient: "0x1234" })).toMatch(/42-character/);
    expect(await refuse({ amount: "1", token: "PHRS", recipient: TO.toLowerCase().replace("8d34", "8D34") })).toMatch(/checksum/);
    expect(await refuse({ amount: "1", token: "PHRS", recipient: FROM })).toMatch(/self-transfer/);
    expect(await refuse({ amount: "1", token: "PHRS", recipient: WPHRS })).toMatch(/token contract/);
    expect(await refuse({ amount: "1", token: "PHRS", recipient: "0x0000000000000000000000000000000000000000" })).toMatch(/zero address/);
  });
  it("refuses unknown tokens, too many decimals and zero", async () => {
    expect(await refuse({ amount: "1", token: "DOGE", recipient: TO })).toMatch(/not in the Atlantic token list/);
    expect(await refuse({ amount: "0.0000001", token: "USDC", recipient: TO }, { decimals: 6 })).toMatch(/more than 6 decimals/);
    expect(await refuse({ amount: "0", token: "PHRS", recipient: TO })).toMatch(/zero/);
  });
  it("refuses when the contract's decimals differ from the list", async () => {
    expect(await refuse({ amount: "1", token: "USDC", recipient: TO }, { decimals: 18 })).toMatch(/list says 6 but the contract answers 18/);
  });
  it("refuses an insufficient balance before estimating gas", async () => {
    const f = fakeCall({ token: 1n });
    const p = await preparePayment({ amount: "5", token: "WPHRS", recipient: TO }, { call: f.call, from: FROM });
    expect(p.ok).toBe(false);
    expect(p.checks.find((c) => c.name === "balance")?.ok).toBe(false);
    expect(f.calls).not.toContain("estimate_gas");
    const native = await refuse({ amount: "20", token: "PHRS", recipient: TO });
    expect(native).toMatch(/balance/);
  });
  it("refuses a reference that is too long", async () => {
    expect(await refuse({ amount: "1", token: "PHRS", recipient: TO, reference: "x".repeat(65) })).toMatch(/limit is 64/);
  });
});

describe("NL CLI (no chain needed for this path)", () => {
  afterEach(() => vi.restoreAllMocks());
  const run = async (fn: () => Promise<number>) => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    const code = await fn();
    return { code, out: out.join("\n") };
  };
  it("NL: asks a follow-up (exit 2) and signs nothing", async () => {
    const r = await run(() => nlMain(ctx, [`send 100 to ${TO}`, "--parser", "rules"]));
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/I need one more thing/);
    expect(r.out).toMatch(/Which token/);
  });
});
