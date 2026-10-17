import { secret } from "./env.js"; // keys come from ~/.config/pharos/testnet.env (or the repo's git-ignored .env)
import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ChainToolError, ClientClosedError, type ChainMcp } from "./mcp.js";
import { describeError, wait } from "./net.js";
import { atlantic, explorerTx } from "./networks.js";

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

/**
 * The node answered the broadcast with an error (insufficient funds, underpriced, nonce too low…) and, asked by hash
 * afterwards, does not have the transaction: it was refused. Fix the cause, then send again: with the same nonce
 * (two transactions with one nonce can never both land), or for "nonce too low" with a fresh one.
 */
export class BroadcastError extends Error {
  override name = "BroadcastError";
  constructor(
    readonly signed: SignedTx,
    override readonly cause: unknown,
  ) {
    const n = signed.tx.nonce;
    const why = describeError(cause);
    super(
      /nonce too low/i.test(why)
        ? `the node refused ${signed.hash}: nonce ${n} is already used by another transaction (${why}). Prepare it again for a new nonce`
        : `the node refused ${signed.hash} (nonce ${n}) and does not have it: ${why}. To retry, reuse nonce ${n} so at most one can land`,
    );
  }
}

/** A transaction whose broadcast got no clear answer blocks picking a fresh nonce; `signed` is that transaction. */
export class UnresolvedTxError extends Error {
  override name = "UnresolvedTxError";
  constructor(readonly signed: SignedTx) {
    super(
      `transaction ${signed.hash} (nonce ${signed.tx.nonce}) may still arrive: re-broadcast it (signer.broadcast(err.signed)) ` +
        `or pass nonce ${signed.tx.nonce} to replace it; refusing to pick a new nonce`,
    );
  }
}

/**
 * The broadcast got no clear answer (a timeout, a dropped connection, the client closed by Ctrl-C) or the node could
 * not be asked afterwards: the transaction may still arrive. Until it is resolved the signer refuses to pick a fresh nonce. Re-broadcast `signed`
 * (same bytes, same hash: always safe), or look the hash up (explorer link in the message).
 */
export class BroadcastUnclearError extends Error {
  override name = "BroadcastUnclearError";
  constructor(
    readonly signed: SignedTx,
    override readonly cause: unknown,
    readonly lookupError?: unknown,
  ) {
    const detail =
      lookupError !== undefined
        ? `; the lookup failed too: ${describeError(lookupError)}`
        : cause instanceof ClientClosedError
          ? " before the node answered"
          : "; the node does not show it yet but may still take it";
    super(
      `could not tell whether ${signed.hash} (nonce ${signed.tx.nonce}) was sent: ${describeError(cause)}${detail}. ` +
        `Check ${explorerTx("atlantic", signed.hash)} before acting; any retry must reuse nonce ${signed.tx.nonce}`,
    );
  }
}

export interface TestnetSigner {
  readonly address: Hex;
  /** A transaction whose broadcast got no clear answer, if any: until it is resolved no fresh nonce is picked. */
  readonly unresolved: SignedTx | undefined;
  /** Fill nonce (pending count), gas (estimate_gas) and fees (2 × base fee + priority fee) through the Chain MCP. */
  prepare(intent: TxIntent): Promise<PreparedTx>;
  /** Sign locally; the returned hash is final before anything is sent. */
  sign(tx: PreparedTx): Promise<SignedTx>;
  /**
   * Send through the Chain MCP (send_raw_transaction). On an error it asks the node for the hash (3 tries, 1 s apart):
   * found = sent; not found = BroadcastError; the lookup itself failing = BroadcastUnclearError.
   */
  broadcast(signed: SignedTx): Promise<Hex>;
  /**
   * prepare → sign → broadcast, one at a time per signer, so concurrent sends get consecutive nonces. When a double send
   * must be impossible, call prepare + sign yourself, record `hash` and `tx.nonce`, then broadcast.
   */
  send(intent: TxIntent): Promise<SignedTx>;
  /** Poll get_transaction_receipt through the Chain MCP until `timeoutMs` (default 150 s; Atlantic makes a block every ~2.5 s). */
  waitForReceipt(hash: Hex, opts?: { timeoutMs?: number; pollMs?: number }): Promise<Receipt>;
}

export interface SignerOptions {
  /** The variable holding the key (default PRIVATE_KEY). The key is read once and never logged. */
  envVar?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the receipt deadline (tests). */
  now?: () => number;
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
  const pk = secret(envVar);
  if (!pk) throw new Error(`${envVar} not set — see .env.example`);
  const account = privateKeyToAccount(pk as Hex);
  const sleep = opts.sleep ?? wait;
  const now = opts.now ?? Date.now;
  // The lowest nonce the next send may use: the node's pending count can lag a broadcast it just accepted.
  let nonceFloor = 0;
  // A transaction whose broadcast got no clear answer: no fresh nonce is picked until it is resolved.
  let unresolved: SignedTx | undefined;
  let queue: Promise<unknown> = Promise.resolve();

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

  function accepted(signed: SignedTx): Hex {
    nonceFloor = Math.max(nonceFloor, signed.tx.nonce + 1);
    if (unresolved?.tx.nonce === signed.tx.nonce) unresolved = undefined;
    return signed.hash;
  }

  /** Before picking a fresh nonce: an unclear broadcast that has since arrived counts as sent; one still missing blocks. */
  async function settleUnresolved(): Promise<void> {
    if (!unresolved) return;
    if (await mcp.call("get_transaction", { hash: unresolved.hash })) return void accepted(unresolved);
    throw new UnresolvedTxError(unresolved);
  }

  const signer: TestnetSigner = {
    address: account.address,
    get unresolved() {
      return unresolved;
    },

    async prepare(intent) {
      if (intent.nonce === undefined) await settleUnresolved();
      const value = intent.value ?? 0n;
      const [nonce, gas, fee] = await Promise.all([
        intent.nonce ??
          mcp.call("get_transaction_count", { address: account.address, block: "pending" }).then((r) => Math.max(Number(r.nonce), nonceFloor)),
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
        // 60 s: longer than the local server's own retries of eth_sendRawTransaction (4 tries of up to 12 s), so a slow
        // node is waited for instead of being reported as unclear.
        ({ txHash } = await mcp.call("send_raw_transaction", { rawTransaction: signed.raw }, { timeoutMs: 60_000 }));
      } catch (e) {
        if (e instanceof ClientClosedError) {
          // Closed (Ctrl-C) while the send was in flight: it may have gone out. Keep the hash in the error.
          unresolved = signed;
          throw new BroadcastUnclearError(signed, e);
        }
        // A timeout, or "already known" / "nonce too low" on a resend, can hide a transaction the node did take. Ask by
        // hash before failing, and call it refused only when the node answered with an error and does not have it.
        let lookupError: unknown;
        for (let i = 0; i < 3; i++) {
          try {
            if (await mcp.call("get_transaction", { hash: signed.hash })) return accepted(signed);
            lookupError = undefined;
          } catch (le) {
            lookupError = le;
            if (le instanceof ClientClosedError) break;
          }
          if (i < 2) await sleep(1_000);
        }
        // Refused only when the node itself answered with a JSON-RPC error (it carries a code) and does not have the tx.
        // A code-less tool error is the server's own trouble reaching the node (its timeout, an HTTP 5xx, fetch
        // failed): no answer from the node, so the tx may still arrive.
        if (e instanceof ChainToolError && e.code !== undefined && lookupError === undefined) {
          if (unresolved?.hash === signed.hash) unresolved = undefined; // the same bytes, now refused: it will not land
          throw new BroadcastError(signed, e);
        }
        unresolved = signed;
        throw new BroadcastUnclearError(signed, e, lookupError);
      }
      if (txHash.toLowerCase() !== signed.hash.toLowerCase()) throw new Error(`the node reported hash ${txHash} for ${signed.hash}`);
      return accepted(signed);
    },

    send(intent) {
      const run = queue.then(async () => {
        const signed = await signer.sign(await signer.prepare(intent));
        await signer.broadcast(signed);
        return signed;
      });
      queue = run.catch(() => {});
      return run;
    },

    async waitForReceipt(hash, { timeoutMs = 150_000, pollMs = 2_500 } = {}) {
      const deadline = now() + timeoutMs;
      let lastError = "";
      for (;;) {
        const left = deadline - now();
        // Polling is the retry: one attempt per poll, never longer than the time left.
        const r = await mcp
          .call("get_transaction_receipt", { hash }, { retries: 0, timeoutMs: Math.max(1_000, Math.min(left, 15_000)) })
          .catch((e: unknown) => {
            if (e instanceof ClientClosedError) throw e; // Ctrl-C closed the client: stop polling now
            lastError = describeError(e);
            return null;
          });
        if (r) {
          return {
            status: r.status === "0x1" ? "success" : "reverted",
            blockNumber: BigInt(r.blockNumber),
            gasUsed: BigInt(r.gasUsed),
            ...(r.effectiveGasPrice ? { effectiveGasPrice: BigInt(r.effectiveGasPrice) } : {}),
          };
        }
        if (now() + pollMs >= deadline) break;
        await sleep(pollMs);
      }
      throw new Error(
        `tx ${hash} sent but no receipt after ${Math.round(timeoutMs / 1000)} s${lastError ? ` (last error: ${lastError})` : ""} — check the explorer before retrying`,
      );
    },
  };
  return signer;
}
