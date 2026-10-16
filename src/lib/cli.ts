import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { describeError } from "./net.js";

// The shape every task CLI shares: strict flags, `usage` + exit 2 on bad input, `error: …` + exit 1 on a failure,
// and cleanup (closing MCP clients) that always runs, also on Ctrl-C.

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

export interface RunContext {
  /** Register cleanup (e.g. `() => mcp.close()`); all of them run in reverse order, whatever happens. */
  onExit(fn: () => unknown): void;
}

/** Run a task's main and return its exit code: what main returns (default 0), 2 for a UsageError, 1 for any other throw. */
export async function runMain(main: (ctx: RunContext) => Promise<number | void>): Promise<number> {
  const cleanups: (() => unknown)[] = [];
  const cleanup = async () => {
    for (const fn of cleanups.splice(0).reverse()) await Promise.resolve().then(fn).catch(() => {});
  };
  const onSigint = () => void cleanup().finally(() => process.exit(130));
  process.once("SIGINT", onSigint);
  try {
    return (await main({ onExit: (fn) => void cleanups.push(fn) })) ?? 0;
  } catch (e) {
    console.error(e instanceof UsageError ? e.message : `error: ${describeError(e)}`);
    return e instanceof UsageError ? 2 : 1;
  } finally {
    await cleanup();
    process.off("SIGINT", onSigint);
  }
}

/** `runMain`, then exit the process with its code (a stdio MCP child or an open socket cannot keep it alive). */
export async function runCli(main: (ctx: RunContext) => Promise<number | void>): Promise<never> {
  process.exit(await runMain(main));
}
