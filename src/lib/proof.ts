import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./env.js";
import type { ChainMcp, Network } from "./mcp.js";
import { writeJsonAtomic } from "./state.js";

// Proof files are what reviewers score, so every one says where its numbers came from: which chain and endpoint, which
// server version, which commit of this repo, and the exact command. Never anything from the environment.

export interface ProofMeta {
  task: string;
  network: Network;
  chainId: number;
  mcp: { endpoint: string; server?: string; version?: string };
  /** The command as run, relative to the repo, e.g. `tasks/threshold-guardian/index.ts policies/x.json --proof`. */
  command: string;
  /** HEAD when the run started; `dirty` = uncommitted changes existed, so the code that ran is HEAD plus edits. */
  git?: { commit: string; dirty: boolean };
  createdAt: string;
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined; // not a checkout (e.g. a tarball): the proof just has no git field
  }
}

/** Metadata for a proof written by `task` after reading through `mcp`. */
export function proofMeta(task: string, mcp: Pick<ChainMcp, "network" | "chainId" | "endpoint" | "server">, argv = process.argv): ProofMeta {
  const commit = git(["rev-parse", "--short=12", "HEAD"]);
  const script = argv[1] ? relative(REPO_ROOT, argv[1]) : "";
  return {
    task,
    network: mcp.network,
    chainId: mcp.chainId,
    mcp: { endpoint: mcp.endpoint, ...(mcp.server ? { server: mcp.server.name, version: mcp.server.version } : {}) },
    command: [script, ...argv.slice(2)].join(" ").trim(),
    ...(commit ? { git: { commit, dirty: (git(["status", "--porcelain"]) ?? "") !== "" } } : {}),
    createdAt: new Date().toISOString(),
  };
}

/** Write `{ meta, ...body }` atomically to `file` (a path or a `new URL("proof/x.json", import.meta.url)`); returns the repo-relative path. */
export function writeProof(file: string | URL, body: Record<string, unknown>, meta: ProofMeta): string {
  const path = file instanceof URL ? fileURLToPath(file) : file;
  writeJsonAtomic(path, { meta, ...body });
  return relative(REPO_ROOT, path);
}
