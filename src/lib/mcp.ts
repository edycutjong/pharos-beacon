import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { atlantic } from "./networks.js";

export type Network = "pharos" | "atlantic";

// Hosted Pharos Chain MCP: mainnet, read-only, keyless, 120 req/min per IP.
export const CHAIN_MCP_URL = process.env.PHAROS_MCP_URL ?? "https://mcp.pharos.xyz/mcp";

// The hosted server is mainnet-only, so for Atlantic we run the same sponsor server locally over stdio
// (built by scripts/setup-testnet-mcp.sh). PHAROS_MCP_BIN overrides the path.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const TESTNET_MCP_BIN = process.env.PHAROS_MCP_BIN ?? join(ROOT, ".cache/pharos-mcp/dist/src/index.js");

export async function chainMcp(network: Network = "pharos") {
  const client = new Client({ name: "beacon", version: "0.2.0" });
  if (network === "pharos") {
    await client.connect(new StreamableHTTPClientTransport(new URL(CHAIN_MCP_URL)));
    return client;
  }
  if (!existsSync(TESTNET_MCP_BIN)) throw new Error(`${TESTNET_MCP_BIN} missing — run: npm run setup:mcp`);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [TESTNET_MCP_BIN],
      env: {
        PATH: process.env.PATH ?? "",
        PHAROS_RPC_URL: atlantic.rpcUrls.default.http[0],
        PHAROS_CHAIN_ID: String(atlantic.id),
        PHAROS_NATIVE_SYMBOL: atlantic.nativeCurrency.symbol,
      },
      stderr: "ignore",
    }),
  );
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
