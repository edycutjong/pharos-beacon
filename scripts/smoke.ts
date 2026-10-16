// Proves the toolchain end to end: Chain MCP (mainnet), testnet RPC, and the signing wallet (if a key is set).
import { formatEther } from "viem";
import { chainMcp } from "../src/lib/mcp.js";
import { testnet, wallet } from "../src/lib/chain.js";

const mcp = await chainMcp();
try {
  const tools = await mcp.listTools();
  console.log(`Chain MCP ${mcp.server?.name} ${mcp.server?.version} at ${mcp.endpoint}, chain ${mcp.chainId}: ${tools.length} tools — ${tools.map((t) => t.name).join(", ")}`);
  console.log("get_chain_info:", await mcp.call("get_chain_info"));
} finally {
  await mcp.close();
}

const block = await testnet.getBlockNumber();
if (process.env.PRIVATE_KEY) {
  const w = wallet();
  const bal = await testnet.getBalance({ address: w.account.address });
  console.log(`Atlantic testnet block ${block}; wallet ${w.account.address} holds ${formatEther(bal)} PHRS`);
} else {
  console.log(`Atlantic testnet block ${block}; no PRIVATE_KEY set, so wallet check skipped`);
}
