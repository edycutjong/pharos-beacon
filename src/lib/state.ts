import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// JSON files that outlive one run: a monitor's cursor, a spend window, a schedule. Written atomically, read fail-closed,
// and guarded by a lock so two runs of the same agent can never both act.

/** Pretty JSON with a trailing newline; bigints become decimal strings (viem returns them everywhere). */
export function toJson(value: unknown): string {
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  if (text === undefined) throw new TypeError("cannot write undefined (or a function) as JSON");
  return `${text}\n`;
}

let writes = 0;
/**
 * Write via a temporary file in the same directory, flushed to disk, then renamed over the target: a crash leaves
 * the old file or the new one, never half of one.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const text = toJson(value);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${writes++}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * The saved state, or `fallback` when the file does not exist yet. A file that is not valid JSON throws: guessing
 * could act twice. Pass `check` to refuse valid JSON of the wrong shape (it returns the value or throws).
 */
export function readState<T>(file: string, fallback: T, check?: (value: unknown) => T): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`state file ${file} is not valid JSON; refusing to guess (fix or remove it)`);
  }
  return check ? check(value) : (value as T);
}

export const writeState = writeJsonAtomic;

interface LockOwner {
  pid: number;
  token: string;
  since: string;
}

function readOwner(lock: string): LockOwner | undefined {
  try {
    const o = JSON.parse(readFileSync(lock, "utf8")) as Partial<LockOwner>;
    return { pid: Number(o.pid), token: String(o.token), since: String(o.since) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { pid: NaN, token: "", since: "unknown" }; // half-written by a run that crashed while taking it
  }
}

/** Is the process alive? EPERM means it exists but belongs to someone else. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const held = (lock: string, o: LockOwner) => new Error(`${lock} is held by another run (pid ${o.pid}, since ${o.since}); not acting twice`);

/**
 * Run `fn` while holding `<file>.lock`. A second run fails at once instead of waiting (a scheduled agent should skip a
 * tick, not queue up). A lock is taken over only when the process that holds it is gone (a crash or kill -9), never
 * for its age, so a slow run is never joined by a second one. The lock is removed when `fn` settles and also when the
 * process exits early (process.exit, e.g. on Ctrl-C), and only if it is still this run's lock.
 */
export async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const me: LockOwner = { pid: process.pid, token: randomUUID(), since: new Date().toISOString() };
  // The owner is written to a file of our own first and hard-linked into place: the link either creates the lock with
  // its content in one step or fails because a lock exists. A lock file is never seen empty.
  const mine = `${lock}.${me.token}.new`;
  writeFileSync(mine, JSON.stringify(me));
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(mine, lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      takeOverIfDead(lock, mine, attempt); // throws if held by a live run
    }
  } finally {
    rmSync(mine, { force: true });
  }
  const release = () => {
    if (readOwner(lock)?.token === me.token) rmSync(lock, { force: true });
  };
  process.once("exit", release);
  try {
    return await fn();
  } finally {
    process.off("exit", release);
    release();
  }
}

/** The lock exists: throw if a live run holds it; otherwise clear the dead holder's lock (or notice it went) so the caller tries again. */
function takeOverIfDead(lock: string, mine: string, attempt: number): void {
  const other = readOwner(lock);
  if (attempt >= 3) throw held(lock, other ?? { pid: NaN, token: "", since: "unknown" });
  if (!other) return; // released in the meantime: try again
  if (alive(other.pid)) throw held(lock, other);
  // The holder is gone (a crash or kill -9). Only the run that holds `<lock>.takeover` may remove its lock, and only if
  // it is still that same lock, so two runs can never both clear it and a live run's lock is never touched.
  const gate = `${lock}.takeover`;
  try {
    linkSync(mine, gate);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // Another run is taking it over right now and will hold it. A gate older than 30 s was left by a run that crashed
    // mid-takeover (which takes microseconds): clear it and try again.
    let age = 0;
    try {
      age = Date.now() - statSync(gate).mtimeMs;
    } catch {
      return;
    }
    if (age > 30_000) return void rmSync(gate, { force: true });
    throw new Error(`${lock} is being taken over by another run; not acting twice`);
  }
  try {
    if (readOwner(lock)?.token === other.token) rmSync(lock, { force: true });
  } finally {
    rmSync(gate, { force: true });
  }
}
