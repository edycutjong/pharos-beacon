import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { atlantic, pharos } from "./networks.js";

// Keys live outside the repo: ~/.config/pharos/testnet.env (or a local .env, git-ignored).
config({ path: join(homedir(), ".config/pharos/testnet.env"), quiet: true });
config({ quiet: true });

// The public Atlantic RPC (ZAN) rate-limits per second: poll slowly, back off on -32011.
const gentle = () => http(undefined, { retryCount: 5, retryDelay: 1500 });

export const testnet = createPublicClient({ chain: atlantic, transport: gentle(), pollingInterval: 2_000 });
export const mainnet = createPublicClient({ chain: pharos, transport: http() });

export function wallet(envVar = "PRIVATE_KEY") {
  const pk = process.env[envVar];
  if (!pk) throw new Error(`${envVar} not set — see .env.example`);
  const account = privateKeyToAccount(pk as Hex);
  return createWalletClient({ account, chain: atlantic, transport: gentle(), pollingInterval: 2_000 });
}
