// Stand-in for the sponsor Chain MCP over stdio (tests only). Reports the chain from PHAROS_CHAIN_ID like the real
// server, lists the environment variable NAMES it received (never values), and can crash on request.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "fake-pharos-mcp", version: "0.0.1" });
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
server.registerTool("get_chain_info", { inputSchema: {} }, async () => ok({ chainId: Number(process.env.PHAROS_CHAIN_ID), chainIdMatches: true }));
server.registerTool("env_names", { inputSchema: {} }, async () => ok(Object.keys(process.env).sort()));
server.registerTool("crash", { inputSchema: {} }, async () => {
  process.stderr.write("fake server: crashing on request\n");
  process.exit(3);
});
await server.connect(new StdioServerTransport());
