// Vercel Function (Node runtime) for the Docs MCP + Chain MCP Agent demo page. Read-only, Pharos mainnet through the hosted
// Chain MCP and the hosted Docs MCP. ?action=info · ?action=run&preset=… — see tasks/docs-chain-mcp-agent/web.ts.
import { handle } from "../tasks/docs-chain-mcp-agent/web.js";

export const config = { maxDuration: 120 };
export const GET = handle;
