// Like fake-chain-server.mjs, but a send_raw_transaction in flight keeps the event loop alive, as the real sponsor server
// does while its own RPC request is pending: it does not exit as soon as its stdin closes (tests only).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const server = new McpServer({ name: "fake-pharos-mcp", version: "0.0.1" });
server.registerTool("get_chain_info", { inputSchema: {} }, async () => ok({ chainId: Number(process.env.PHAROS_CHAIN_ID), chainIdMatches: true }));
server.registerTool("send_raw_transaction", { inputSchema: {} }, () => new Promise(() => setInterval(() => {}, 1_000)));
process.stdin.on("end", () => setTimeout(() => process.exit(0), 6_000).unref()); // never outlive a failed test for long
await server.connect(new StdioServerTransport());
