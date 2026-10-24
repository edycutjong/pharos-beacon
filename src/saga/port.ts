import { decodeErrorResult, type Hex } from "viem";
import { ChainToolError, ClientClosedError, type ChainMcp } from "../lib/mcp.js";
import { describeError, wait } from "../lib/net.js";
import { atlantic } from "../lib/networks.js";
import { BroadcastError, BroadcastUnclearError, UnresolvedTxError, type SignedTx, type TestnetSigner } from "../lib/signer.js";
import { errorsAbi } from "./defi.js";
import type { Port, Rcpt } from "./engine.js";

/** The Chain MCP + the testnet signer as the saga engine's Port. Reads and the broadcast go through the Chain MCP; viem only signs. */
export function chainPort(mcp: ChainMcp, signer: TestnetSigner): Port {
  const signed = new Map<string, SignedTx>();
  const call: ChainMcp["call"] = mcp.call.bind(mcp);

  /** A revert from estimate_gas / eth_call, with its custom error decoded: "reverted: VaultClosed()". */
  function revertText(e: unknown): Error {
    if (e instanceof ChainToolError && e.code === 3) {
      let name = "";
      if (typeof e.data === "string" && e.data.startsWith("0x") && e.data.length >= 10) {
        try {
          const d = decodeErrorResult({ abi: errorsAbi, data: e.data as Hex });
          name = `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
        } catch {
          name = `unknown error ${e.data.slice(0, 10)}`;
        }
      }
      const err = new Error(`reverted: ${name || e.reason}`);
      (err as Error & { code?: number }).code = 3;
      return err;
    }
    return e instanceof Error ? e : new Error(describeError(e));
  }

  const toRcpt = (r: NonNullable<Awaited<ReturnType<ChainMcp["call"]>>> & Record<string, any>): Rcpt => ({
    status: r.status === "0x1" ? "success" : "reverted",
    blockNumber: BigInt(r.blockNumber),
    gasUsed: BigInt(r.gasUsed),
    ...(r.effectiveGasPrice ? { effectiveGasPrice: BigInt(r.effectiveGasPrice) } : {}),
    logs: (r.logs ?? []).map((l: { address: Hex; topics: Hex[]; data: Hex }) => ({ address: l.address, topics: l.topics, data: l.data })),
  });

  const port: Port = {
    async sign(tx, o) {
      let prepared;
      try {
        prepared = await signer.prepare({ to: tx.to, value: tx.value, data: tx.data, ...(o.nonce !== undefined ? { nonce: o.nonce } : {}), ...(o.gas !== undefined ? { gas: o.gas } : {}) });
      } catch (e) {
        if (e instanceof UnresolvedTxError) throw new Error(`timeout: ${e.message}`);
        throw revertText(e);
      }
      // A retry never pays less than the bumped fee; an injected "gas spike" sends a fee below the base fee.
      if (o.minMaxFee !== undefined && prepared.maxFeePerGas < o.minMaxFee) prepared.maxFeePerGas = o.minMaxFee;
      if (o.maxFeeOverride !== undefined) {
        prepared.maxFeePerGas = o.maxFeeOverride;
        prepared.maxPriorityFeePerGas = 0n;
      }
      if (prepared.maxPriorityFeePerGas > prepared.maxFeePerGas) prepared.maxPriorityFeePerGas = prepared.maxFeePerGas;
      const s = await signer.sign(prepared);
      signed.set(s.hash, s);
      return { hash: s.hash, raw: s.raw, nonce: s.tx.nonce, maxFeePerGas: s.tx.maxFeePerGas, maxPriorityFeePerGas: s.tx.maxPriorityFeePerGas, gas: s.tx.gas };
    },

    async broadcast(f) {
      const s: SignedTx = signed.get(f.hash) ?? {
        hash: f.hash,
        raw: f.raw,
        tx: { chainId: atlantic.id, to: "0x0000000000000000000000000000000000000000", value: 0n, nonce: f.nonce, gas: f.gas, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas },
      };
      try {
        await signer.broadcast(s);
      } catch (e) {
        // Unclear = no answer from the node: the tx may still arrive, so it is a transient failure (the retry keeps the nonce).
        if (e instanceof BroadcastUnclearError) throw new Error(`timeout: ${e.message}`);
        if (e instanceof BroadcastError) throw new Error(`${describeError((e.cause as Error) ?? e)}`);
        throw e;
      }
    },

    // receipt() and known() throw when the node cannot be asked: "cannot tell" must never read as "not there", because the
    // engine rolls back only after it has looked at every send. The polling in waitReceipt tolerates a failed poll.
    async receipt(hash) {
      const r = await call("get_transaction_receipt", { hash });
      return r ? toRcpt(r as never) : null;
    },

    async known(hash) {
      return Boolean(await call("get_transaction", { hash }));
    },

    async waitReceipt(hash, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const r = await port.receipt(hash);
          if (r) return r;
        } catch (e) {
          if (e instanceof ClientClosedError) throw e; // Ctrl-C closed the client: stop polling now
        }
        if (Date.now() + 2_500 >= deadline) return null;
        await wait(2_500);
      }
    },

    async call(to, data) {
      try {
        return (await call("eth_call", { transaction: { to, data } })).result;
      } catch (e) {
        throw revertText(e);
      }
    },

    sleep: (ms) => wait(ms),
    now: () => new Date(),
  };
  return port;
}
