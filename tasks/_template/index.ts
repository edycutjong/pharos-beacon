import { chainMcp, callTool } from "../../src/lib/mcp.js";

const mcp = await chainMcp();
console.log(await callTool(mcp, "get_block_number"));
await mcp.close();
