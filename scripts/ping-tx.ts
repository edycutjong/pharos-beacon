// Sends 0.001 PHRS between our two testnet wallets to prove signing + broadcast work.
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { testnet, wallet } from "../src/lib/chain.js";

const w = wallet();
const to = privateKeyToAccount(process.env.PRIVATE_KEY_2 as `0x${string}`).address;
const hash = await w.sendTransaction({ to, value: parseEther("0.001") });
const r = await testnet.waitForTransactionReceipt({ hash });
console.log(`${r.status} in block ${r.blockNumber}: https://atlantic.pharosscan.xyz/tx/${hash}`);
