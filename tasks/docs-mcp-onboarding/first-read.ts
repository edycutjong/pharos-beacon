// The "first read" of the Docs MCP Onboarding log, done exactly as the docs answers said (ONBOARDING.md steps 6 and 9):
//   1. the hosted Pharos MCP (https://mcp.pharos.xyz/mcp, mainnet): chain info + the WPROS token the registry answer named
//   2. a self-hosted pharos-mcp pointed at Atlantic (PHAROS_MCP_BIN=<built pharos-mcp>/dist/src/index.js): chain info + a balance
//   npm run docs-onboarding:first-read -- [--atlantic-address 0x…] [--proof]
import { getAddress, isAddress } from "viem";
import { isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { formatState, readState } from "../read-contract-state/index.js";

const TASK = "docs-mcp-onboarding";
/** WPROS on Pharos mainnet, as answered by the Docs MCP (transcript #10). */
const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseCli({ usage: "docs-onboarding:first-read [--atlantic-address 0x…] [--proof]", options: { "atlantic-address": { type: "string" }, proof: { type: "boolean", default: false } } }, argv);
  const who = values["atlantic-address"];
  if (who !== undefined && !isAddress(who)) throw new UsageError("--atlantic-address must be an address");

  const main = await chainMcp("pharos");
  onExit(() => main.close());
  const head = BigInt((await main.call("get_block_number")).blockNumber);
  const state = await readState(main.call, getAddress(WPROS), head, []);
  console.log(`# hosted Pharos MCP (${main.endpoint}), chain ${main.chainId}\n${formatState(state)}\n`);
  const body: Record<string, unknown> = { mainnet: { head: head.toString(), state } };
  const metaFrom = main;

  if (who) {
    const atl = await chainMcp("atlantic"); // spawns the self-hosted pharos-mcp (PHAROS_MCP_BIN)
    onExit(() => atl.close());
    const block = (await atl.call("get_block_number")).blockNumber;
    const bal = await atl.call("get_balance", { address: getAddress(who) });
    console.log(`# self-hosted pharos-mcp -> Atlantic, chain ${atl.chainId}\nblock ${block}\nget_balance(${getAddress(who)}) = ${JSON.stringify(bal)}`);
    body.atlantic = { block, address: getAddress(who), balance: bal, chainId: atl.chainId };
  }
  if (values.proof) console.log(`proof: ${writeProof(new URL("proof/first-read.json", import.meta.url), body, proofMeta(TASK, metaFrom))}`);
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
