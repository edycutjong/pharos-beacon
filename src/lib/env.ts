// Loads keys and overrides once, before any module reads process.env. Every lib module that reads the environment
// imports this file first, so the result never depends on import order.
// Order: the shell, then ~/.config/pharos/testnet.env (preferred), then <repo>/.env (git-ignored). dotenv never
// overrides a variable that is already set, so the first source wins. The repo .env is resolved from this file, not
// from the working directory, so the same keys load wherever a command runs.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

config({ path: join(homedir(), ".config/pharos/testnet.env"), quiet: true });
config({ path: join(REPO_ROOT, ".env"), quiet: true });

/** A variable's value, or `fallback` when it is unset or blank (`.env.example` ships blank placeholders). */
export function envOr(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}
