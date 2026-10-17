import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Append-only JSONL audit log: one line per decision (and one per execution result). Lines are only ever appended;
// each carries the sha256 of the line before it, so an edited, removed or reordered line is detectable (`verifyAudit`).

export interface AuditEntry {
  seq: number;
  /** sha256 (hex) of the previous line's exact text; "genesis" for the first. */
  prev: string;
  at: string;
  event: "decision" | "result";
  [k: string]: unknown;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function lines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** Append `entry` (seq, prev and at are filled in). Returns the entry as written. Call while holding the run lock. */
export function appendAudit(file: string, entry: Record<string, unknown> & { event: AuditEntry["event"] }, now = new Date()): AuditEntry {
  const all = lines(file);
  const last = all.at(-1);
  const written = { seq: all.length + 1, prev: last ? sha(last) : "genesis", at: now.toISOString(), ...entry } as AuditEntry;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(written) + "\n", { flag: "a" });
  return written;
}

/** Check the chain: consecutive seq and every `prev` matching. Returns the entry count, or throws naming the first bad line. */
export function verifyAudit(file: string): number {
  let prev = "genesis";
  const all = lines(file);
  all.forEach((text, i) => {
    let e: AuditEntry;
    try {
      e = JSON.parse(text) as AuditEntry;
    } catch {
      throw new Error(`audit line ${i + 1} is not valid JSON`);
    }
    if (e.seq !== i + 1) throw new Error(`audit line ${i + 1} has seq ${e.seq}`);
    if (e.prev !== prev) throw new Error(`audit line ${i + 1} does not chain to line ${i}: the log was changed`);
    prev = sha(text);
  });
  return all.length;
}
