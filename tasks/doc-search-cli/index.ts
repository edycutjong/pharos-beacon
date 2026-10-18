// Doc-Search CLI (Easy · 50 pts): ask the Pharos docs a question from the terminal, get a concise answer with its sources.
//   pharos-docs "how do I deploy a contract?" [--sources N] [--json] [--proof]
// Built on the Developer Docs MCP: askQuestion for the answer and its "# Sources" list, searchDocumentation for the
// closest pages when there is no good answer. When the docs have no answer it says so and invents nothing.
import { isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { askDocs, docsMcp, DOCS_MCP_URL, DOCS_ORIGIN, searchDocs, type DocHit, type DocsClient } from "../../src/lib/docs-mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";

const TASK = "doc-search-cli";
/** Exit code when the docs have no answer (0 = answered, 1 = failure, 2 = bad usage). */
export const EXIT_NOT_FOUND = 3;

// askQuestion answers "I cannot find information about this in the docs." when the docs hold nothing relevant.
const NO_ANSWER = /\b(?:cannot|can't|could not|couldn't|unable to|did not|didn't|do not|don't)\s+(?:find|locate)\b|\bno (?:relevant |matching )?(?:information|results?|mention)\b|\bnot (?:covered|documented|mentioned)\b/i;

export interface Result {
  question: string;
  found: boolean;
  answer: string;
  sources: { title: string; url: string }[];
  /** Closest pages from searchDocumentation, filled when nothing answered (or the answer call failed). */
  closest: { title: string; url: string }[];
  /** Set when askQuestion failed and the closest pages are all there is. */
  askError?: string;
}

/** An answer is good only with at least one cited source and a reply that does not say it found nothing. */
export function isGoodAnswer(answer: string, sources: unknown[]): boolean {
  return sources.length > 0 && !NO_ANSWER.test(answer);
}

const dedupe = <T extends { url: string }>(items: T[]): T[] => [...new Map(items.map((i) => [i.url, i])).values()];

export async function search(client: DocsClient, question: string, goal?: string): Promise<Result> {
  let answer = "";
  let sources: Result["sources"] = [];
  let askError: string | undefined;
  try {
    const a = await askDocs(client, question, goal);
    answer = a.answer;
    sources = dedupe(a.sources);
  } catch (e) {
    askError = e instanceof Error ? e.message : String(e);
  }
  if (!askError && isGoodAnswer(answer, sources)) return { question, found: true, answer, sources, closest: [] };
  let hits: DocHit[] = [];
  try {
    hits = await searchDocs(client, question, { limit: 3 });
  } catch (e) {
    askError ??= `searchDocumentation failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { question, found: false, answer: askError ? "" : answer, sources: [], closest: dedupe(hits).map(({ title, url }) => ({ title, url })), ...(askError ? { askError } : {}) };
}

/** Answers link their own pages as root-relative paths ("/getting-started/…"); make those clickable in a terminal. */
const absolutize = (text: string) => text.replace(/\]\((\/[^)\s]*)\)/g, `](${DOCS_ORIGIN}$1)`);

export function format(r: Result, maxSources = 5): string {
  if (r.found) {
    const shown = r.sources.slice(0, maxSources);
    const more = r.sources.length - shown.length;
    return [absolutize(r.answer), "", "Sources:", ...shown.map((s) => `  - ${s.title}: ${s.url}`), ...(more > 0 ? [`  (+${more} more cited by the docs; use --sources ${r.sources.length} to list them)`] : [])].join("\n");
  }
  const lines = [r.askError ? `Could not get an answer from the Pharos docs (${r.askError}).` : "Not found in the Pharos docs: no good answer to this question, so none is given."];
  if (r.closest.length) lines.push("", "Closest pages (they may not answer it):", ...r.closest.map((s) => `  - ${s.title}: ${s.url}`));
  return lines.join("\n");
}

export async function main(
  { onExit }: RunContext,
  argv = process.argv.slice(2),
  connect: () => Promise<DocsClient & { close(): Promise<void> }> = () => docsMcp(),
): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: 'pharos-docs "<question>" [--goal "<what you are trying to do>"] [--sources N] [--json] [--proof]',
      options: { goal: { type: "string" }, sources: { type: "string", default: "5" }, json: { type: "boolean", default: false }, proof: { type: "boolean", default: false } },
      positionals: [1, 50],
    },
    argv,
  );
  const question = positionals.join(" ").trim();
  if (!question) throw new UsageError('give a question, e.g. pharos-docs "how do I deploy a contract?"');
  if (!/^[1-9]\d*$/.test(values.sources!)) throw new UsageError("--sources must be a positive whole number");

  const client = await connect();
  onExit(() => client.close());
  const r = await search(client, question, values.goal);
  console.log(values.json ? JSON.stringify(r, null, 2) : format(r, Number(values.sources)));
  if (values.proof) {
    const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    console.log(`proof: ${writeProof(new URL(`proof/${slug}.json`, import.meta.url), { result: r }, proofMeta(TASK, { network: "docs", chainId: null, endpoint: DOCS_MCP_URL }))}`);
  }
  return r.found ? 0 : EXIT_NOT_FOUND;
}

if (isMain(import.meta.url)) await runCli(main);
