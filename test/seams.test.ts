import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError, choice, isMain, parseCli, runMain, type RunContext } from "../src/lib/cli.js";
import { REPO_ROOT, envOr, readEnvFiles, secret } from "../src/lib/env.js";
import { endpointLabel } from "../src/lib/net.js";
import { proofMeta, scrubArg, writeProof } from "../src/lib/proof.js";
import { readState, toJson, withLock, writeJsonAtomic } from "../src/lib/state.js";
import { startLocal } from "./helpers/local-mcp.js";

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

  it("never takes over a lock whose holder is alive, however long it has run since boot", async () => {
    const f = join(dir(), "pay.json");
    const since = new Date(Math.max(Date.now() - uptime() * 1000 + 120_000, Date.now() - 6 * 3_600_000)).toISOString();
    writeFileSync(`${f}.lock`, JSON.stringify({ pid: process.pid, token: "other", since }));
    await expect(withLock(f, async () => "x")).rejects.toThrow(new RegExp(`held by another run \\(pid \\d+, since ${since.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("takes over the lock of a run that died (crash, kill -9), and of a half-written lock", async () => {
    const f = join(dir(), "pay.json");
    writeFileSync(`${f}.lock`, JSON.stringify({ pid: deadPid(), token: "dead", since: "2026-10-17T00:00:00.000Z" }));
    expect(await withLock(f, async () => "taken over")).toBe("taken over");
    writeFileSync(`${f}.lock`, "");
    expect(await withLock(f, async () => "taken over again")).toBe("taken over again");
    expect(readdirSync(join(f, ".."))).toEqual([]);
  });

  it("records the holder's real pid and takes the lock over once that process is kill -9'd", { timeout: 20_000 }, async () => {
    const f = join(dir(), "pay.json");
    const holder = spawn(TSX, [helper("lock-hold-child.ts"), f], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((r) => holder.stdout.on("data", (d) => String(d).includes("LOCKED") && r()));
    const pid = JSON.parse(readFileSync(`${f}.lock`, "utf8")).pid as number;
    expect(pid).not.toBe(process.pid);
    await expect(withLock(f, async () => "x")).rejects.toThrow(/held by another run/);
    process.kill(pid, "SIGKILL");
    holder.kill("SIGKILL");
    for (let i = 0; i < 60; i++) {
      // a killed process still answers kill(pid, 0) until it is reaped
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await withLock(f, async () => "taken over")).toBe("taken over");
  });

  it("counts a process it may not signal (EPERM, e.g. pid 1) as alive", async () => {
    const f = join(dir(), "pay.json");
    writeFileSync(`${f}.lock`, JSON.stringify({ pid: 1, token: "init", since: new Date().toISOString() }));
    await expect(withLock(f, async () => "x")).rejects.toThrow(/held by another run \(pid 1,.*If no such run exists, delete the file/);
  });

  it("takes over a lock from before the last boot even when its pid now belongs to a live process", async () => {
    const f = join(dir(), "pay.json");
    writeFileSync(`${f}.lock`, JSON.stringify({ pid: process.pid, token: "old", since: "2000-01-01T00:00:00.000Z" }));
    expect(await withLock(f, async () => "taken over")).toBe("taken over");
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
    expect(scrubArg("--a=b=https://u:p@h/x?y=1")).toBe("--a=b=https://h/x");
    expect(scrubArg("-u=https://u:p@h/x")).toBe("-u=https://h/x");
    expect(scrubArg("https://api.zan.top/node/v1/pharos/atlantic/2f1e0c3a9b8d7e6f5a4b3c2d1e0f9a8b")).toBe("https://api.zan.top/node/v1/pharos/atlantic/…");
    expect(scrubArg(`file://${join(homedir(), "secrets/p.json")}`)).toBe("~/secrets/p.json");
    expect(scrubArg(`--policy=${join(homedir(), "x.json")}`)).toBe("--policy=~/x.json");
    expect(scrubArg(`0x${"ab".repeat(32)}`)).toBe(`0x${"ab".repeat(32)}`); // a tx hash is evidence: kept
    const tx = `https://atlantic.pharosscan.xyz/tx/0x${"cd".repeat(32)}`;
    expect(scrubArg(tx)).toBe(tx); // so is an explorer link, for a tx or an address
    const address = "https://atlantic.pharosscan.xyz/address/0x8D347c72431ed6E033d5f43E56c0987E97f5D91B";
    expect(scrubArg(address)).toBe(address);
    expect(scrubArg(`-p=${join(homedir(), "x.json")}`)).toBe("-p=~/x.json");
    expect(scrubArg(`file:${join(homedir(), "p.json")}`)).toBe("~/p.json");
    expect(scrubArg(`--policy=file:${join(homedir(), "p.json")}`)).toBe("--policy=~/p.json");
    const meta = proofMeta("t", mcp, ["node", join(REPO_ROOT, "tasks/x/index.ts"), "--rpc=https://u:p@h/x?y=1"]);
    expect(meta.command).toBe("tasks/x/index.ts --rpc=https://h/x");
    expect(endpointLabel("https://mcp.pharos.xyz/mcp")).toBe("https://mcp.pharos.xyz/mcp");
    expect(endpointLabel("https://docs.pharos.xyz/~gitbook/mcp?t=1")).toBe("https://docs.pharos.xyz/~gitbook/mcp");
    expect(endpointLabel("https://rpc.example/v2/AbCdEf0123456789xyzKEY")).toBe("https://rpc.example/v2/…");
  });

  it("refuses a body with its own meta key, which would replace the provenance", () => {
    expect(() => writeProof(join(dir(), "p.json"), { meta: "fake" }, proofMeta("t", mcp))).toThrow(/cannot have a "meta" key/);
  });

  it("runs git with a minimal environment, so an exported key never reaches it", () => {
    const bin = dir();
    const out = join(bin, "env.txt");
    writeFileSync(join(bin, "git"), `#!/bin/sh\nenv > '${out}'\nexit 1\n`, { mode: 0o755 });
    const saved = { path: process.env.PATH, secret: process.env.BEACON_TEST_SECRET };
    process.env.PATH = `${bin}:${saved.path}`;
    process.env.BEACON_TEST_SECRET = "s3cr3t-value";
    try {
      expect(proofMeta("t", mcp).git).toBeUndefined(); // the fake git failed, so no git field
      const names = readFileSync(out, "utf8").split("\n").map((l) => l.split("=")[0]).filter(Boolean);
      expect(names).not.toContain("BEACON_TEST_SECRET");
      expect(names).toContain("PATH");
    } finally {
      process.env.PATH = saved.path;
      delete process.env.BEACON_TEST_SECRET;
    }
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

  it("prints an error that carries a transaction once, in full, also when not interrupted", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const hash = `0x${"ab".repeat(32)}`;
    const long = `could not tell whether ${hash} (nonce 5) was sent: ${"y".repeat(400)}`;
    expect(await runMain(async () => Promise.reject(Object.assign(new Error(long), { signed: { hash } })))).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual([`error: ${long}`]);
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

    it("closes a client that finished connecting after Ctrl-C at once, so its next call fails; main sees the abort", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const order: string[] = [];
      let connected!: () => void;
      const pending = runMain(async ({ onExit, signal }: RunContext) => {
        await new Promise<void>((r) => (connected = r)); // the connect, still in flight when the signal comes
        let closed = false;
        onExit(() => ((closed = true), order.push("closed late")));
        await Promise.resolve();
        order.push(`aborted=${signal.aborted}`);
        if (closed) throw new Error("the Chain MCP client is closed"); // what the next call would do
        order.push("ACTED");
      });
      await new Promise((r) => setTimeout(r, 10));
      process.emit("SIGINT", "SIGINT");
      connected();
      expect(await pending).toBe(130);
      expect(order).toEqual(["closed late", "aborted=true"]);
      expect(err).not.toHaveBeenCalled();
    });

    it("still prints an error that carries a transaction, in full, when interrupted", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const hash = `0x${"ef".repeat(32)}`;
      const pending = runMain(async ({ onExit }: RunContext) => {
        let fail!: (e: Error) => void;
        const send = new Promise((_, reject) => (fail = reject));
        onExit(() => fail(Object.assign(new Error(`could not tell whether ${hash} (nonce 5) was sent: ${"x".repeat(400)}`), { signed: { hash } })));
        await send;
      });
      await new Promise((r) => setTimeout(r, 10));
      process.emit("SIGINT", "SIGINT");
      expect(await pending).toBe(130);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toMatch(new RegExp(`^error: could not tell whether ${hash} \\(nonce 5\\) was sent: x{400}$`));
    });

    it("stops a task that finishes connecting after Ctrl-C before it acts, and ends its session (real process)", { timeout: 20_000 }, async () => {
      const local = await startLocal("sse", {
        sessions: true,
        delay: (rpc) => (rpc.method === "initialize" ? 1_500 : 0), // the connect is still in flight when Ctrl-C comes
        tool: (n) => ({ content: [{ type: "text", text: JSON.stringify(n === "get_chain_info" ? { chainId: 1672 } : { ok: true }) }] }),
      });
      const c = spawn(TSX, [helper("connect-child.ts"), local.url], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stderr += d));
      await vi.waitFor(() => expect(stdout).toContain("CONNECTING"), { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 300));
      c.kill("SIGINT");
      const code = await new Promise<number | null>((r) => c.on("exit", (x) => r(x)));
      expect(code).toBe(130);
      expect(stdout).not.toContain("ACTED");
      expect(stderr).toBe("");
      expect(local.rpcs.filter((r) => r.method === "tools/call" && r.params?.name === "act")).toEqual([]);
      expect(local.requests.filter((q) => q.method === "DELETE")).toMatchObject([{ status: 200 }]);
    });

    it("waits for a cleanup registered after Ctrl-C before returning (the session is ended before exit)", async () => {
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      let ended = false;
      let connected!: () => void;
      const pending = runMain(async ({ onExit }: RunContext) => {
        await new Promise<void>((r) => (connected = r));
        onExit(() => new Promise<void>((r) => setTimeout(() => ((ended = true), r()), 200))); // a slow DELETE
        throw new Error("the Chain MCP client is closed");
      });
      await new Promise((r) => setTimeout(r, 10));
      process.emit("SIGINT", "SIGINT");
      connected();
      expect(await pending).toBe(130);
      expect(ended).toBe(true);
    });

    it.each(["SIGINT", "SIGTERM"] as const)(
      "%s to the CLI process alone, during a send to a busy local server, still prints the hash (real process)",
      { timeout: 30_000 },
      async (sig) => {
        const env = {
          PATH: process.env.PATH ?? "",
          HOME: dir(),
          PHAROS_MCP_BIN: helper("fake-chain-busy.mjs"),
          PRIVATE_KEY: generatePrivateKey(),
        };
        // node itself (not the tsx wrapper), so the signal reaches only the CLI and not the server child
        const c = spawn(process.execPath, ["--import", "tsx", helper("send-child.ts")], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        c.stdout.on("data", (d) => (stdout += d));
        c.stderr.on("data", (d) => (stderr += d));
        await vi.waitFor(() => expect(stdout).toContain("SIGNED 0x"), { timeout: 15_000 });
        await new Promise((r) => setTimeout(r, 500)); // the send is in flight
        const hash = /SIGNED (0x[0-9a-f]{64})/.exec(stdout)![1];
        const t0 = Date.now();
        c.kill(sig);
        const code = await new Promise<number | null>((r) => c.on("exit", (x) => r(x)));
        expect(code).toBe(sig === "SIGINT" ? 130 : 143);
        expect(stderr).toContain(`could not tell whether ${hash} (nonce 1) was sent: the Chain MCP client is closed before the node answered`);
        expect(Date.now() - t0).toBeLessThan(5_000);
      },
    );

    it("SIGHUP is handled too (exit 129)", async () => {
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const order: string[] = [];
      const pending = runMain(inFlight(order));
      await new Promise((r) => setTimeout(r, 10));
      process.emit("SIGHUP", "SIGHUP");
      expect(await pending).toBe(129);
      expect(order).toEqual(["closed"]);
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

  it("isMain is true only for the script being run: by path, symlink, without extension, or by its folder", () => {
    expect(isMain(import.meta.url)).toBe(false);
    expect(isMain(pathToFileURL(process.argv[1]).href)).toBe(true);
    const index = join(REPO_ROOT, "tasks/_template/index.ts");
    const link = join(dir(), "link.ts");
    symlinkSync(index, link);
    const saved = process.argv[1];
    try {
      for (const entry of [link, join(REPO_ROOT, "tasks/_template/index"), join(REPO_ROOT, "tasks/_template")]) {
        process.argv[1] = entry;
        expect(isMain(pathToFileURL(index).href)).toBe(true);
      }
      process.argv[1] = join(REPO_ROOT, "tasks");
      expect(isMain(pathToFileURL(index).href)).toBe(false);
    } finally {
      process.argv[1] = saved;
    }
  });

  it("a task built from the template can be imported by its tests, and its main run", async () => {
    const local = await startLocal("sse", {
      sessions: true,
      tool: (n) => ({ content: [{ type: "text", text: JSON.stringify(n === "get_chain_info" ? { chainId: 1672 } : { blockNumber: "7" }) }] }),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.PHAROS_MCP_URL = local.url;
    try {
      const mod = await import("../tasks/_template/index.js");
      expect(await runMain((ctx) => mod.main(ctx, ["--network", "pharos"]))).toBe(0);
      expect(log).toHaveBeenCalledWith(`pharos (chain 1672) block 7 via ${local.url}`);
      expect(local.requests.filter((q) => q.method === "DELETE")).toHaveLength(1);
    } finally {
      delete process.env.PHAROS_MCP_URL;
    }
  });

  it("runCli still exits on a signal within about 2 s when main ignores the cleanup", { timeout: 15_000 }, async () => {
    const c = spawn(TSX, [helper("hang-child.ts")], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((r) => c.stdout.on("data", (d) => String(d).includes("READY") && r()));
    const t0 = Date.now();
    c.kill("SIGTERM");
    const code = await Promise.race([new Promise<number | null>((r) => c.on("exit", (x) => r(x))), new Promise<string>((r) => setTimeout(() => r("still running"), 6_000))]);
    c.kill("SIGKILL");
    expect(code).toBe(143);
    expect(Date.now() - t0).toBeLessThan(4_500);
  });

  it("runCli delivers all output, stdout and stderr, through a pipe before exiting", { timeout: 20_000 }, async () => {
    const { stdout } = await run(TSX, [helper("print-child.ts"), "300000"], { maxBuffer: 10_000_000 });
    expect(stdout.length).toBe(300_000);
    const { stderr } = await run(TSX, [helper("print-child.ts"), "300000", "err"], { maxBuffer: 10_000_000 });
    expect(stderr.length).toBe(300_000);
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

  it("reads env files into a map, first non-blank value wins, missing files skipped, and never writes process.env", () => {
    const d = dir();
    writeFileSync(join(d, "a.env"), "BEACON_FAKE_KEY=0xaaa\nBEACON_ONLY_A=1\nBEACON_BLANK_IN_A=\n");
    writeFileSync(join(d, "b.env"), "BEACON_FAKE_KEY=0xbbb\nBEACON_ONLY_B=2\nBEACON_BLANK_IN_A=from-b\n");
    expect(readEnvFiles([join(d, "missing.env"), join(d, "a.env"), join(d, "b.env")])).toEqual({
      BEACON_FAKE_KEY: "0xaaa",
      BEACON_ONLY_A: "1",
      BEACON_ONLY_B: "2",
      BEACON_BLANK_IN_A: "from-b", // a blank placeholder copied from .env.example does not hide a real value
    });
    expect(process.env.BEACON_FAKE_KEY).toBeUndefined();
  });

  describe("sources and precedence, as a real process with HOME pointed at a temp dir", () => {
    const home = dir();
    const fileKey = generatePrivateKey();
    const shellKey = generatePrivateKey();
    const fp = (k: string) => createHash("sha256").update(k).digest("hex").slice(0, 8);
    mkdirSync(join(home, ".config/pharos"), { recursive: true });
    writeFileSync(join(home, ".config/pharos/testnet.env"), `PRIVATE_KEY=${fileKey}\nBEACON_T_URL=http://from-file/\n`);
    const child = async (env: Record<string, string> = {}) =>
      JSON.parse((await run(TSX, [helper("env-child.ts")], { env: { PATH: process.env.PATH ?? "", HOME: home, ...env } })).stdout);

    it("reads the key and settings from ~/.config/pharos/testnet.env and never puts the key in process.env", { timeout: 20_000 }, async () => {
      expect(await child()).toEqual({ url: "http://from-file/", key: fp(fileKey), keyInProcessEnv: false });
    });

    it("lets the shell win over the file, but a blank shell value falls back to the file", { timeout: 20_000 }, async () => {
      expect(await child({ BEACON_T_URL: "http://from-shell/", PRIVATE_KEY: shellKey })).toMatchObject({ url: "http://from-shell/", key: fp(shellKey) });
      expect(await child({ BEACON_T_URL: "  ", PRIVATE_KEY: "" })).toMatchObject({ url: "http://from-file/", key: fp(fileKey) });
    });
  });

  it("resolves the repo root from the module, not the working directory", () => {
    expect(existsSync(join(REPO_ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "src/lib/env.ts"))).toBe(true);
  });
});
