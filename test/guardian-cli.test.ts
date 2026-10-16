// The Threshold Guardian CLI end to end, as a user runs it: real process, real SDK transport, a local Chain MCP standing
// in for the hosted one (mainnet) and the fake stdio server for Atlantic. Pins its output, verdicts and exit codes.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/lib/env.js";
import { startLocal } from "./helpers/local-mcp.js";

const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";
const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/** Run the CLI with no keys available (HOME points at an empty directory). */
function guard(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "beacon-home-"));
  return new Promise((resolve) => {
    execFile(
      join(REPO_ROOT, "node_modules/.bin/tsx"),
      [join(REPO_ROOT, "tasks/threshold-guardian/index.ts"), ...args],
      { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", HOME: home, ...env } },
      (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code) : 0, stdout, stderr }),
    );
  });
}

function policyFile(policy: unknown): string {
  const f = join(mkdtempSync(join(tmpdir(), "beacon-policy-")), "p.json");
  writeFileSync(f, JSON.stringify(policy));
  return f;
}

const mainnetConditions = (gasCeiling: string) => [
  { kind: "gas_price", op: "lte", gwei: gasCeiling },
  { kind: "is_contract", address: WPROS, expect: true },
  { kind: "native_balance", address: WPROS, op: "gte", value: "1" },
  { kind: "log_activity", address: USDC, blocks: 1000, op: "gte", count: 1 },
];

async function mainnetServer() {
  return startLocal("sse", {
    sessions: true,
    serverInfo: { name: "pharos-mcp-server", version: "0.1.0" },
    tool: (name) =>
      ({
        get_chain_info: json({ chainId: 1672, chainIdMatches: true }),
        get_block_number: json({ blockNumber: "500" }),
        get_gas_price: json({ gasPriceWei: "10000000000", maxPriorityFeePerGasWei: "0" }),
        get_code: json({ code: "0x6080" }),
        get_balance: json({ balanceWei: "2000000000000000000" }),
        get_logs: json([{}, {}]),
      })[name] ?? { content: [{ type: "text", text: "unknown tool" }], isError: true },
  });
}

describe("threshold-guardian CLI", { timeout: 30_000 }, () => {
  it("ALLOW on mainnet: one line per condition, the verdict, status dry-run, exit 0", async () => {
    const local = await mainnetServer();
    const r = await guard([policyFile({ name: "allow", network: "pharos", conditions: mainnetConditions("20") })], { PHAROS_MCP_URL: local.url });
    expect(r).toMatchObject({ code: 0, stderr: "" });
    expect(r.stdout).toBe(
      [
        "allow @ pharos block 500",
        "  PASS  gas price: 10 gwei (need <= 20 gwei)",
        `  PASS  ${WPROS} is a contract: contract (2 bytes) (need contract)`,
        `  PASS  native balance of ${WPROS}: 2 PROS (need >= 1 PROS)`,
        `  PASS  events from ${USDC} in last 1000 blocks: 2 logs (need >= 1)`,
        "  => ALLOW (4/4 conditions pass)",
        "status: dry-run",
        "",
      ].join("\n"),
    );
    const logs = local.rpcs.find((r) => r.params?.name === "get_logs");
    expect(logs?.params.arguments).toMatchObject({ fromBlock: "0", toBlock: "500" }); // the window is clamped at genesis
    expect(local.requests.filter((q) => q.method === "DELETE")).toHaveLength(1); // the session is ended on exit
  });

  it("DENY on mainnet: names the failing condition, status denied, exit 1", async () => {
    const local = await mainnetServer();
    const r = await guard([policyFile({ name: "deny", network: "pharos", conditions: mainnetConditions("5") })], { PHAROS_MCP_URL: local.url });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("  FAIL  gas price: 10 gwei (need <= 5 gwei)");
    expect(r.stdout).toMatch(/=> DENY \(3\/4 conditions pass\)\nstatus: denied\n$/);
  });

  it("reads Atlantic policies from the local stdio server, not the hosted one", async () => {
    const policy = {
      name: "atl",
      network: "atlantic",
      conditions: [
        { kind: "gas_price", op: "lte", gwei: "50" },
        { kind: "is_contract", address: WPROS, expect: false },
      ],
    };
    const r = await guard([policyFile(policy)], {
      PHAROS_MCP_BIN: fileURLToPath(new URL("./helpers/fake-chain-server.mjs", import.meta.url)),
      PHAROS_MCP_URL: "http://127.0.0.1:9/mcp", // must not be used
    });
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout).toMatch(/^atl @ atlantic block 100\n[\s\S]*=> ALLOW \(2\/2 conditions pass\)\nstatus: dry-run\n$/);
  });

  it("exits 2 with the reason for a missing argument or an invalid policy, before any network call", async () => {
    const usage = await guard([]);
    expect(usage).toMatchObject({ code: 2, stdout: "" });
    expect(usage.stderr).toMatch(/^usage: guard <policy.json> \[--execute\] \[--proof\]/);
    const f = policyFile({ name: "bad", network: "ethereum", conditions: [] });
    const bad = await guard([f]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain(`${f}: invalid policy: network must be "pharos" or "atlantic"`);
  });

  it("stops with one error line and exit 1 when the Chain MCP cannot be reached: nothing is evaluated", async () => {
    const r = await guard([policyFile({ name: "x", network: "pharos", conditions: mainnetConditions("20") })], { PHAROS_MCP_URL: "http://127.0.0.1:9/mcp" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^error: fetch failed/);
  });
});
