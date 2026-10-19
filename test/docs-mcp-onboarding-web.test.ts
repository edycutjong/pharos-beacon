// The Onboarding demo endpoint (tasks/docs-mcp-onboarding/web.ts): the gap queries are the transcript's, and each gap's
// check says "still a gap" for the answer recorded on 2026-10-18.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { body, GAPS, handle, recheck, sourcesOf } from "../tasks/docs-mcp-onboarding/web.js";

const transcript = readFileSync(new URL("../tasks/docs-mcp-onboarding/proof/transcript.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const recorded = (n: number) => transcript.find((e) => e.n === n);

describe("docs-mcp-onboarding web", () => {
  it("re-asks exactly the queries the gaps were found with", () => {
    expect(GAPS.map((g) => g.gap)).toEqual([1, 2, 3, 4, 5]);
    for (const g of GAPS) expect(recorded(g.n).arguments.question).toBe(g.query);
  });

  it("judges every recorded answer as still a gap", () => {
    for (const g of GAPS) {
      const text = recorded(g.n).content.join("\n");
      expect([g.gap, g.check(body(text), sourcesOf(text))]).toEqual([g.gap, "still a gap"]);
    }
  });

  it("sees a fix when an answer carries one", () => {
    const g = (n: number) => GAPS.find((x) => x.gap === n)!;
    expect(g(2).check("Claim at [Faucet](https://faucet.pharos.xyz/atlantic).", [])).toBe("answered now");
    expect(g(3).check("Download [it](https://github.com/PharosNetwork/pharos-skill-engine/releases).", [])).toBe("answered now");
    expect(g(4).check('"PHAROS_NATIVE_SYMBOL": "PHRS"', [])).toBe("answered now");
    expect(g(4).check("no config here", [])).toBe("unclear");
    expect(g(5).check("* **Currency symbol:** `PHRS`", [])).toBe("answered now");
    expect(g(1).check("I can't confirm what ai.pharos.xyz is: the docs don't identify that domain.", [{ title: "x", url: "https://docs.pharos.xyz/x" }])).toBe("still a gap");
  });

  it("streams one lamp per gap, from a fake Docs MCP", async () => {
    const reply = recorded(3).content;
    const client = async () => ({ listTools: async () => ({ tools: [] }), callTool: async () => ({ content: reply.map((text: string) => ({ type: "text", text })) }), close: async () => {} }) as any;
    const ev: any[] = [];
    await recheck((e) => ev.push(e), client);
    expect(ev.filter((e) => e.type === "step").map((s) => s.id).sort()).toEqual(["connect", "gap1", "gap2", "gap3", "gap4", "gap5"]);
    expect(ev.find((e) => e.type === "done").results).toHaveLength(5);
  });

  it("answers 404 / health", async () => {
    expect((await handle(new Request("http://x/api?action=nope"))).status).toBe(404);
    expect(await (await handle(new Request("http://x/api?action=health"))).json()).toMatchObject({ status: "ok", task: "docs-mcp-onboarding" });
  });
});
