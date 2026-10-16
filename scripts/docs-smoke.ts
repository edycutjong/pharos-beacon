// Live check of the Developer Docs MCP (keyless): tools/list, searches, one page fetch, one question.
//   npm run smoke:docs
import { askDocs, describeError, docsMcp, getDocPage, listDocTools, searchDocs } from "../src/lib/docs-mcp.js";

const NEEDED = ["searchDocumentation", "getPage", "askQuestion"];
let code = 0;
// Every call has its own timeout and retries, but a degraded endpoint could still add up: stop well inside CI's 5 minutes.
setTimeout(() => {
  console.error("error: docs smoke exceeded 240 s");
  process.exit(1);
}, 240_000).unref();
const client = await docsMcp().catch((e: unknown) => {
  console.error(`error: could not connect to the Docs MCP: ${describeError(e)}`);
  return process.exit(1);
});

try {
  const server = client.getServerVersion();
  const tools = await listDocTools(client);
  console.log(`Docs MCP ${server?.name} ${server?.version}: ${tools.length} tools — ${tools.map((t) => t.name).join(", ")}`);
  const missing = NEEDED.filter((n) => !tools.some((t) => t.name === n));
  if (missing.length) throw new Error(`tools/list is missing ${missing.join(", ")}`);

  const hits = await searchDocs(client, "Atlantic testnet RPC URL chain id", { limit: 3 });
  if (hits.length === 0) throw new Error("searchDocumentation returned no hits");
  console.log(`searchDocumentation: ${hits.length} hits`);
  for (const h of hits) console.log(`  ${h.rank}. ${h.title} — ${h.url}`);

  // A one-word query returns some hits without a Content line; the parser must accept them.
  const wide = await searchDocs(client, "RPC");
  console.log(`searchDocumentation "RPC": ${wide.length} hits, ${wide.filter((h) => h.content === "").length} without content`);

  const page = await getDocPage(client, hits[0].url);
  console.log(`getPage ${hits[0].url}: ${page.length} chars, starts ${JSON.stringify(page.slice(0, 50))}`);

  const a = await askDocs(client, "What is the Atlantic testnet chain id?");
  if (a.sources.length === 0) throw new Error("askQuestion cited no sources");
  console.log(`askQuestion: ${JSON.stringify(a.answer.slice(0, 120))} · ${a.sources.length} sources, first ${a.sources[0].url}`);
  console.log("docs smoke: OK");
} catch (e) {
  console.error(`error: ${describeError(e)}`);
  code = 1;
} finally {
  await client.close();
}
process.exit(code);
