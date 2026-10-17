import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { describeError } from "./net.js";

// The shape every task CLI shares: strict flags, `usage` + exit 2 on bad input, `error: …` + exit 1 on a failure,
// cleanup (closing MCP clients) that always runs, Ctrl-C / SIGTERM handled, and output flushed before exiting.

/** Bad flags or arguments: printed with the usage line, exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

export interface CliSpec<O extends ParseArgsOptionsConfig> {
  usage: string;
  options: O;
  /** Allowed positional count, [min, max] (default [0, 0]). */
  positionals?: readonly [number, number];
}

/** Parse `argv` strictly: unknown flags, missing values and a wrong positional count throw UsageError. */
export function parseCli<const O extends ParseArgsOptionsConfig>(spec: CliSpec<O>, argv: string[] = process.argv.slice(2)) {
  const [min, max] = spec.positionals ?? [0, 0];
  try {
    const parsed = parseArgs({ args: argv, options: spec.options, allowPositionals: true, strict: true });
    const n = parsed.positionals.length;
    if (n < min || n > max) throw new Error(min === max ? `expected ${min} argument(s), got ${n}` : `expected ${min} to ${max} arguments, got ${n}`);
    return parsed;
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\nusage: ${spec.usage}`);
  }
}

/** `value` if it is one of `allowed`, else a UsageError naming the flag. */
export function choice<const T extends string>(flag: string, value: unknown, allowed: readonly T[]): T {
  if (allowed.includes(value as T)) return value as T;
  throw new UsageError(`${flag} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
}

/**
 * True when the module at `metaUrl` is the script being run, so a task's index.ts can be imported by its tests. Like
 * Node and tsx, it accepts the entry as a path, a symlink, a path without its extension, or the task's folder.
 */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let self: string;
  try {
    self = realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
  const base = resolve(entry);
  for (const candidate of [base, `${base}.ts`, `${base}.mts`, `${base}.js`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.js")]) {
    try {
      if (realpathSync(candidate) === self) return true;
    } catch {
      // not this one
    }
  }
  return false;
}

export interface RunContext {
  /**
   * Register cleanup (e.g. `() => mcp.close()`); all of them run in reverse order, whatever happens. Once an
   * interruption has started the cleanup, a late registration runs at once, so a client that finished connecting
   * after Ctrl-C is closed straight away and its next call fails.
   */
  onExit(fn: () => unknown): void;
  /** Aborted on Ctrl-C, SIGTERM or SIGHUP: check it before anything irreversible, such as a broadcast. */
  signal: AbortSignal;
}

const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const SIGNALS = Object.keys(SIGNAL_EXIT) as NodeJS.Signals[];

/** An error that carries a transaction (the signer's broadcast errors): its hash must reach the user whatever happens. */
const carriesTx = (e: unknown): e is Error & { signed: unknown } => e instanceof Error && "signed" in e;

/**
 * Run a task's main and return its exit code: what main returns (default 0), 2 for a UsageError, 1 for any other
 * throw. On Ctrl-C, SIGTERM or SIGHUP the signal aborts, the cleanups run (closing clients ends any call in flight)
 * and the code is 130 / 143 / 129, with no error line for the interrupted work, except an error that carries a
 * transaction, which is always printed in full; a second signal, or main not settling within 2 s, exits at once.
 */
export async function runMain(main: (ctx: RunContext) => Promise<number | void>): Promise<number> {
  const cleanups: (() => unknown)[] = [];
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      for (const fn of cleanups.splice(0).reverse()) await Promise.resolve().then(fn).catch(() => {});
    })());
  const late: Promise<unknown>[] = []; // cleanups registered after the cleanup started: run at once, awaited before return
  const onExit = (fn: () => unknown) => {
    if (cleaning) late.push(Promise.resolve().then(fn).catch(() => {}));
    else cleanups.push(fn);
  };
  const interrupt = new AbortController();
  let signal: string | undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  const onSignal = (s: NodeJS.Signals) => {
    if (signal) return void process.exit(SIGNAL_EXIT[s]);
    signal = s;
    process.exitCode = SIGNAL_EXIT[s];
    force = setTimeout(() => process.exit(SIGNAL_EXIT[s]), 2_000);
    force.unref();
    interrupt.abort(new Error(`interrupted by ${s}`));
    void cleanup();
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  try {
    const code = (await main({ onExit, signal: interrupt.signal })) ?? 0;
    return signal ? SIGNAL_EXIT[signal] : code;
  } catch (e) {
    if (carriesTx(e)) console.error(`error: ${e.message}`); // in full: the hash and explorer link must not be cut
    if (signal) return SIGNAL_EXIT[signal];
    if (!carriesTx(e)) console.error(e instanceof UsageError ? e.message : `error: ${describeError(e)}`);
    return e instanceof UsageError ? 2 : 1;
  } finally {
    clearTimeout(force);
    await cleanup();
    await Promise.all(late);
    for (const s of SIGNALS) process.off(s, onSignal);
  }
}

/** Resolve once everything written so far to `stream` has been handed to the OS (a pipe on macOS is asynchronous). */
function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((r) => (stream.writableLength === 0 ? r() : stream.write("", () => r())));
}

/** `runMain`, then flush stdout/stderr and exit with its code (a stdio MCP child or an open socket cannot keep it alive). */
export async function runCli(main: (ctx: RunContext) => Promise<number | void>): Promise<never> {
  const code = await runMain(main);
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
  process.exit(code);
}
