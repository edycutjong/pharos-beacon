// Test helper: a task that connects to the Chain MCP at argv[2], then calls the tool "act". A Ctrl-C during the
// connect must stop it before it acts, and still end the session (tests only).
import { runCli } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";

await runCli(async ({ onExit }) => {
  console.log("CONNECTING");
  const mcp = await chainMcp("pharos", { url: process.argv[2], perMinute: 0 });
  onExit(() => mcp.close());
  await mcp.call("act");
  console.log("ACTED");
  return 0;
});
