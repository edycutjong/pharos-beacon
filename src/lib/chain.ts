import { secret } from "./env.js"; // keys come from ~/.config/pharos/testnet.env (or the repo's git-ignored .env)
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { atlantic } from "./networks.js";

// The public Atlantic RPC (ZAN) rate-limits per second: poll slowly, back off on -32011.
const gentle = () => http(undefined, { retryCount: 5, retryDelay: 1500 });

/** Raw Atlantic RPC, for scripts only. Task reads go through the Chain MCP (src/lib/mcp.ts); there is no raw mainnet client. */
export const testnet = createPublicClient({ chain: atlantic, transport: gentle(), pollingInterval: 2_000 });

export function wallet(envVar = "PRIVATE_KEY") {
  const pk = secret(envVar);
  if (!pk) throw new Error(`${envVar} not set — see .env.example`);
  const account = privateKeyToAccount(pk as Hex);
  return createWalletClient({ account, chain: atlantic, transport: gentle(), pollingInterval: 2_000 });
}
