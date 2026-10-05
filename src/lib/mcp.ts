import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Hosted Pharos Chain MCP: mainnet, read-only, keyless, 120 req/min per IP.
export const CHAIN_MCP_URL = process.env.PHAROS_MCP_URL ?? "https://mcp.pharos.xyz/mcp";

export async function chainMcp() {
  const client = new Client({ name: "beacon", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(CHAIN_MCP_URL)));
  return client;
}

/** Call a Chain MCP tool and parse its first text block as JSON (falls back to raw text). */
export async function callTool<T = unknown>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const block = (res.content as { type: string; text?: string }[]).find((c) => c.type === "text");
  if (res.isError) throw new Error(`${name}: ${block?.text ?? "error"}`);
  try {
    return JSON.parse(block?.text ?? "null") as T;
  } catch {
    return block?.text as T;
  }
}
