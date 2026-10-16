import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError, choice, parseCli, runMain } from "../src/lib/cli.js";
import { REPO_ROOT, envOr } from "../src/lib/env.js";
import { proofMeta, writeProof } from "../src/lib/proof.js";
import { readState, toJson, withLock, writeJsonAtomic } from "../src/lib/state.js";

const dir = () => mkdtempSync(join(tmpdir(), "beacon-test-"));

describe("state", () => {
  it("writes JSON atomically (no temp file left) and turns bigints into strings", () => {
    const d = dir();
    const f = join(d, "sub/state.json");
    writeJsonAtomic(f, { cursor: 20_427_518n, seen: ["a"] });
    expect(readFileSync(f, "utf8")).toBe('{\n  "cursor": "20427518",\n  "seen": [\n    "a"\n  ]\n}\n');
    expect(readdirSync(join(d, "sub"))).toEqual(["state.json"]);
  });

  it("reads the fallback for a missing file, and refuses to guess on a corrupt one", () => {
    const d = dir();
    expect(readState(join(d, "none.json"), { n: 0 })).toEqual({ n: 0 });
    writeFileSync(join(d, "bad.json"), '{"n": 1');
    expect(() => readState(join(d, "bad.json"), { n: 0 })).toThrow(/not valid JSON; refusing to guess/);
  });

  it("holds a lock while acting: a second run fails at once, and the lock is released even when the action throws", async () => {
    const f = join(dir(), "pay.json");
    let inner = "";
    await withLock(f, async () => {
      inner = await withLock(f, async () => "second").catch((e: Error) => e.message);
    });
    expect(inner).toMatch(/held by another run .* not acting twice/);
    await expect(withLock(f, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(existsSync(`${f}.lock`)).toBe(false);
    expect(await withLock(f, async () => "free again")).toBe("free again");
  });

  it("takes over a lock left by a crashed run once it is older than staleMs", async () => {
    const f = join(dir(), "pay.json");
    writeFileSync(`${f}.lock`, "999999\n");
    await expect(withLock(f, async () => "x")).rejects.toThrow(/held by another run/);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(`${f}.lock`, old, old);
    expect(await withLock(f, async () => "taken over")).toBe("taken over");
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
    expect(typeof meta.git?.dirty).toBe("boolean");
    expect(Date.parse(meta.createdAt)).not.toBeNaN();
  });

  it("writes { meta, ...body } and returns the path relative to the repo", () => {
    const f = join(dir(), "proof/run.json");
    const meta = proofMeta("t", mcp, ["node", "x.ts"]);
    const out = writeProof(f, { block: 7n, ok: true }, meta);
    expect(out.endsWith("proof/run.json")).toBe(true);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ meta: JSON.parse(JSON.stringify(meta)), block: "7", ok: true });
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
  });
});

describe("env", () => {
  it("treats blank as unset, so the blank placeholders in .env.example fall back to the default", () => {
    process.env.BEACON_TEST_URL = "   ";
    expect(envOr("BEACON_TEST_URL", "https://default")).toBe("https://default");
    process.env.BEACON_TEST_URL = " https://set ";
    expect(envOr("BEACON_TEST_URL", "https://default")).toBe("https://set");
    delete process.env.BEACON_TEST_URL;
    expect(envOr("BEACON_TEST_URL", "https://default")).toBe("https://default");
  });

  it("resolves the repo root from the module, not the working directory", () => {
    expect(existsSync(join(REPO_ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "src/lib/env.ts"))).toBe(true);
  });
});
