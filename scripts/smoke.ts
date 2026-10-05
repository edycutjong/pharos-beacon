// Proves the toolchain end to end: Chain MCP (mainnet), testnet RPC, and the signing wallet.
import { formatEther } from "viem";
import { chainMcp, callTool } from "../src/lib/mcp.js";
import { testnet, wallet } from "../src/lib/chain.js";

const mcp = await chainMcp();
const { tools } = await mcp.listTools();
console.log(`Chain MCP: ${tools.length} tools — ${tools.map((t) => t.name).join(", ")}`);
console.log("get_chain_info:", await callTool(mcp, "get_chain_info"));
await mcp.close();

const w = wallet();
const [block, bal] = await Promise.all([testnet.getBlockNumber(), testnet.getBalance({ address: w.account.address })]);
console.log(`Atlantic testnet block ${block}; wallet ${w.account.address} holds ${formatEther(bal)} PHRS`);
