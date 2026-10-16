import { realpathSync } from "node:fs";
import { resolve } from "node:path";
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

/** True when the module at `metaUrl` is the script being run, so a task's index.ts can be imported by its tests. */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(entry));
  } catch {
    return false;
  }
}

export interface RunContext {
  /** Register cleanup (e.g. `() => mcp.close()`); all of them run in reverse order, whatever happens. */
  onExit(fn: () => unknown): void;
}

const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

/**
 * Run a task's main and return its exit code: what main returns (default 0), 2 for a UsageError, 1 for any other
 * throw. On Ctrl-C or SIGTERM the cleanups run (closing clients ends any call in flight) and the code is 130 / 143,
 * with no error line for the interrupted work; a second signal, or main not settling within 2 s, exits at once.
 */
export async function runMain(main: (ctx: RunContext) => Promise<number | void>): Promise<number> {
  const cleanups: (() => unknown)[] = [];
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      for (const fn of cleanups.splice(0).reverse()) await Promise.resolve().then(fn).catch(() => {});
    })());
  let signal: string | undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  const onSignal = (s: NodeJS.Signals) => {
    if (signal) return void process.exit(SIGNAL_EXIT[s]);
    signal = s;
    process.exitCode = SIGNAL_EXIT[s];
    force = setTimeout(() => process.exit(SIGNAL_EXIT[s]), 2_000);
    force.unref();
    void cleanup();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const code = (await main({ onExit: (fn) => void cleanups.push(fn) })) ?? 0;
    return signal ? SIGNAL_EXIT[signal] : code;
  } catch (e) {
    if (signal) return SIGNAL_EXIT[signal];
    console.error(e instanceof UsageError ? e.message : `error: ${describeError(e)}`);
    return e instanceof UsageError ? 2 : 1;
  } finally {
    clearTimeout(force);
    await cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
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
