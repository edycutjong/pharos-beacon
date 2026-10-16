import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// JSON files that outlive one run: a monitor's cursor, a spend window, a schedule. Written atomically, read fail-closed,
// and guarded by a lock so two runs of the same agent cannot both act.

/** Pretty JSON with a trailing newline; bigints become decimal strings (viem returns them everywhere). */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;
}

let writes = 0;
/** Write via a temporary file in the same directory and rename it over the target: a crash leaves the old file or the new one, never half. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${writes++}.tmp`;
  try {
    writeFileSync(tmp, toJson(value));
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The saved state, or `fallback` when the file does not exist yet. A file that is not valid JSON throws: guessing could act twice. */
export function readState<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`state file ${file} is not valid JSON; refusing to guess (fix or remove it)`);
  }
}

export const writeState = writeJsonAtomic;

/**
 * Run `fn` while holding `<file>.lock`. A second run fails at once instead of waiting (a scheduled agent should skip
 * a tick, not queue up). A lock older than `staleMs` (default 10 min) is left over from a crash and is taken over.
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, opts: { staleMs?: number } = {}): Promise<T> {
  const lock = `${file}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < (opts.staleMs ?? 600_000)) throw new Error(`${lock} is held by another run (${Math.round(age / 1000)} s old); not acting twice`);
    rmSync(lock, { force: true });
    fd = openSync(lock, "wx"); // still EEXIST if another run took it over first: that run wins
  }
  writeSync(fd, `${process.pid}\n`);
  closeSync(fd);
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
