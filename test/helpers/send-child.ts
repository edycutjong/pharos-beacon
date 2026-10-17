// Test helper: a task that signs a fully specified transaction, prints its hash, then broadcasts it through the
// Atlantic Chain MCP (the fake busy server). A signal mid-send must still end with the hash on stderr (tests only).
import { runCli } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { testnetSigner } from "../../src/lib/signer.js";

await runCli(async ({ onExit }) => {
  const mcp = await chainMcp("atlantic", { broadcast: true, perMinute: 0 });
  onExit(() => mcp.close());
  const s = testnetSigner(mcp);
  const signed = await s.sign(await s.prepare({ to: s.address, nonce: 1, gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 0n }));
  console.log(`SIGNED ${signed.hash}`);
  await s.broadcast(signed);
  return 0;
});
