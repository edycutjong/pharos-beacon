// Settings and keys, read once. Sources, first wins: the shell, then ~/.config/pharos/testnet.env (preferred), then the
// repo's git-ignored .env (resolved from this file, not the working directory). The files are parsed into a private
// map and never copied into process.env, so no child process (the local MCP server, a notifier, a helper script)
// can inherit a key from them. Read settings with envOr() and keys with secret().
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Parse dotenv files into one map; for a name in several files the first non-blank value wins. A missing file is skipped. */
export function readEnvFiles(paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(parse(text))) if (!(k in out) && v.trim()) out[k] = v;
  }
  return out;
}

const fromFiles = readEnvFiles([join(homedir(), ".config/pharos/testnet.env"), join(REPO_ROOT, ".env")]);
const nonBlank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

/** A setting: the shell's value, else the files'; `fallback` when unset or blank (`.env.example` ships blank placeholders). */
export function envOr(name: string, fallback: string): string {
  return nonBlank(process.env[name]) ?? nonBlank(fromFiles[name]) ?? fallback;
}

/** A key (e.g. PRIVATE_KEY) from the same sources, or undefined. Never copied into process.env. */
export function secret(name: string): string | undefined {
  return nonBlank(process.env[name]) ?? nonBlank(fromFiles[name]);
}
