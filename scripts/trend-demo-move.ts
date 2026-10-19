// Moves the tracked Atlantic wallet's balance for the Trend Watcher demo with a REAL transaction between our two test wallets.
//   npm run trend-demo-move -- fall|rise [--amount 0.001]   fall: wallet 2 → wallet 1 (tracked wallet 2 pays amount + gas)
//                                                            rise: wallet 1 → wallet 2 (tracked wallet 2 receives amount)
// Atlantic testnet only (the shared signer refuses anything else). Prints the tracked address and the explorer link.
import { parseEther } from "viem";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../src/lib/cli.js";
import { chainMcp } from "../src/lib/mcp.js";
import { explorerTx } from "../src/lib/networks.js";
import { testnetSigner } from "../src/lib/signer.js";

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli({ usage: "npm run trend-demo-move -- fall|rise [--amount 0.001]", options: { amount: { type: "string", default: "0.001" } }, positionals: [1, 1] }, argv);
  const dir = choice("direction", positionals[0], ["fall", "rise"] as const);
  let wei: bigint;
  try { wei = parseEther(values.amount!); } catch { throw new UsageError("--amount must be an amount of PHRS"); }
  const mcp = await chainMcp("atlantic", { broadcast: true });
  onExit(() => mcp.close());
  const w1 = testnetSigner(mcp), w2 = testnetSigner(mcp, { envVar: "PRIVATE_KEY_2" });
  console.log(`tracked wallet (wallet 2): ${w2.address}`);
  const [from, to] = dir === "fall" ? [w2, w1] : [w1, w2];
  const signed = await from.send({ to: to.address, value: wei });
  const r = await from.waitForReceipt(signed.hash);
  console.log(`${dir}: ${r.status} ${explorerTx("atlantic", signed.hash)} (block ${r.blockNumber})`);
  return r.status === "success" ? 0 : 1;
}
if (isMain(import.meta.url)) await runCli(main);
