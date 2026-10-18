// Makes REAL failed transactions on Atlantic for the dApp Support Agent to explain. Each is signed with an explicit gas
// limit (so the node does not refuse it at estimate time) and mined with status 0x0. A dry run unless --execute.
//   npm run make-failed-txs -- [--only balance|allowance|out-of-gas|empty-revert]… [--execute] [--proof]
import { encodeFunctionData, erc20Abi, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseCli, runCli, UsageError } from "../src/lib/cli.js";
import { secret } from "../src/lib/env.js";
import { chainMcp } from "../src/lib/mcp.js";
import { explorerTx, TOKENS } from "../src/lib/networks.js";
import { proofMeta, writeProof } from "../src/lib/proof.js";
import { testnetSigner } from "../src/lib/signer.js";

const wphrs = parseAbi(["function deposit() payable", "function withdraw(uint256)"]);
const USDC = TOKENS.atlantic.USDC.address as Hex;
const WPHRS = TOKENS.atlantic.WPHRS.address as Hex;
const KINDS = ["balance", "allowance", "out-of-gas", "empty-revert"] as const;

await runCli(async ({ onExit, signal }) => {
  const { values } = parseCli({
    usage: "npm run make-failed-txs -- [--only balance|allowance|out-of-gas|empty-revert]… [--execute] [--proof]",
    options: { only: { type: "string", multiple: true }, execute: { type: "boolean", default: false }, proof: { type: "boolean", default: false } },
  });
  const only = new Set(values.only ?? KINDS);
  for (const k of only) if (!(KINDS as readonly string[]).includes(k)) throw new UsageError(`unknown --only ${k}`);
  const pk2 = secret("PRIVATE_KEY_2");
  if (!pk2) throw new UsageError("PRIVATE_KEY_2 not set: the second test wallet is the recipient / owner");
  const other = privateKeyToAccount(pk2 as Hex).address;
  const mcp = await chainMcp("atlantic", { broadcast: values.execute });
  onExit(() => mcp.close());
  const signer = testnetSigner(mcp);
  const gas = 100_000n;
  const plan: Record<(typeof KINDS)[number], { label: string; intent: { to: Hex; value?: bigint; data: Hex; gas: bigint } }> = {
    balance: { label: "USDC transfer of 1,000,000,000 USDC from a wallet that holds none", intent: { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [other, 10n ** 15n] }), gas } },
    allowance: { label: "USDC transferFrom(owner → me, 1 unit) with no approval", intent: { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [other, signer.address, 1n] }), gas } },
    "out-of-gas": { label: "WPHRS deposit of 0.001 PHRS with a 24,000 gas limit (needs more)", intent: { to: WPHRS, value: parseEther("0.001"), data: encodeFunctionData({ abi: wphrs, functionName: "deposit" }), gas: 24_000n } },
    "empty-revert": { label: "WPHRS withdraw of 1,000,000 WPHRS from a wallet that holds less", intent: { to: WPHRS, data: encodeFunctionData({ abi: wphrs, functionName: "withdraw", args: [parseEther("1000000")] }), gas } },
  };
  const made: { kind: string; label: string; hash: Hex; block: string; status: string; gasLimit: string; gasUsed: string; explorer: string }[] = [];
  for (const kind of KINDS) {
    if (!only.has(kind)) continue;
    if (signal.aborted) return 130;
    const { label, intent } = plan[kind];
    if (!values.execute) {
      console.log(`dry run: would send ${label}`);
      continue;
    }
    const signed = await signer.send(intent);
    const r = await signer.waitForReceipt(signed.hash);
    console.log(`${kind}: ${r.status} in block ${r.blockNumber} · gasUsed ${r.gasUsed}/${intent.gas}\n  ${explorerTx("atlantic", signed.hash)}`);
    made.push({ kind, label, hash: signed.hash, block: r.blockNumber.toString(), status: r.status, gasLimit: intent.gas.toString(), gasUsed: r.gasUsed.toString(), explorer: explorerTx("atlantic", signed.hash) });
    if (r.status !== "reverted") throw new Error(`${kind} was supposed to fail but ${r.status}: not a failed transaction`);
  }
  if (values.proof && values.execute) console.log(`proof: ${writeProof(new URL(`../tasks/dapp-support-agent/proof/failed-txs-${made.map((m) => m.kind).join("+")}.json`, import.meta.url), { sender: signer.address, failed: made }, proofMeta("dapp-support-agent", mcp))}`);
  return 0;
});
