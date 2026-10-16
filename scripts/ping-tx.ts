// Proves the shared signer end to end on Atlantic: nonce, gas and fees read through the Chain MCP, signed locally with
// viem, broadcast through the Chain MCP (send_raw_transaction on the local server), receipt read through the Chain MCP.
// Sends 0 PHRS to its own address, so it costs only gas. A dry run (prepare + sign, nothing sent) unless --execute.
//   npm run ping -- [--execute]
import { formatGwei } from "viem";
import { parseCli, runCli } from "../src/lib/cli.js";
import { chainMcp } from "../src/lib/mcp.js";
import { explorerTx } from "../src/lib/networks.js";
import { testnetSigner } from "../src/lib/signer.js";

await runCli(async ({ onExit }) => {
  const { values } = parseCli({ usage: "npm run ping -- [--execute]", options: { execute: { type: "boolean", default: false } } });
  const mcp = await chainMcp("atlantic", { broadcast: values.execute });
  onExit(() => mcp.close());
  const signer = testnetSigner(mcp);

  const tx = await signer.prepare({ to: signer.address });
  console.log(`prepared via Chain MCP: nonce ${tx.nonce}, gas ${tx.gas}, max fee ${formatGwei(tx.maxFeePerGas)} gwei, priority ${formatGwei(tx.maxPriorityFeePerGas)} gwei`);
  const signed = await signer.sign(tx);
  console.log(`signed locally: ${signed.hash}`);
  if (!values.execute) {
    console.log("dry run: nothing sent (add --execute)");
    return 0;
  }
  await signer.broadcast(signed);
  const r = await signer.waitForReceipt(signed.hash);
  console.log(`${r.status} in block ${r.blockNumber}, gas used ${r.gasUsed}: ${explorerTx("atlantic", signed.hash)}`);
  return r.status === "success" ? 0 : 1;
});
