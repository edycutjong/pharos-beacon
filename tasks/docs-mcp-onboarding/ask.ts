// Transcript recorder for the Docs MCP Onboarding log: one raw Docs MCP call per run, appended to proof/transcript.jsonl.
//   npm run docs-onboarding -- ask|search|page "<question | query | url>"
// Every answer quoted in ONBOARDING.md is a line of that file, so it greps. Nothing else is read or written.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { docsMcp, DOCS_MCP_URL, type DocsClient } from "../../src/lib/docs-mcp.js";

export const TRANSCRIPT = fileURLToPath(new URL("proof/transcript.jsonl", import.meta.url));
const TOOL = { ask: ["askQuestion", "question"], search: ["searchDocumentation", "query"], page: ["getPage", "url"] } as const;
type Verb = keyof typeof TOOL;

export interface Entry {
  n: number;
  at: string;
  endpoint: string;
  tool: string;
  arguments: Record<string, string>;
  isError: boolean;
  /** The text blocks exactly as the server sent them. */
  content: string[];
}

export function nextN(file = TRANSCRIPT): number {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length + 1 : 1;
}

/** Call one tool and return the entry (the caller appends it). A tool error is recorded, not thrown: gaps are findings. */
export async function record(client: DocsClient, verb: Verb, input: string, n: number, now = new Date()): Promise<Entry> {
  const [tool, key] = TOOL[verb];
  const args = { [key]: input };
  const res = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 })) as { content?: { type: string; text?: string }[]; isError?: boolean };
  const content = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "");
  return { n, at: now.toISOString(), endpoint: DOCS_MCP_URL, tool, arguments: args, isError: res.isError === true, content };
}

export async function main({ onExit }: RunContext, argv = process.argv.slice(2), connect: () => Promise<DocsClient & { close(): Promise<void> }> = () => docsMcp(), file = TRANSCRIPT): Promise<number> {
  const { positionals } = parseCli({ usage: 'docs-onboarding ask|search|page "<question | query | url>"', options: {}, positionals: [2, 100] }, argv);
  const verb = positionals[0] as Verb;
  if (!(verb in TOOL)) throw new UsageError(`unknown command ${JSON.stringify(verb)}; use ask, search or page`);
  const input = positionals.slice(1).join(" ").trim();
  if (!input) throw new UsageError("give a question, query or url");
  const client = await connect();
  onExit(() => client.close());
  const entry = await record(client, verb, input, nextN(file));
  appendFileSync(file, JSON.stringify(entry) + "\n");
  console.log(`#${entry.n} ${entry.tool}${entry.isError ? " (tool error)" : ""}\n\n${entry.content.join("\n\n")}`);
  return entry.isError ? 1 : 0;
}

if (isMain(import.meta.url)) await runCli(main);
