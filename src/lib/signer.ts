import "./env.js"; // first: keys load from ~/.config/pharos/testnet.env (or the repo's git-ignored .env)
import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainMcp } from "./mcp.js";
import { describeError, wait } from "./net.js";
import { atlantic } from "./networks.js";

// The testnet signer every sending task shares. The Chain MCP does all the chain work (nonce, gas, fees, broadcast,
// receipt); viem only signs, locally. The hash is known before the broadcast, so a caller can record it first and
// reconcile an unclear failure instead of paying twice.

/** What to send. Unset fields are filled by `prepare` through the Chain MCP. */
export interface TxIntent {
  to: Hex;
  value?: bigint;
  data?: Hex;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
}

/** A complete EIP-1559 transaction for Atlantic, ready to sign. */
export interface PreparedTx {
  chainId: number;
  to: Hex;
  value: bigint;
  data?: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface SignedTx {
  hash: Hex;
  raw: Hex;
  tx: PreparedTx;
}

export interface Receipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice?: bigint;
}

/** The node did not take the transaction and does not know its hash. Re-sending with the same nonce is safe: at most one can land. */
export class BroadcastError extends Error {
  override name = "BroadcastError";
  constructor(
    readonly hash: Hex,
    readonly nonce: number,
    override readonly cause: unknown,
  ) {
    super(`broadcast of ${hash} (nonce ${nonce}) failed and the node does not know it: ${describeError(cause)}`);
  }
}

export interface TestnetSigner {
  readonly address: Hex;
  /** Fill nonce (pending count), gas (estimate_gas) and fees (2 × base fee + priority fee) through the Chain MCP. */
  prepare(intent: TxIntent): Promise<PreparedTx>;
  /** Sign locally; the returned hash is final before anything is sent. */
  sign(tx: PreparedTx): Promise<SignedTx>;
  /** Send through the Chain MCP (send_raw_transaction). On any error, asks the node for the hash before failing. */
  broadcast(signed: SignedTx): Promise<Hex>;
  /** prepare → sign → broadcast. Record `hash` and `tx.nonce` from `sign` first when a double send must be impossible. */
  send(intent: TxIntent): Promise<SignedTx>;
  /** Poll get_transaction_receipt through the Chain MCP (Atlantic makes a block every ~2.5 s). */
  waitForReceipt(hash: Hex, opts?: { polls?: number; pollMs?: number }): Promise<Receipt>;
}

export interface SignerOptions {
  /** The variable holding the key (default PRIVATE_KEY). The key is read once and never logged. */
  envVar?: string;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The only way the shared code signs. Atlantic testnet only, by construction: it refuses a client for any other network
 * or chain, and every transaction it signs carries chain id 688689, which no other chain accepts.
 */
export function testnetSigner(mcp: ChainMcp, opts: SignerOptions = {}): TestnetSigner {
  if (mcp.network !== "atlantic" || mcp.chainId !== atlantic.id) {
    throw new Error(`signing is Atlantic testnet only (chain ${atlantic.id}); this client serves ${mcp.network} chain ${mcp.chainId}`);
  }
  const envVar = opts.envVar ?? "PRIVATE_KEY";
  const pk = process.env[envVar];
  if (!pk) throw new Error(`${envVar} not set — see .env.example`);
  const account = privateKeyToAccount(pk as Hex);
  const sleep = opts.sleep ?? wait;

  async function fees(intent: TxIntent): Promise<Pick<PreparedTx, "maxFeePerGas" | "maxPriorityFeePerGas">> {
    if (intent.maxFeePerGas !== undefined) {
      return { maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas ?? 0n };
    }
    // Not eth_gasPrice alone: on Atlantic it reports 10 gwei while blocks clear at a 1 gwei base fee.
    const [block, price] = await Promise.all([mcp.call("get_block", { block: "latest" }), mcp.call("get_gas_price")]);
    if (!block?.baseFeePerGas) throw new Error("the latest block has no base fee; pass maxFeePerGas explicitly");
    const priority = intent.maxPriorityFeePerGas ?? BigInt(price.maxPriorityFeePerGasWei);
    return { maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + priority, maxPriorityFeePerGas: priority };
  }

  const signer: TestnetSigner = {
    address: account.address,

    async prepare(intent) {
      const value = intent.value ?? 0n;
      const [nonce, gas, fee] = await Promise.all([
        intent.nonce ?? mcp.call("get_transaction_count", { address: account.address, block: "pending" }).then((r) => Number(r.nonce)),
        intent.gas ??
          mcp
            .call("estimate_gas", { transaction: { from: account.address, to: intent.to, value: toHex(value), ...(intent.data ? { data: intent.data } : {}) } })
            .then((r) => BigInt(r.gas)),
        fees(intent),
      ]);
      return { chainId: atlantic.id, to: intent.to, value, ...(intent.data ? { data: intent.data } : {}), nonce, gas, ...fee };
    },

    async sign(tx) {
      if (tx.chainId !== atlantic.id) throw new Error(`refusing to sign for chain ${tx.chainId}: Atlantic (${atlantic.id}) only`);
      const raw = await account.signTransaction({
        type: "eip1559",
        chainId: tx.chainId,
        to: tx.to,
        value: tx.value,
        data: tx.data,
        nonce: tx.nonce,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      });
      return { hash: keccak256(raw), raw, tx };
    },

    async broadcast(signed) {
      if (!mcp.broadcast) throw new Error('open the client with chainMcp("atlantic", { broadcast: true }) to send');
      let txHash: Hex;
      try {
        ({ txHash } = await mcp.call("send_raw_transaction", { rawTransaction: signed.raw }));
      } catch (e) {
        // A timeout, or "already known" on a resend, can hide a transaction the node did take: ask before failing.
        const known = await mcp.call("get_transaction", { hash: signed.hash }).catch(() => null);
        if (known) return signed.hash;
        throw new BroadcastError(signed.hash, signed.tx.nonce, e);
      }
      if (txHash.toLowerCase() !== signed.hash.toLowerCase()) throw new Error(`the node reported hash ${txHash} for ${signed.hash}`);
      return signed.hash;
    },

    async send(intent) {
      const signed = await signer.sign(await signer.prepare(intent));
      await signer.broadcast(signed);
      return signed;
    },

    async waitForReceipt(hash, { polls = 60, pollMs = 2_500 } = {}) {
      let lastError = "";
      for (let i = 0; i < polls; i++) {
        const r = await mcp.call("get_transaction_receipt", { hash }).catch((e: unknown) => ((lastError = describeError(e)), null));
        if (r) {
          return {
            status: r.status === "0x1" ? "success" : "reverted",
            blockNumber: BigInt(r.blockNumber),
            gasUsed: BigInt(r.gasUsed),
            ...(r.effectiveGasPrice ? { effectiveGasPrice: BigInt(r.effectiveGasPrice) } : {}),
          };
        }
        if (i < polls - 1) await sleep(pollMs);
      }
      throw new Error(`tx ${hash} sent but no receipt after ${polls} polls${lastError ? ` (last error: ${lastError})` : ""} — check the explorer before retrying`);
    },
  };
  return signer;
}
