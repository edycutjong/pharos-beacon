import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main, nextN, record } from "../tasks/docs-mcp-onboarding/ask.js";
import { render } from "../tasks/docs-mcp-onboarding/render.js";
import type { DocsClient } from "../src/lib/docs-mcp.js";

const dir = (f: string) => fileURLToPath(new URL(`../tasks/docs-mcp-onboarding/${f}`, import.meta.url));
const jsonl = readFileSync(dir("proof/transcript.jsonl"), "utf8");
const entries = jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const doc = readFileSync(dir("ONBOARDING.md"), "utf8");
const transcript = entries.flatMap((e) => e.content).join("\n");

describe("ONBOARDING.md against the committed transcript", () => {
  it("transcript entries are numbered 1..N with a tool, arguments and raw content", () => {
    expect(entries.map((e) => e.n)).toEqual(entries.map((_, i) => i + 1));
    for (const e of entries) expect(e).toMatchObject({ tool: expect.stringMatching(/^(askQuestion|searchDocumentation|getPage)$/), endpoint: expect.stringContaining("docs.pharos.xyz") });
    expect(entries.some((e) => e.tool === "sendFeedback")).toBe(false);
  });
  it("every quoted answer line is in the transcript, verbatim", () => {
    const quotes = doc.split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2));
    expect(quotes.length).toBeGreaterThanOrEqual(10);
    for (const q of quotes) expect(transcript, q).toContain(q);
  });
  it("every query shown for a step is in the transcript with that call number", () => {
    for (const [, n, q] of doc.matchAll(/\(#(\d+)(?:, `[A-Za-z]+`)?\): `([^`]+)`/g)) expect(entries[Number(n) - 1].arguments, q).toSatisfy((a: Record<string, string>) => Object.values(a)[0] === q);
  });
  it("has at least 3 gaps, each with an exact query and a suggested fix", () => {
    const rows = doc.split("\n").filter((l) => /^\| [1-9] \| \*\*/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim());
      const query = /`([^`]+)`/.exec(cells[3])?.[1];
      expect(Object.values(entries.flatMap((e) => Object.values(e.arguments))), cells[3]).toContain(query);
      expect(cells[5].length).toBeGreaterThan(40);
    }
  });
  it("the rendered transcript.md is up to date", () => {
    expect(readFileSync(dir("proof/transcript.md"), "utf8")).toBe(render(jsonl));
  });
});

describe("recorder", () => {
  const client = (reply: unknown): DocsClient & { close(): Promise<void> } => ({ callTool: (async () => reply) as never, listTools: (async () => ({ tools: [] })) as never, close: async () => {} });
  it("records a tool error as an entry instead of throwing", async () => {
    const e = await record(client({ isError: true, content: [{ type: "text", text: "Page not found" }] }), "page", "https://docs.pharos.xyz/x", 3, new Date("2026-10-18T00:00:00Z"));
    expect(e).toMatchObject({ n: 3, tool: "getPage", isError: true, content: ["Page not found"], arguments: { url: "https://docs.pharos.xyz/x" } });
  });
  it("nextN counts lines, and main rejects an unknown verb", async () => {
    expect(nextN("/nonexistent/file")).toBe(1);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(main({ onExit() {}, signal: new AbortController().signal }, ["frobnicate", "x"], async () => client({}))).rejects.toThrow(/unknown command/);
    log.mockRestore();
  });
});
