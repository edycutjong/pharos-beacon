// Render proof/transcript.jsonl as proof/transcript.md: each call's raw reply as plain text, so a quote can be grepped.
//   npm run docs-onboarding:render
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TRANSCRIPT, type Entry } from "./ask.js";

export function render(jsonl: string): string {
  return jsonl
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry)
    .map((e) => `## #${e.n} ${e.tool}${e.isError ? " (tool error)" : ""} · ${e.at}\n\nQuery: ${Object.values(e.arguments)[0]}\n\n${e.content.join("\n\n")}\n`)
    .join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL("proof/transcript.md", import.meta.url));
  writeFileSync(out, render(readFileSync(TRANSCRIPT, "utf8")));
  console.log(`wrote ${out}`);
}
