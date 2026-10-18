import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./env.js";
import { safePath } from "./net.js";
import type { ChainMcp, Network } from "./mcp.js";
import { writeJsonAtomic } from "./state.js";

// Proof files are what reviewers score, so every one says where its numbers came from: which chain and endpoint, which
// server version, which commit of this repo, and the exact command. Never anything from the environment.

export interface ProofMeta {
  task: string;
  /** "docs" for tasks that read only the Developer Docs MCP (no chain). */
  network: Network | "docs";
  chainId: number | null;
  mcp: { endpoint: string; server?: string; version?: string };
  /** The command as run, e.g. `tasks/read-contract-state/index.ts --proof`: repo paths relative, home as `~`, URLs without credentials or query. */
  command: string;
  /** HEAD when the run started; `dirty` = uncommitted changes existed, so the code that ran is HEAD plus edits. */
  git?: { commit: string; dirty: boolean };
  createdAt: string;
}

function git(args: string[]): string | undefined {
  try {
    // A minimal environment: an exported key must not reach git (or its hooks and helpers).
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env }).trim();
  } catch {
    return undefined; // not a checkout (e.g. a tarball): the proof just has no git field
  }
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi;

/** A URL as it may appear in a proof: scheme, host and word-like path segments only; a file: URL becomes a scrubbed path. */
function scrubUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === "file:") return scrubArg(fileURLToPath(u));
    return `${u.protocol}//${u.host}${safePath(u.pathname)}`;
  } catch {
    return "<url>";
  }
}

/**
 * One argument as it may appear in a proof: no credentials, tokens, query strings or home paths, also inside a
 * `--flag=value`. Task CLIs never take keys as arguments (keys come from the environment), so hashes and addresses,
 * which are evidence, are kept.
 */
export function scrubArg(arg: string): string {
  const flag = /^(-{1,2}[^=\s]+=)([\s\S]*)$/.exec(arg);
  if (flag) return flag[1] + scrubArg(flag[2]);
  if (/^file:/i.test(arg)) return scrubUrl(arg); // file:/x and file:///x alike
  if (isAbsolute(arg)) {
    const rel = relative(REPO_ROOT, arg);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel || ".";
    const home = homedir();
    if (arg === home || arg.startsWith(home + sep)) return `~${arg.slice(home.length)}`;
    return arg;
  }
  return arg.replace(URL_IN_TEXT, scrubUrl);
}

/** Metadata for a proof written by `task` after reading through `mcp`. */
export function proofMeta(task: string, mcp: Pick<ChainMcp, "endpoint"> & { server?: ChainMcp["server"]; network: Network | "docs"; chainId: number | null }, argv = process.argv): ProofMeta {
  const commit = git(["rev-parse", "--short=12", "HEAD"]);
  const script = argv[1] ? scrubArg(argv[1]) : "";
  return {
    task,
    network: mcp.network,
    chainId: mcp.chainId,
    mcp: { endpoint: mcp.endpoint, ...(mcp.server ? { server: mcp.server.name, version: mcp.server.version } : {}) },
    command: [script, ...argv.slice(2).map(scrubArg)].join(" ").trim(),
    ...(commit ? { git: { commit, dirty: (git(["status", "--porcelain"]) ?? "") !== "" } } : {}),
    createdAt: new Date().toISOString(),
  };
}

/** Write `{ meta, ...body }` atomically to `file` (a path or a `new URL("proof/x.json", import.meta.url)`); returns the repo-relative path. */
export function writeProof(file: string | URL, body: Record<string, unknown>, meta: ProofMeta): string {
  if ("meta" in body) throw new Error('a proof body cannot have a "meta" key: it would replace the provenance');
  const path = file instanceof URL ? fileURLToPath(file) : file;
  writeJsonAtomic(path, { meta, ...body });
  return relative(REPO_ROOT, path);
}
