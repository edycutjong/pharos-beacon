import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError, choice, isMain, parseCli, runMain } from "../src/lib/cli.js";
import { REPO_ROOT, envOr, readEnvFiles, secret } from "../src/lib/env.js";
import { proofMeta, scrubArg, writeProof } from "../src/lib/proof.js";
import { readState, toJson, withLock, writeJsonAtomic } from "../src/lib/state.js";

const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");
const helper = (f: string) => fileURLToPath(new URL(`./helpers/${f}`, import.meta.url));
const run = promisify(execFile);
/** A pid no process can have (above every OS's pid range): the holder of a lock left by a crash. */
const deadPid = () => 2 ** 31 - 2;

const dir = () => mkdtempSync(join(tmpdir(), "beacon-test-"));

describe("state", () => {
  it("writes JSON atomically (no temp file left) and turns bigints into strings", () => {
    const d = dir();
    const f = join(d, "sub/state.json");
    writeJsonAtomic(f, { cursor: 20_427_518n, seen: ["a"] });
    expect(readFileSync(f, "utf8")).toBe('{\n  "cursor": "20427518",\n  "seen": [\n    "a"\n  ]\n}\n');
    expect(readdirSync(join(d, "sub"))).toEqual(["state.json"]);
  });

  it("reads the fallback for a missing file, refuses to guess on a corrupt one, and can check the shape", () => {
    const d = dir();
    expect(readState(join(d, "none.json"), { n: 0 })).toEqual({ n: 0 });
    writeFileSync(join(d, "bad.json"), '{"n": 1');
    expect(() => readState(join(d, "bad.json"), { n: 0 })).toThrow(/not valid JSON; refusing to guess/);
    writeFileSync(join(d, "list.json"), "[]");
    const check = (v: unknown) => {
      if (typeof (v as { n?: unknown })?.n !== "number") throw new Error("state has no number n");
      return v as { n: number };
    };
    expect(() => readState(join(d, "list.json"), { n: 0 }, check)).toThrow(/no number n/);
    expect(() => readState(d, { n: 0 })).toThrow(/EISDIR/); // only a missing file means "no state yet"
  });

  it("refuses to write undefined instead of writing the text 'undefined'", () => {
    expect(() => writeJsonAtomic(join(dir(), "u.json"), undefined)).toThrow(/cannot write undefined/);
  });

  it("holds a lock while acting: a second run fails at once, and the lock is released even when the action throws", async () => {
    const d = dir();
    const f = join(d, "pay.json");
    let inner = "";
    await withLock(f, async () => {
      inner = await withLock(f, async () => "second").catch((e: Error) => e.message);
    });
    expect(inner).toMatch(/held by another run \(pid \d+, since .*\); not acting twice/);
    await expect(withLock(f, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(existsSync(`${f}.lock`)).toBe(false);
    expect(await withLock(f, async () => "free again")).toBe("free again");
    expect(readdirSync(d)).toEqual([]); // and no scratch files are left behind
  });

  it("never takes over a lock whose holder is alive, however old it is", async () => {
    const f = join(dir(), "pay.json");
    writeFileSync(`${f}.lock`, JSON.stringify({ pid: process.pid, token: "other", since: "2020-01-01T00:00:00.000Z" }));
    await expect(withLock(f, async () => "x")).rejects.toThrow(/held by another run \(pid \d+, since 2020-01-01/);
  });

  it("takes over the lock of a run that died (crash, kill -9), and of a half-written lock", async () => {
    const f = join(dir(), "pay.json");
    writeFileSync(`${f}.lock`, JSON.stringify({ pid: deadPid(), token: "dead", since: "2026-10-17T00:00:00.000Z" }));
    expect(await withLock(f, async () => "taken over")).toBe("taken over");
    writeFileSync(`${f}.lock`, "");
    expect(await withLock(f, async () => "taken over again")).toBe("taken over again");
    expect(readdirSync(join(f, ".."))).toEqual([]);
  });

  it("refuses while another run is taking a dead lock over, and clears a takeover left by a crash after 30 s", async () => {
    const f = join(dir(), "pay.json");
    writeFileSync(`${f}.lock`, JSON.stringify({ pid: deadPid(), token: "dead", since: "2026-10-17T00:00:00.000Z" }));
    writeFileSync(`${f}.lock.takeover`, "{}");
    await expect(withLock(f, async () => "x")).rejects.toThrow(/being taken over by another run; not acting twice/);
    const old = new Date(Date.now() - 31_000);
    utimesSync(`${f}.lock.takeover`, old, old);
    expect(await withLock(f, async () => "after the crashed takeover")).toBe("after the crashed takeover");
    expect(readdirSync(join(f, ".."))).toEqual([]);
  });

  it("releases only its own lock", async () => {
    const f = join(dir(), "pay.json");
    const other = JSON.stringify({ pid: process.pid, token: "someone-else", since: "now" });
    await withLock(f, async () => writeFileSync(`${f}.lock`, other));
    expect(readFileSync(`${f}.lock`, "utf8")).toBe(other);
  });

  it("releases the lock when the process exits inside the action (process.exit, as on Ctrl-C)", async () => {
    const f = join(dir(), "pay.json");
    const err = await run(TSX, [helper("lock-child.ts"), f, "exit"]).catch((e) => e);
    expect(err.code).toBe(130);
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it("lets exactly one of six simultaneous runs take over a dead run's lock", { timeout: 30_000 }, async () => {
    for (let round = 0; round < 3; round++) {
      const d = dir();
      const f = join(d, "pay.json");
      const holders = join(d, "holders");
      mkdirSync(holders);
      writeFileSync(`${f}.lock`, JSON.stringify({ pid: deadPid(), token: "dead", since: "2026-10-17T00:00:00.000Z" }));
      const startAt = String(Date.now() + 2_500);
      const outs = await Promise.all(Array.from({ length: 6 }, () => run(TSX, [helper("lock-child.ts"), f, "hold", holders, startAt]).then((r) => r.stdout.trim())));
      expect(outs.filter((o) => !/^(max \d+|held)$/.test(o))).toEqual([]); // "held" covers "being taken over by another run"
      expect(outs.filter((o) => o.startsWith("max")).length).toBeGreaterThanOrEqual(1);
      expect(outs.filter((o) => o.startsWith("max") && o !== "max 1")).toEqual([]);
    }
  });

  it("toJson keeps nested bigints exact", () => {
    expect(JSON.parse(toJson({ wei: 2n ** 80n }))).toEqual({ wei: "1208925819614629174706176" });
  });
});

describe("proof", () => {
  const mcp = { network: "pharos" as const, chainId: 1672, endpoint: "https://mcp.pharos.xyz/mcp", server: { name: "pharos-mcp-server", version: "0.1.0" } };

  it("stamps chain, endpoint, server version, git commit and the repo-relative command", () => {
    const meta = proofMeta("read-contract-state", mcp, ["/usr/bin/node", join(REPO_ROOT, "tasks/read-contract-state/index.ts"), "--proof"]);
    expect(meta).toMatchObject({
      task: "read-contract-state",
      network: "pharos",
      chainId: 1672,
      mcp: { endpoint: "https://mcp.pharos.xyz/mcp", server: "pharos-mcp-server", version: "0.1.0" },
      command: "tasks/read-contract-state/index.ts --proof",
    });
    expect(meta.git?.commit).toMatch(/^[0-9a-f]{12}$/);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(meta.git?.dirty).toBe(status.trim() !== "");
    expect(Date.parse(meta.createdAt)).not.toBeNaN();
  });

  it("writes { meta, ...body } and returns the path relative to the repo", () => {
    const f = join(dir(), "proof/run.json");
    const meta = proofMeta("t", mcp, ["node", "x.ts"]);
    const out = writeProof(f, { block: 7n, ok: true }, meta);
    expect(out.endsWith("proof/run.json")).toBe(true);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ meta: JSON.parse(JSON.stringify(meta)), block: "7", ok: true });
  });

  it("keeps credentials, query strings and home paths out of the recorded command", () => {
    expect(scrubArg("https://user:pw@mcp.example/mcp?token=abc")).toBe("https://mcp.example/mcp");
    expect(scrubArg("--url=https://user:pw@mcp.example/mcp?k=1")).toBe("--url=https://mcp.example/mcp");
    expect(scrubArg(join(REPO_ROOT, "tasks/x/policies/a.json"))).toBe("tasks/x/policies/a.json");
    expect(scrubArg(join(homedir(), "secrets/p.json"))).toBe("~/secrets/p.json");
    expect(scrubArg("--proof")).toBe("--proof");
    const meta = proofMeta("t", mcp, ["node", join(REPO_ROOT, "tasks/x/index.ts"), "--rpc=https://u:p@h/x?y=1"]);
    expect(meta.command).toBe("tasks/x/index.ts --rpc=https://h/x");
  });

  it("refuses a body with its own meta key, which would replace the provenance", () => {
    expect(() => writeProof(join(dir(), "p.json"), { meta: "fake" }, proofMeta("t", mcp))).toThrow(/cannot have a "meta" key/);
  });

  it("never copies the environment into a proof", () => {
    process.env.BEACON_TEST_SECRET = "s3cr3t-value";
    try {
      const f = join(dir(), "p.json");
      writeProof(f, {}, proofMeta("t", mcp));
      expect(readFileSync(f, "utf8")).not.toContain("s3cr3t-value");
    } finally {
      delete process.env.BEACON_TEST_SECRET;
    }
  });
});

describe("cli", () => {
  const spec = { usage: "npm run x -- <file> [--proof]", options: { proof: { type: "boolean", default: false }, network: { type: "string" } }, positionals: [1, 1] } as const;
  afterEach(() => vi.restoreAllMocks());

  it("parses flags and positionals strictly", () => {
    expect(parseCli(spec, ["a.json", "--proof"])).toMatchObject({ values: { proof: true }, positionals: ["a.json"] });
    for (const argv of [[], ["a", "b"], ["a", "--nope"], ["a", "--network"]]) {
      expect(() => parseCli(spec, argv)).toThrow(UsageError);
    }
    expect(() => parseCli(spec, [])).toThrow(/expected 1 argument\(s\), got 0\nusage: npm run x -- <file> \[--proof\]/);
  });

  it("choice accepts only the listed values", () => {
    expect(choice("--network", "atlantic", ["pharos", "atlantic"])).toBe("atlantic");
    expect(() => choice("--network", "mainnet", ["pharos", "atlantic"])).toThrow(/--network must be one of pharos, atlantic, got "mainnet"/);
  });

  it("maps outcomes to exit codes: the returned code, 2 for usage, 1 with one 'error:' line for a failure", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runMain(async () => {})).toBe(0);
    expect(await runMain(async () => 3)).toBe(3);
    expect(await runMain(async () => Promise.reject(new UsageError("bad flag\nusage: x")))).toBe(2);
    expect(await runMain(async () => Promise.reject(new Error(`fetch failed\n${"<html>".repeat(100)}`)))).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual(["bad flag\nusage: x", expect.stringMatching(/^error: fetch failed <html>.{280,}…$/)]);
  });

  it("runs every cleanup in reverse order, also after a failure, and a failing cleanup does not stop the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    const code = await runMain(async ({ onExit }) => {
      onExit(() => order.push("first registered"));
      onExit(() => Promise.reject(new Error("close failed")));
      onExit(async () => void order.push("last registered"));
      throw new Error("main failed");
    });
    expect(code).toBe(1);
    expect(order).toEqual(["last registered", "first registered"]);
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  describe("on Ctrl-C and SIGTERM", () => {
    const saved = process.exitCode;
    afterEach(() => {
      process.exitCode = saved;
    });

    /** A main whose work is in flight until its cleanup (closing the client) ends it, like an MCP call. */
    const inFlight = (order: string[]) => async ({ onExit }: { onExit(fn: () => unknown): void }) => {
      let fail!: (e: Error) => void;
      const call = new Promise((_, reject) => (fail = reject));
      onExit(() => (order.push("closed"), fail(new Error("MCP error -32000: Connection closed"))));
      await call;
    };

    it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("%s closes the clients, ends the work and exits %i without an error line", async (sig, code) => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const order: string[] = [];
      const pending = runMain(inFlight(order));
      await new Promise((r) => setTimeout(r, 10));
      process.emit(sig, sig);
      expect(await pending).toBe(code);
      expect(order).toEqual(["closed"]);
      expect(err).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 2_100)); // the 2 s force-exit was cancelled once main settled
      expect(exit).not.toHaveBeenCalled();
      expect(process.listenerCount(sig)).toBe(0);
    });

    it("a second Ctrl-C exits at once", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      let release!: () => void;
      const pending = runMain(async () => new Promise<void>((r) => (release = r))); // ignores the cleanup
      await new Promise((r) => setTimeout(r, 10));
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      expect(exit).toHaveBeenCalledWith(130);
      release();
      expect(await pending).toBe(130);
    });
  });

  it("isMain is true only for the script being run", () => {
    expect(isMain(import.meta.url)).toBe(false);
    expect(isMain(pathToFileURL(process.argv[1]).href)).toBe(true);
  });

  it("runCli delivers all output through a pipe before exiting", { timeout: 20_000 }, async () => {
    const { stdout } = await run(TSX, [helper("print-child.ts"), "300000"], { maxBuffer: 10_000_000 });
    expect(stdout.length).toBe(300_000);
  });
});

describe("env", () => {
  afterEach(() => {
    delete process.env.BEACON_TEST_URL;
  });

  it("treats blank as unset, so the blank placeholders in .env.example fall back to the default", () => {
    process.env.BEACON_TEST_URL = "   ";
    expect(envOr("BEACON_TEST_URL", "https://default")).toBe("https://default");
    process.env.BEACON_TEST_URL = " https://set ";
    expect(envOr("BEACON_TEST_URL", "https://default")).toBe("https://set");
    expect(secret("BEACON_TEST_URL")).toBe("https://set");
    delete process.env.BEACON_TEST_URL;
    expect(envOr("BEACON_TEST_URL", "https://default")).toBe("https://default");
    expect(secret("BEACON_TEST_URL")).toBeUndefined();
  });

  it("reads env files into a map, first file wins, missing files skipped, and never writes process.env", () => {
    const d = dir();
    writeFileSync(join(d, "a.env"), "BEACON_FAKE_KEY=0xaaa\nBEACON_ONLY_A=1\n");
    writeFileSync(join(d, "b.env"), "BEACON_FAKE_KEY=0xbbb\nBEACON_ONLY_B=2\n");
    expect(readEnvFiles([join(d, "missing.env"), join(d, "a.env"), join(d, "b.env")])).toEqual({ BEACON_FAKE_KEY: "0xaaa", BEACON_ONLY_A: "1", BEACON_ONLY_B: "2" });
    expect(process.env.BEACON_FAKE_KEY).toBeUndefined();
  });

  it("resolves the repo root from the module, not the working directory", () => {
    expect(existsSync(join(REPO_ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "src/lib/env.ts"))).toBe(true);
  });
});
