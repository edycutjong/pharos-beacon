import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_NOT_FOUND, format, isGoodAnswer, main, search } from "../tasks/doc-search-cli/index.js";
import type { DocsClient } from "../src/lib/docs-mcp.js";

// Reply shapes recorded from the live Docs MCP (2026-10-18).
const GOOD =
  "The Atlantic Testnet chain ID is **688689**. See [Atlantic Testnet](/getting-started/network/atlantic-testnet).\n\n# Sources\n\n- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)\n- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)\n- [Gas Model](https://docs.pharos.xyz/getting-started/gas-model)";
const NONE = "I cannot find information about this in the docs.";
const HITS = ["Title: Solidity\nLink: https://docs.pharos.xyz/resources/solidity\nContent: x", "Title: Gas Model\nLink: https://docs.pharos.xyz/getting-started/gas-model"];

type Reply = string[] | Error;
function fake(ask: Reply, search: Reply = HITS) {
  const calls: string[] = [];
  const client: DocsClient & { close(): Promise<void> } = {
    callTool: (async (p: { name: string }) => {
      calls.push(p.name);
      const r = p.name === "askQuestion" ? ask : search;
      if (r instanceof Error) throw r;
      return { content: r.map((text) => ({ type: "text", text })) };
    }) as never,
    listTools: (async () => ({ tools: [] })) as never,
    close: async () => {},
  };
  return { client, calls };
}

const run = async (argv: string[], f: ReturnType<typeof fake>) => {
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
  try {
    const code = await main({ onExit() {}, signal: new AbortController().signal }, argv, async () => f.client);
    return { code, out: out.join("\n") };
  } finally {
    log.mockRestore();
  }
};
afterEach(() => vi.restoreAllMocks());

describe("isGoodAnswer", () => {
  it("needs a source and a reply that does not say it found nothing", () => {
    expect(isGoodAnswer("Chain ID is 688689.", [{}])).toBe(true);
    expect(isGoodAnswer("Chain ID is 688689.", [])).toBe(false);
    expect(isGoodAnswer(NONE, [{}])).toBe(false);
    expect(isGoodAnswer("The docs do not mention that, and I couldn't find it.", [{}])).toBe(false);
  });
});

describe("search", () => {
  it("returns the answer with de-duplicated sources and does not search", async () => {
    const f = fake([GOOD]);
    const r = await search(f.client, "chain id?");
    expect(r.found).toBe(true);
    expect(r.sources.map((s) => s.title)).toEqual(["Atlantic Testnet", "Gas Model"]);
    expect(f.calls).toEqual(["askQuestion"]);
  });
  it("off-topic: no answer is invented, the closest pages come from searchDocumentation", async () => {
    const f = fake([NONE]);
    const r = await search(f.client, "best pizza in Naples?");
    expect(r).toMatchObject({ found: false, sources: [], closest: [{ title: "Solidity" }, { title: "Gas Model" }] });
    expect(f.calls).toEqual(["askQuestion", "searchDocumentation"]);
  });
  it("when askQuestion fails, says so and still lists the closest pages", async () => {
    const r = await search(fake(new Error("boom"), HITS).client, "q");
    expect(r.found).toBe(false);
    expect(r.askError).toBe("boom");
    expect(r.closest).toHaveLength(2);
  });
  it("when both calls fail, reports a failure and no pages", async () => {
    const r = await search(fake(new Error("a"), new Error("b")).client, "q");
    expect(r).toMatchObject({ found: false, closest: [], askError: "a" });
  });
});

describe("format", () => {
  it("makes relative doc links clickable and caps the source list", async () => {
    const r = await search(fake([GOOD]).client, "q");
    const text = format(r, 1);
    expect(text).toContain("](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)");
    expect(text).toContain("  - Atlantic Testnet: https://docs.pharos.xyz/getting-started/network/atlantic-testnet");
    expect(text).toContain("(+1 more cited by the docs; use --sources 2 to list them)");
    expect(text).not.toContain("Gas Model:");
  });
  it("not found says so plainly and never prints the model's text as an answer", async () => {
    const text = format(await search(fake([NONE]).client, "q"));
    expect(text).toMatch(/^Not found in the Pharos docs/);
    expect(text).not.toContain("I cannot find");
  });
});

describe("main", () => {
  it("joins unquoted words into one question and exits 0 on an answer", async () => {
    const f = fake([GOOD]);
    const spy = vi.spyOn(f.client, "callTool");
    const { code, out } = await run(["what", "is", "the", "chain", "id"], f);
    expect(code).toBe(0);
    expect(out).toContain("688689");
    expect(spy.mock.calls[0][0].arguments?.question).toBe("what is the chain id");
  });
  it("exits 3 when the docs have no answer", async () => {
    expect((await run(["best pizza in Naples?"], fake([NONE]))).code).toBe(EXIT_NOT_FOUND);
  });
  it("--json prints the structured result", async () => {
    const { out } = await run(["q", "--json"], fake([GOOD]));
    expect(JSON.parse(out)).toMatchObject({ question: "q", found: true });
  });
  it("rejects an empty question and a bad --sources with a usage error", async () => {
    await expect(run([], fake([GOOD]))).rejects.toThrow(/usage/);
    await expect(run(["q", "--sources", "0"], fake([GOOD]))).rejects.toThrow(/--sources/);
  });
});
