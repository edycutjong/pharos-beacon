// The Doc-Search demo endpoint (tasks/doc-search-cli/web.ts): question checks and the CLI's own search() streamed as steps.
import { describe, expect, it } from "vitest";
import { ask, handle, parseQuestion } from "../tasks/doc-search-cli/web.js";

const u = (q: string) => new URL(`http://x/api/doc-search-cli?q=${encodeURIComponent(q)}`);
const fake = (answer: string, hits: string[] = []) => async () => ({
  listTools: async () => ({ tools: [] }),
  callTool: async ({ name }: { name: string }) => (name === "askQuestion" ? { content: [{ type: "text", text: answer }] } : { content: hits.map((text) => ({ type: "text", text })) }),
  close: async () => {},
}) as any;

describe("doc-search-cli web", () => {
  it("checks the question", () => {
    expect(parseQuestion(u("  how do I\n deploy?  "))).toBe("how do I deploy?");
    expect(() => parseQuestion(u("hi"))).toThrow(/at least 3/);
    expect(() => parseQuestion(u("x".repeat(201)))).toThrow(/under 200/);
  });

  it("answers 400 / 404 / health", async () => {
    expect((await handle(new Request("http://x/api?action=ask&q=a"))).status).toBe(400);
    expect((await handle(new Request("http://x/api?action=nope"))).status).toBe(404);
    expect(await (await handle(new Request("http://x/api?action=health"))).json()).toMatchObject({ status: "ok", task: "doc-search-cli" });
  });

  it("an answer with a source: gate kept, no search, exit 0, the CLI's text", async () => {
    const ev: any[] = [];
    await ask("chain id?", (e) => ev.push(e), fake("Chain ID is `688689`.\n\n# Sources\n\n- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)"));
    expect(ev.filter((e) => e.type === "step").map((s) => `${s.id}:${s.state}`)).toEqual(["connect:ok", "ask:ok", "gate:ok", "closest:skip"]);
    const done = ev.find((e) => e.type === "done");
    expect(done.exitCode).toBe(0);
    expect(done.text).toContain("Sources:\n  - Atlantic Testnet: https://docs.pharos.xyz/getting-started/network/atlantic-testnet");
  });

  it("no good answer: gate refused before the search, closest pages, exit 3, the reply dropped", async () => {
    const ev: any[] = [];
    await ask("pizza?", (e) => ev.push(e), fake("I cannot find information about pizza in the docs.", ["Title: Gas Model\nLink: https://docs.pharos.xyz/getting-started/gas-model\nContent: gas"]));
    expect(ev.filter((e) => e.type === "step").map((s) => `${s.id}:${s.state}`)).toEqual(["connect:ok", "ask:ok", "gate:refused", "closest:ok"]);
    const done = ev.find((e) => e.type === "done");
    expect(done.exitCode).toBe(3);
    expect(done.text).toContain("Not found in the Pharos docs");
    expect(done.text).not.toContain("pizza");
    expect(done.result.closest).toEqual([{ title: "Gas Model", url: "https://docs.pharos.xyz/getting-started/gas-model" }]);
  });
});
