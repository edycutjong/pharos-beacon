// dApp Support Agent (Easy · 50 pts): give it a transaction hash, get a plain-language reason it failed and what to do.
//   npm run dapp-support-agent -- 0x<txHash> [--network atlantic|pharos] [--json] [--proof label]
// Reads the transaction, its receipt and a replay of the call one block earlier through the Pharos Chain MCP.
import { isHex, type Hex } from "viem";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp, NETWORKS, type ChainMcp, type Network } from "../../src/lib/mcp.js";
import { atlantic, pharos } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { diagnose, formatDiagnosis } from "./diagnose.js";

const TASK = "dapp-support-agent";
type Connect = (n: Network) => Promise<Pick<ChainMcp, "call" | "close" | "endpoint" | "network" | "chainId" | "server">>;

export async function main({ onExit }: RunContext, argv = process.argv.slice(2), connect: Connect = (n) => chainMcp(n)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- 0x<txHash> [--network atlantic|pharos] [--json] [--proof label]`,
      options: { network: { type: "string", default: "atlantic" }, json: { type: "boolean", default: false }, proof: { type: "string" } },
      positionals: [1, 1],
    },
    argv,
  );
  const hash = positionals[0]!;
  if (!isHex(hash) || hash.length !== 66) throw new UsageError(`a transaction hash is 0x followed by 64 hex characters (got ${JSON.stringify(hash)})`);
  if (values.proof !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(values.proof)) throw new UsageError("--proof label must be lowercase letters, digits and hyphens");
  const network = choice("--network", values.network, NETWORKS);
  const mcp = await connect(network);
  onExit(() => mcp.close());
  const d = await diagnose(mcp.call, hash as Hex);
  const chain = network === "pharos" ? pharos : atlantic;
  const label = `${network} (chain ${chain.id}) via ${mcp.endpoint}`;
  console.log(values.json ? JSON.stringify(d, null, 2) : formatDiagnosis(d, { label, explorer: chain.blockExplorers.default.url }));
  if (values.proof) console.log(`proof: ${writeProof(new URL(`proof/${values.proof}.json`, import.meta.url), { diagnosis: d }, proofMeta(TASK, mcp))}`);
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
