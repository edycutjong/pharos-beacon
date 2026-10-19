// The Docs MCP + Chain MCP Agent demo endpoint: input validation and the streamed explain → call → read, on fake MCPs.
import { encodeFunctionResult, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";
import { handle, jobFor, runDemo, STEP_IDS } from "../tasks/docs-chain-mcp-agent/web.js";

const ANSWER = "`decimals()` returns the number of decimal places USDC uses.\n\n# Sources\n\n- [Guide](https://docs.pharos.xyz/guide)";
function fakes(answer: string) {
  const tools: string[] = [];
  const docs = {
    callTool: (async (p: { name: string; arguments: any }) => {
      tools.push(p.name);
      if (p.name === "getPage") return { content: [{ type: "text", text: p.arguments.url.endsWith("/guide") ? "call decimals() first" : "USDC 0xc879c018db60520f4355c26ed1a6d572cdac1815" }] };
      return { content: [{ type: "text", text: answer }] };
    }) as never,
    listTools: (async () => ({ tools: [] })) as never,
    close: async () => {},
  };
  const chain = {
    endpoint: "fake",
    close: async () => {},
    call: (async (tool: string) => {
      tools.push(tool);
      if (tool === "get_block_number") return { blockNumber: "100" };
      return { result: encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 6 }) };
    }) as never,
  };
  return { deps: { docs: async () => docs, chain: async () => chain }, tools };
}

describe("docs-chain-mcp-agent web", () => {
  it("rejects bad input with a 400", async () => {
    for (const qs of ["action=run&preset=nope", "action=run&contract=0x12&function=decimals", "action=run&contract=0xc879c018db60520f4355c26ed1a6d572cdac1815&function=transfer", "action=run&contract=0xc879c018db60520f4355c26ed1a6d572cdac1815&function=balanceOf", "action=run&contract=0xc879c018db60520f4355c26ed1a6d572cdac1815&function=decimals&arg=0xc879c018db60520f4355c26ed1a6d572cdac1815", "action=x"]) {
      expect((await handle(new Request(`http://x/api/docs-chain-mcp-agent?${qs}`))).status, qs).toBe(400);
    }
  });

  it("a balanceOf preset picks a live holder; a custom balanceOf needs one", () => {
    expect(jobFor(new URLSearchParams("preset=usdc-balanceof"))).toMatchObject({ fn: "balanceOf", findHolder: true });
    expect(jobFor(new URLSearchParams("contract=0xc879c018db60520f4355c26ed1a6d572cdac1815&function=balanceOf&arg=0x94807fE4300D15909C1a4fd39f76c61D68aee11E"))).toMatchObject({ findHolder: false, holder: "0x94807fE4300D15909C1a4fd39f76c61D68aee11E" });
  });

  it("explains from a cited page, then calls the same function, lamps in order", async () => {
    const { deps, tools } = fakes(ANSWER);
    const ev: any[] = [];
    await runDemo((e) => ev.push(e), jobFor(new URLSearchParams("preset=usdc-decimals")), deps as never);
    expect(ev.filter((e) => e.type === "step").map((e) => e.id)).toEqual([...STEP_IDS]);
    expect(tools.indexOf("askQuestion")).toBeLessThan(tools.indexOf("eth_call"));
    expect(ev.at(-1)).toMatchObject({ type: "done", docs: { documented: true }, chain: { raw: "6" } });
  });

  it("an answer no cited page backs is NOT DESCRIBED and the value stays raw", async () => {
    const { deps } = fakes("`decimals()` is six.\n\n# Sources\n\n- [Other](https://docs.pharos.xyz/other)");
    const ev: any[] = [];
    await runDemo((e) => ev.push(e), jobFor(new URLSearchParams("preset=usdc-decimals")), deps as never);
    expect(ev.find((e) => e.id === "ground")).toMatchObject({ state: "refused", label: "NOT DESCRIBED" });
    expect(ev.at(-1).interpretation).toMatch(/do not describe/);
  });
});
