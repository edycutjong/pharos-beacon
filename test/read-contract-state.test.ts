import { encodeFunctionResult, erc20Abi, getAddress, parseAbi, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ChainToolError } from "../src/lib/mcp.js";
import { formatState, labelsFor, parseHolder, readState, USDC, withCommas, type Call } from "../tasks/read-contract-state/index.js";

const OWNER = "0x9F8Ea09770Dc38fc61f5a62031b3BE0526D54D92" as Hex;
const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0" as Hex;
const ownable = parseAbi(["function owner() view returns (address)", "function paused() view returns (bool)"]);

/** A fake Chain MCP: a 6-decimal token with 40,901,150.791646 supply; `withOwner` toggles owner()/paused(). */
function fake(withOwner: boolean, opts: { ownerHasCode?: boolean; failWith?: Error } = {}) {
  const seen: { tool: string; args: any }[] = [];
  const call = (async (tool: string, args: any) => {
    seen.push({ tool, args });
    if (tool === "get_code") return { code: args.address.toLowerCase() === OWNER.toLowerCase() && opts.ownerHasCode ? "0x6080" : "0x" };
    const sel = args.transaction.data.slice(0, 10);
    const enc = (abi: any, functionName: string, result: unknown) => ({ result: encodeFunctionResult({ abi, functionName, result } as never) });
    const table: Record<string, () => { result: Hex }> = {
      "0x06fdde03": () => enc(erc20Abi, "name", "USDC"),
      "0x95d89b41": () => enc(erc20Abi, "symbol", "USDC"),
      "0x313ce567": () => enc(erc20Abi, "decimals", 6),
      "0x18160ddd": () => enc(erc20Abi, "totalSupply", 40901150791646n),
      "0x70a08231": () => enc(erc20Abi, "balanceOf", args.transaction.data.toLowerCase().includes(WPROS.slice(2)) ? 807275n : 0n),
      "0x8da5cb5b": () => {
        if (opts.failWith) throw opts.failWith;
        if (!withOwner) throw new ChainToolError("eth_call", "execution reverted", 3);
        return enc(ownable, "owner", OWNER);
      },
      "0x5c975abb": () => (withOwner ? enc(ownable, "paused", false) : (() => { throw new ChainToolError("eth_call", "execution reverted", 3); })()),
    };
    const fn = table[sel];
    if (!fn) throw new Error(`unexpected selector ${sel}`);
    return fn();
  }) as unknown as Call;
  return { call, seen };
}

describe("read-contract-state", () => {
  const holders = [{ address: getAddress(USDC) }, { address: getAddress(WPROS) }];

  it("reads name, symbol, decimals, totalSupply and balances, all pinned to one block, with decimals applied", async () => {
    const { call, seen } = fake(true);
    const s = await readState(call, getAddress(USDC), 123n, holders);
    expect(s).toMatchObject({ block: "123", name: "USDC", symbol: "USDC", decimals: 6, totalSupplyRaw: "40901150791646", totalSupply: "40901150.791646", paused: false });
    expect(s.holders.map((h) => [h.amount, h.raw])).toEqual([["0", "0"], ["0.807275", "807275"]]);
    expect(seen.filter((c) => c.tool === "eth_call").every((c) => c.args.block === "123")).toBe(true);
    expect(seen.filter((c) => c.tool === "get_code").every((c) => c.args.block === "123")).toBe(true);
  });
  it("labels addresses: registry tokens, the contract itself, an explicit label, and wallet-vs-contract for the rest", async () => {
    const s = await readState(fake(true).call, getAddress(USDC), 1n, [...holders, { address: getAddress(OWNER), label: "Team multisig" }]);
    expect(s.holders.map((h) => h.label)).toEqual(["USDC token contract (this contract)", "WPROS token contract", "Team multisig"]);
    expect(s.owner).toEqual({ address: OWNER, label: "unlabelled wallet (no code)" });
    expect((await readState(fake(true, { ownerHasCode: true }).call, getAddress(USDC), 1n, [])).owner!.label).toBe("unlabelled contract (has code)");
  });
  it("reports a missing owner()/paused() as none, but not a transport failure", async () => {
    const s = await readState(fake(false).call, getAddress(USDC), 1n, []);
    expect(s).toMatchObject({ owner: null, paused: null });
    await expect(readState(fake(true, { failWith: new Error("socket hang up") }).call, getAddress(USDC), 1n, [])).rejects.toThrow("socket hang up");
  });
  it("fails clearly when the address is not a token", async () => {
    const call = vi.fn(async () => ({ result: "0x" })) as unknown as Call;
    await expect(readState(call, getAddress(USDC), 5n, [])).rejects.toThrow(/returned no data: not a token contract at block 5/);
  });
  it("formats the report with the address, the block, applied decimals and labelled addresses", async () => {
    const text = formatState(await readState(fake(true).call, getAddress(USDC), 20453295n, holders));
    expect(text).toContain("Contract  0xC879C018dB60520F4355C26eD1a6D572cdAC1815  (USDC)");
    expect(text).toContain("block 20453295 on Pharos mainnet (chain 1672)");
    expect(text).toContain("totalSupply  40,901,150.791646 USDC   (raw 40901150791646)");
    expect(text).toContain("balance      0.807275 USDC   held by 0x52C48d4213107b20bC583832b0d951FB9CA8F0B0  [WPROS token contract]");
    expect(text).toContain("paused       no");
    expect(formatState(await readState(fake(false).call, getAddress(USDC), 1n, []))).toContain("none: this contract has no owner() view");
  });
  it("groups digits and parses --holder", () => {
    expect([withCommas("0"), withCommas("1234"), withCommas("1234567.123456"), withCommas("999")]).toEqual(["0", "1,234", "1,234,567.123456", "999"]);
    expect(parseHolder(`${OWNER.toLowerCase()}=A=B`)).toEqual({ address: OWNER, label: "A=B" });
    expect(() => parseHolder("0x12")).toThrow(/address/);
    expect(labelsFor(getAddress(USDC), "USDC")[USDC.toLowerCase()]).toContain("this contract");
  });
});
