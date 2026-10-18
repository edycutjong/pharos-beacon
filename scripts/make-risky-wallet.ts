// Makes the RISKY example for the Wallet Risk Checker on Atlantic, and says so plainly: a brand-new wallet that WE create and fund
// with 0.01 PHRS, which then (1) wraps a little PHRS, (2) sends WPHRS to an address on OUR flagged list, and (3) gives an address
// we do not list as trusted an unlimited WPHRS allowance. Nothing here is a real attacker; it is a staged example of the signals.
// The wallet's key is generated once into ~/.config/pharos/risk-demo.env (never in the tree). A dry run unless --execute.
//   npm run make-risky-wallet -- [--execute]
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { encodeFunctionData, erc20Abi, getAddress, maxUint256, parseAbi, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseCli, runCli } from "../src/lib/cli.js";
import { readEnvFiles } from "../src/lib/env.js";
import { chainMcp } from "../src/lib/mcp.js";
import { explorerTx, TOKENS } from "../src/lib/networks.js";
import { testnetSigner } from "../src/lib/signer.js";
import { proofMeta, writeProof } from "../src/lib/proof.js";

const WPHRS = TOKENS.atlantic.WPHRS.address as Hex;
// Both are made-up addresses nobody controls. The first is on tasks/wallet-risk-checker/risk-config.json's flagged list; the second is not.
export const FLAGGED = getAddress("0xf1a9000000000000000000000000000000000001");
export const UNKNOWN_SPENDER = getAddress("0x5be1100000000000000000000000000000000aa0");
const KEY_FILE = join(homedir(), ".config/pharos/risk-demo.env");

await runCli(async ({ onExit }) => {
  const { values } = parseCli({ usage: "npm run make-risky-wallet -- [--execute]", options: { execute: { type: "boolean", default: false } } });
  if (!existsSync(KEY_FILE)) {
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, `# Atlantic testnet only: the throwaway wallet for the Wallet Risk Checker's risky example\nRISK_DEMO_KEY=${generatePrivateKey()}\n`, { mode: 0o600 });
    chmodSync(KEY_FILE, 0o600);
  }
  const key = readEnvFiles([KEY_FILE]).RISK_DEMO_KEY as Hex;
  const wallet = privateKeyToAccount(key).address;
  process.env.RISK_DEMO_KEY = key; // in this process only; the Chain MCP child gets a sanitised environment
  console.log(`risky example wallet (new, ours, Atlantic only): ${wallet}`);
  const mcp = await chainMcp("atlantic", { broadcast: values.execute });
  onExit(() => mcp.close());
  const funder = testnetSigner(mcp);
  const demo = testnetSigner(mcp, { envVar: "RISK_DEMO_KEY" });
  const weth = parseAbi(["function deposit() payable"]);
  const steps = [
    { who: funder, label: "fund the new wallet with 0.01 PHRS", intent: { to: wallet, value: parseEther("0.01") } },
    { who: demo, label: "wrap 0.0005 PHRS → WPHRS", intent: { to: WPHRS, value: parseEther("0.0005"), data: encodeFunctionData({ abi: weth, functionName: "deposit" }) } },
    { who: demo, label: `send 0.0001 WPHRS to the flagged address ${FLAGGED}`, intent: { to: WPHRS, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [FLAGGED, parseEther("0.0001")] }) } },
    { who: demo, label: `approve an unlimited WPHRS allowance to ${UNKNOWN_SPENDER}`, intent: { to: WPHRS, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [UNKNOWN_SPENDER, maxUint256] }) } },
  ];
  const done: { label: string; tx: string; status: string; block: string }[] = [];
  for (const s of steps) {
    if (!values.execute) {
      // Only the funder can be estimated before the new wallet holds anything.
      console.log(`dry run: ${s.label}${s.who === funder ? ` (gas ${(await s.who.prepare(s.intent)).gas})` : ""}`);
      continue;
    }
    const signed = await s.who.send(s.intent);
    const r = await s.who.waitForReceipt(signed.hash);
    console.log(`${r.status}: ${s.label}\n  ${explorerTx("atlantic", signed.hash)}`);
    done.push({ label: s.label, tx: signed.hash, status: r.status, block: r.blockNumber.toString() });
    if (r.status !== "success") return 1;
  }
  if (values.execute) console.log(`proof: ${writeProof(join(import.meta.dirname, "../tasks/wallet-risk-checker/proof/risky-wallet-setup.json"), { note: "A staged example: we created this wallet, funded it and made it touch a flagged address of OUR list.", wallet, flagged: FLAGGED, unknownSpender: UNKNOWN_SPENDER, steps: done }, proofMeta("wallet-risk-checker", mcp))}`);
  else console.log("dry run: nothing sent (add --execute)");
  return 0;
});
