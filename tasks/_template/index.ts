import { chainMcp } from "../../src/lib/mcp.js";

const mcp = await chainMcp();
try {
  console.log(await mcp.call("get_block_number"));
} finally {
  await mcp.close();
}
