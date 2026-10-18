import { encodeFunctionResult, erc20Abi, parseAbi, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/lib/cli.js";
import { ChainToolError } from "../src/lib/mcp.js";
import type { DocsClient } from "../src/lib/docs-mcp.js";
import { excerptFor, explain, format, interpret, main, readOnChain, run, slug, type Call, type Target } from "../tasks/docs-chain-mcp-agent/index.js";

const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815" as Hex;
const HOLDER = "0x94807fE4300D15909C1a4fd39f76c61D68aee11E" as Hex;
const REGISTRY_PAGE = `# Token Registry\n\nUSDC ${USDC}\nWPROS 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0`;
const BALANCE_ANSWER =
  "`balanceOf(address)` reads the token balance for the supplied address.\n\n**USDC uses 6 decimals**, so divide the raw result by `1,000,000`.\n\n```bash\ncast call ... \"balanceOf(address)(uint256)\"\n```\n\n# Sources\n\n- [Token Registry](https://docs.pharos.xyz/getting-started/token-registry)\n- [First Token](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token)";
const REFUSAL = "The registry lists WPROS, but **does not** explain what totalSupply does, so I can't confirm it.\n\n# Sources\n\n- [Token Registry](https://docs.pharos.xyz/getting-started/token-registry)";

/** A fake Docs MCP: `answers` by function name, `pages` by URL. */
function fakeDocs(answers: Record<string, string>, pages: Record<string, string>) {
  const calls: string[] = [];
  const client: DocsClient & { close(): Promise<void> } = {
    callTool: (async (p: { name: string; arguments: any }) => {
      calls.push(p.name);
      if (p.name === "getPage") {
        const text = pages[p.arguments.url];
        if (text === undefined) throw new Error("404");
        return { content: [{ type: "text", text }] };
      }
      const fn = Object.keys(answers).find((k) => p.arguments.question.includes(`${k}(`));
      return { content: [{ type: "text", text: fn ? answers[fn]! : "I cannot find information about this in the docs." }] };
    }) as never,
    listTools: (async () => ({ tools: [] })) as never,
    close: async () => {},
  };
  return { client, calls };
}
const PAGES = {
  "https://docs.pharos.xyz/getting-started/token-registry": REGISTRY_PAGE,
  "https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token": "function balanceOf(address owner) and decimals()",
};

const word = (v: bigint) => encodeFunctionResult({ abi: parseAbi(["function f() view returns (uint256)"]), functionName: "f", result: v });
function fakeChain() {
  const seen: { tool: string; args: any }[] = [];
  const call = (async (tool: string, args: any) => {
    seen.push({ tool, args });
    if (tool === "get_block_number") return { blockNumber: "100" };
    if (tool === "get_logs") return [];
    const sel = args.transaction.data.slice(0, 10);
    const enc = (functionName: any, result: unknown) => ({ result: encodeFunctionResult({ abi: erc20Abi, functionName, result } as never) });
    if (sel === "0x313ce567") return enc("decimals", 6);
    if (sel === "0x95d89b41") return enc("symbol", "USDC");
    if (sel === "0x70a08231") return enc("balanceOf", 26001969072n);
    if (sel === "0x18160ddd") return enc("totalSupply", 5n);
    if (sel === "0x3408e470") return { result: word(1672n) };
    throw new Error(`unexpected selector ${sel}`);
  }) as unknown as Call;
  return { call, seen };
}

const balanceTarget: Target = { contract: USDC, label: "USDC (Circle-deployed)", fn: "balanceOf", holder: HOLDER, holderLabel: "a recent holder" };
afterEach(() => vi.restoreAllMocks());

describe("excerptFor", () => {
  it("keeps the sentences that name the function (and decimals for balanceOf), without code blocks or markdown", () => {
    const ex = excerptFor(BALANCE_ANSWER.split("# Sources")[0]!, "balanceOf");
    expect(ex).toEqual(["balanceOf(address) reads the token balance for the supplied address.", "USDC uses 6 decimals, so divide the raw result by 1,000,000."]);
  });
  it("returns nothing for a refusal and for an answer that never names the function", () => {
    expect(excerptFor(REFUSAL, "totalSupply")).toEqual([]);
    expect(excerptFor("Tokens have a supply.", "totalSupply")).toEqual([]);
    expect(excerptFor("The docs don't describe decimals() for this token.", "decimals")).toEqual([]);
  });
});

describe("explain", () => {
  it("is documented only when a cited page names the function, and says which page", async () => {
    const f = fakeDocs({ balanceOf: BALANCE_ANSWER }, PAGES);
    const e = await explain(f.client, balanceTarget, { text: REGISTRY_PAGE });
    expect(e.documented).toBe(true);
    expect(e.groundedIn).toEqual(["https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token"]);
    expect(e.listedInDocs).toBe(true);
    expect(e.sources.map((s) => s.title)).toEqual(["Token Registry", "First Token"]);
  });
  it("an answer no cited page backs is not an explanation", async () => {
    const f = fakeDocs({ balanceOf: BALANCE_ANSWER }, { "https://docs.pharos.xyz/getting-started/token-registry": REGISTRY_PAGE, "https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token": "nothing relevant" });
    const e = await explain(f.client, balanceTarget, { text: REGISTRY_PAGE });
    expect(e.documented).toBe(false);
    expect(e.excerpt).toEqual([]);
  });
  it("a failed docs call is reported, not hidden, and unlisted addresses are flagged", async () => {
    const client = { callTool: async () => { throw new Error("boom"); }, listTools: async () => ({ tools: [] }) } as unknown as DocsClient;
    const e = await explain(client, { ...balanceTarget, contract: "0x0000000000000000000000000000000000000001" }, { text: REGISTRY_PAGE });
    expect(e.documented).toBe(false);
    expect(e.error).toMatch(/boom/);
    expect(e.listedInDocs).toBe(false);
    expect((await explain(client, balanceTarget, { text: null })).listedInDocs).toBeNull();
  });
});

describe("run + interpret", () => {
  it("explains first, calls the same function second, and applies the decimals only for a documented function", async () => {
    const docs = fakeDocs({ balanceOf: BALANCE_ANSWER, totalSupply: REFUSAL }, PAGES);
    const chain = fakeChain();
    const steps = await run(docs.client, chain.call, [balanceTarget, { contract: USDC, label: "USDC", fn: "totalSupply" }], 100n);
    expect(docs.calls.indexOf("askQuestion")).toBeLessThan(chain.seen.findIndex((c) => c.tool === "eth_call") + docs.calls.length);
    expect(steps[0]!.interpretation).toContain("26,001.969072 USDC");
    expect(steps[0]!.interpretation).toContain("divide the raw result by 1,000,000");
    expect(steps[1]!.docs.documented).toBe(false);
    expect(steps[1]!.chain).toEqual({ block: "100", raw: "5" });
    expect(steps[1]!.interpretation).toBe("The docs do not describe totalSupply(), so there is no explanation to read this against and no unit is applied. Raw result: 5.");
    // every eth_call is pinned to the one block
    expect(chain.seen.filter((c) => c.tool === "eth_call").every((c) => c.args.block === "100")).toBe(true);
  });
  it("interprets decimals and getChainId", () => {
    const e = { question: "", documented: true, excerpt: ["decimals() reports precision."], sources: [], listedInDocs: true, groundedIn: ["u"] };
    expect(interpret({ contract: USDC, label: "x", fn: "decimals" }, e, { block: "1", raw: "6" })).toContain("10^6");
    expect(interpret({ contract: USDC, label: "x", fn: "getChainId" }, e, { block: "1", raw: "1672" })).toContain("1672");
  });
  it("formats the three steps and the page the check used", async () => {
    const docs = fakeDocs({ balanceOf: BALANCE_ANSWER }, PAGES);
    const steps = await run(docs.client, fakeChain().call, [balanceTarget], 100n);
    const text = format(steps, "100");
    expect(text).toMatch(/1\. Docs MCP \(askQuestion\)/);
    expect(text).toMatch(/2\. Chain MCP \(eth_call @ 100\): 26001969072/);
    expect(text).toMatch(/3\. Reading:/);
    expect(text).toContain("balanceOf(address) is named on https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token");
    expect(slug(balanceTarget)).toBe("usdc-balanceof");
  });
});

describe("units are optional", () => {
  it("a token without decimals() still gets its raw balance, not a crash", async () => {
    const base = fakeChain().call;
    const call = (async (tool: string, args: any) => {
      if (tool === "eth_call" && args.transaction.data.startsWith("0x313ce567")) throw new ChainToolError("eth_call", "execution reverted", 3);
      return base(tool as never, args);
    }) as unknown as Call;
    const e = { question: "", documented: true, excerpt: ["balanceOf(address) reads the balance."], sources: [], listedInDocs: true, groundedIn: ["u"] };
    const r = await readOnChain(call, balanceTarget, 100n, true);
    expect(r).toEqual({ block: "100", raw: "26001969072" });
    expect(interpret(balanceTarget, e, r)).toContain("Raw balance 26001969072 base units.");
  });
});

describe("main", () => {
  const ctx = { onExit() {}, signal: new AbortController().signal };
  const connect = (chain = fakeChain()) => async () => ({ call: chain.call, close: async () => {}, endpoint: "https://mcp.pharos.xyz/mcp", network: "pharos" as const, chainId: 1672, server: undefined });
  const out = async (argv: string[], docs = fakeDocs({ balanceOf: BALANCE_ANSWER, decimals: BALANCE_ANSWER }, PAGES)) => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    const code = await main(ctx, argv, connect(), async () => docs.client);
    return { code, text: lines.join("\n") };
  };
  it("runs one function for any contract", async () => {
    const r = await out(["--contract", USDC, "--function", "balanceOf", "--arg", HOLDER]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("USDC (Circle-deployed) · balanceOf(address)");
    expect(r.text).toContain("26,001.969072 USDC");
  });
  it("--json prints the structured steps", async () => {
    const r = await out(["--contract", USDC, "--function", "decimals", "--json"]);
    expect(JSON.parse(r.text.split("\n\nvia")[0]!).steps[0].chain.raw).toBe("6");
  });
  it("rejects bad flags with a usage error", async () => {
    for (const argv of [["--contract", USDC], ["--function", "decimals"], ["--contract", "nope", "--function", "decimals"], ["--contract", USDC, "--function", "burn"], ["--contract", USDC, "--function", "balanceOf"], ["--contract", USDC, "--function", "decimals", "--arg", HOLDER], ["--block", "x"], ["--block", "999999"]]) {
      await expect(out(argv), argv.join(" ")).rejects.toBeInstanceOf(UsageError);
    }
  });
});
