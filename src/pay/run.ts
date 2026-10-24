// Shared by both payment CLIs: who the payment is from, how a prepared payment is shown, and the --execute step.
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { secret } from "../lib/env.js";
import { UsageError } from "../lib/cli.js";
import type { TestnetSigner } from "../lib/signer.js";
import { checksTable, signAndSend, txJson, type Prepared, type Sent } from "./prepare.js";

/** The paying address: --from, else the address of PRIVATE_KEY (the key itself is not used until --execute). */
export function senderAddress(from?: string): Hex {
  if (from) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(from)) throw new UsageError("--from must be a 0x address");
    return from as Hex;
  }
  const pk = secret("PRIVATE_KEY");
  if (!pk) throw new UsageError("pass --from <0x address> (or set PRIVATE_KEY, see .env.example)");
  return privateKeyToAccount(pk as Hex).address;
}

export function show(prep: Prepared, say: (l: string) => void): void {
  say("checks");
  say(checksTable(prep.checks));
  if (!prep.ok) return void say("\nREFUSED: no transaction was prepared.");
  say(`\n${prep.summary}`);
  say(`\nunsigned transaction\n${JSON.stringify(txJson(prep.tx!), null, 2)}`);
  say(`\nwallet signing request\n${JSON.stringify(prep.walletRequest, null, 2)}`);
}

/** Sign and send only when `execute`; otherwise say plainly that nothing was signed. */
export async function maybeExecute(prep: Prepared, o: { execute: boolean; signer: () => TestnetSigner; say: (l: string) => void }): Promise<Sent | undefined> {
  if (!prep.ok) return undefined;
  if (!o.execute) return void o.say("\nNOT SIGNED. Nothing was sent. Re-run with --execute to sign it with the testnet key and send it.");
  const signer = o.signer();
  if (signer.address.toLowerCase() !== prep.resolved!.from.toLowerCase()) throw new UsageError(`the testnet key is ${signer.address}, not the prepared sender ${prep.resolved!.from}: refusing to sign`);
  const sent = await signAndSend(signer, prep.tx!);
  o.say(`\nSENT ${sent.status} in block ${sent.blockNumber}\n${sent.url}`);
  return sent;
}
