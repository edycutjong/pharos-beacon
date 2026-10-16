// <Task name> (<Tier> · <points> pts): <one line from the Arena board>.
//   npm run <slug> -- [--network pharos|atlantic] [--proof]
// To start a task: copy this folder to tasks/<slug>/, add "<slug>": "tsx tasks/<slug>/index.ts" to package.json's
// scripts, and keep the shape: parse flags → open the Chain MCP → read → decide → print → --proof writes proof/*.json.
// Sending on Atlantic: chainMcp("atlantic", { broadcast: true }) + testnetSigner(mcp) from src/lib/signer.ts.
// Ranges of logs: getLogsRange(mcp.call, …). State across runs: src/lib/state.ts. Tests: tasks/<slug>/*.test.ts.
import { choice, parseCli, runCli } from "../../src/lib/cli.js";
import { chainMcp, NETWORKS } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";

const TASK = "<slug>";

await runCli(async ({ onExit }) => {
  const { values } = parseCli({
    usage: `npm run ${TASK} -- [--network pharos|atlantic] [--proof]`,
    options: { network: { type: "string", default: "pharos" }, proof: { type: "boolean", default: false } },
  });
  const network = choice("--network", values.network, NETWORKS);

  const mcp = await chainMcp(network); // checks the endpoint serves the expected chain, or throws
  onExit(() => mcp.close());

  const { blockNumber } = await mcp.call("get_block_number");
  console.log(`${network} (chain ${mcp.chainId}) block ${blockNumber} via ${mcp.endpoint}`);

  if (values.proof) {
    console.log(`proof: ${writeProof(new URL(`proof/${network}.json`, import.meta.url), { blockNumber }, proofMeta(TASK, mcp))}`);
  }
  return 0; // 0 = done; return 1 for an outcome that should fail a script (e.g. a reverted tx)
});
