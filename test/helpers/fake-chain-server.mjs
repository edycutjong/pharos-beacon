// Stand-in for the sponsor Chain MCP over stdio (tests only). Reports the chain from PHAROS_CHAIN_ID like the real
// server, lists the environment variable NAMES it received (never values), answers a few reads with fixed values, and
// can crash or stall on request. Call counts survive a restart in a file keyed by the parent's pid.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const state = join(tmpdir(), `beacon-fake-chain-${process.ppid}.json`);
const counts = () => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {});
const PERSISTED = new Set(["crash_once", "send_raw_transaction"]); // counted across a restart by tests
const count = (name) => {
  if (!PERSISTED.has(name)) return;
  const c = counts();
  c[name] = (c[name] ?? 0) + 1;
  writeFileSync(state, JSON.stringify(c));
  return c[name];
};
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const tool = (name, fn) => server.registerTool(name, { inputSchema: {} }, async (args) => (count(name), fn(args)));

const server = new McpServer({ name: "fake-pharos-mcp", version: "0.0.1" });
tool("get_chain_info", () => ok({ chainId: Number(process.env.PHAROS_CHAIN_ID), chainIdMatches: true }));
tool("env_names", () => ok(Object.keys(process.env).sort()));
tool("get_block_number", () => ok({ blockNumber: "100", blockNumberHex: "0x64" }));
tool("get_gas_price", () => ok({ gasPriceWei: "1000000000", gasPriceGwei: "1", maxPriorityFeePerGasWei: "0" }));
tool("get_code", () => ok({ code: "0x" }));
tool("get_balance", () => ok({ balanceWei: "5000000000000000000" }));
tool("get_transaction_count", () => ok({ nonce: "3" }));
tool("calls", () => ok(counts()));
tool("crash", () => {
  process.stderr.write("fake server: crashing on request\n");
  process.exit(3);
});
// Crashes the first time it is called in a test run, answers after the restart.
tool("crash_once", () => {
  if (counts().crash_once === 1) process.exit(3);
  return ok({ answered: true });
});
// A broadcast that never answers: the caller must time out and must not resend it.
tool("send_raw_transaction", () => new Promise(() => {}));
await server.connect(new StdioServerTransport());
