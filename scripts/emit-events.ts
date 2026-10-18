// Makes real, small events on Atlantic for the Event/Log Monitor and the On-Chain Alert Bot to catch: wrap PHRS into
// WPHRS (a Deposit event), then move WPHRS to the second test wallet (Transfer events). A dry run (prepare + sign,
// nothing sent) unless --execute. Testnet only, by the shared signer.
//   npm run emit-events -- [--wrap 0.01] [--transfer 0.01] [--small 0.0001] [--execute]
import { encodeFunctionData, erc20Abi, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseCli, runCli, UsageError } from "../src/lib/cli.js";
import { secret } from "../src/lib/env.js";
import { chainMcp } from "../src/lib/mcp.js";
import { explorerTx, TOKENS } from "../src/lib/networks.js";
import { testnetSigner } from "../src/lib/signer.js";

const WPHRS = TOKENS.atlantic.WPHRS.address as Hex;
const weth = parseAbi(["function deposit() payable"]);

await runCli(async ({ onExit, signal }) => {
  const { values } = parseCli({
    usage: "npm run emit-events -- [--wrap 0.01] [--transfer 0.01] [--small 0.0001] [--execute]",
    options: { wrap: { type: "string", default: "0.01" }, transfer: { type: "string", default: "0.01" }, small: { type: "string" }, execute: { type: "boolean", default: false } },
  });
  const pk2 = secret("PRIVATE_KEY_2");
  if (!pk2) throw new UsageError("PRIVATE_KEY_2 not set: the second test wallet is the recipient (a distinct address, never a self-transfer)");
  const to = privateKeyToAccount(pk2 as Hex).address;
  const mcp = await chainMcp("atlantic", { broadcast: values.execute });
  onExit(() => mcp.close());
  const signer = testnetSigner(mcp);
  if (signer.address.toLowerCase() === to.toLowerCase()) throw new UsageError("PRIVATE_KEY and PRIVATE_KEY_2 are the same wallet");
  const steps: { label: string; intent: { to: Hex; value?: bigint; data: Hex } }[] = [
    { label: `wrap ${values.wrap} PHRS → WPHRS (Deposit)`, intent: { to: WPHRS, value: parseEther(values.wrap!), data: encodeFunctionData({ abi: weth, functionName: "deposit" }) } },
    { label: `transfer ${values.transfer} WPHRS → ${to} (Transfer)`, intent: { to: WPHRS, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, parseEther(values.transfer!)] }) } },
    ...(values.small ? [{ label: `transfer ${values.small} WPHRS → ${to} (Transfer, small)`, intent: { to: WPHRS, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, parseEther(values.small)] }) } }] : []),
  ];
  for (const s of steps) {
    if (signal.aborted) return 130;
    if (!values.execute) {
      console.log(`dry run: would ${s.label}`);
      continue;
    }
    const signed = await signer.send(s.intent);
    const r = await signer.waitForReceipt(signed.hash);
    console.log(`${s.label}: ${r.status} in block ${r.blockNumber}\n  ${explorerTx("atlantic", signed.hash)}`);
    if (r.status !== "success") return 1;
  }
  return 0;
});
