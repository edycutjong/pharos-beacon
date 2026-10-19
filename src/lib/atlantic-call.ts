// The read-only Chain MCP tools, answered from the public Atlantic RPC with viem. For the hosted demo pages only: the
// Atlantic Chain MCP runs locally over stdio (src/lib/mcp.ts) and cannot run on Vercel, so the pages read Atlantic through
// this adapter, which returns the same JSON shapes the sponsor server does (ChainToolResults) and the same ChainToolError
// on a failure (a revert keeps JSON-RPC code 3 and its revert bytes). The CLI tasks keep using the Chain MCP.
// It can never send anything: send_raw_transaction (and any tool not listed here) is refused.
import { createPublicClient, formatEther, formatGwei, http, toHex, type Hex } from "viem";
import { ChainToolError, type ChainMcp, type ChainTool } from "./mcp.js";
import { atlantic } from "./networks.js";

export type Call = ChainMcp["call"];

/** One finished tool call, for a page that lights a lamp per call. */
export interface CallEvent {
  tool: string;
  ms: number;
  ok: boolean;
}

export interface Rpc {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export const ATLANTIC_RPC = atlantic.rpcUrls.default.http[0];

export const READ_TOOLS = [
  "get_block_number",
  "get_balance",
  "get_transaction_count",
  "get_gas_price",
  "get_block",
  "get_transaction_receipt",
  "eth_call",
  "estimate_gas",
] as const satisfies readonly ChainTool[];

/** The public RPC (ZAN) rate-limits per second: a few retries with a pause. */
export function atlanticRpc(): Rpc {
  return createPublicClient({ chain: atlantic, transport: http(undefined, { retryCount: 4, retryDelay: 600, timeout: 20_000 }) }) as unknown as Rpc;
}

/** "latest" | "pending" | "earliest" | decimal | hex → the RPC's block tag. */
export function blockTag(b: unknown): string {
  if (b === undefined || b === null || b === "") return "latest";
  const s = String(b);
  if (s === "latest" || s === "pending" || s === "earliest" || s === "safe" || s === "finalized") return s;
  if (/^\d+$/.test(s)) return toHex(BigInt(s));
  if (/^0x[0-9a-fA-F]+$/.test(s)) return s;
  throw new ChainToolError("block", `not a block number or tag: ${JSON.stringify(s).slice(0, 40)}`);
}

/** The JSON-RPC error inside a viem error chain: its code, message and data (revert bytes for code 3). */
export function rpcError(tool: string, e: unknown): ChainToolError {
  let x = e as { code?: unknown; data?: unknown; shortMessage?: unknown; details?: unknown; message?: unknown; cause?: unknown } | undefined;
  let found: { code: number; data?: unknown; message: string } | undefined;
  for (let i = 0; x && i < 8; i++, x = x.cause as typeof x) {
    if (typeof x.code === "number" && (found === undefined || x.data !== undefined)) {
      found = { code: x.code, data: x.data, message: String(x.details ?? x.shortMessage ?? x.message ?? "error") };
    }
  }
  if (found) return new ChainToolError(tool, found.message.split("\n")[0]!.slice(0, 300), found.code, found.data);
  return new ChainToolError(tool, (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300));
}

type Tx = { from?: Hex; to?: Hex; value?: Hex | string; data?: Hex; gas?: Hex | string };
const txParam = (t: unknown) => {
  const tx = (t ?? {}) as Tx;
  const out: Record<string, string> = {};
  for (const k of ["from", "to", "data"] as const) if (tx[k] !== undefined) out[k] = String(tx[k]);
  for (const k of ["value", "gas"] as const) if (tx[k] !== undefined) out[k] = /^\d+$/.test(String(tx[k])) ? toHex(BigInt(String(tx[k]))) : String(tx[k]);
  return out;
};

/**
 * A `call(tool, args)` with the Chain MCP's signature, read-only, backed by the Atlantic RPC. `onCall` hears every
 * finished call (tool, ms, ok); `maxCalls` caps one run's work (the endpoint behind a page is public).
 */
export function atlanticCall(o: { rpc?: Rpc; onCall?: (e: CallEvent) => void; maxCalls?: number } = {}): Call {
  const rpc = o.rpc ?? atlanticRpc();
  let used = 0;
  const req = (method: string, params: unknown[]) => rpc.request({ method, params });
  async function run(tool: string, a: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case "get_block_number": {
        const n = BigInt((await req("eth_blockNumber", [])) as string);
        return { blockNumber: n.toString(), blockNumberHex: toHex(n) };
      }
      case "get_balance": {
        const wei = BigInt((await req("eth_getBalance", [String(a.address), blockTag(a.block)])) as string);
        return { address: a.address, balanceWei: wei.toString(), balance: formatEther(wei), symbol: "PHRS", balanceHex: toHex(wei) };
      }
      case "get_transaction_count": {
        const n = BigInt((await req("eth_getTransactionCount", [String(a.address), blockTag(a.block)])) as string);
        return { nonce: n.toString(), nonceHex: toHex(n) };
      }
      case "get_gas_price": {
        const [gp, prio] = await Promise.all([req("eth_gasPrice", []), req("eth_maxPriorityFeePerGas", [])]);
        const g = BigInt(gp as string);
        const p = BigInt(prio as string);
        return { gasPriceWei: g.toString(), gasPriceGwei: formatGwei(g), gasPriceHex: toHex(g), maxPriorityFeePerGasWei: p.toString(), maxPriorityFeePerGasGwei: formatGwei(p), maxPriorityFeePerGasHex: toHex(p) };
      }
      case "get_block":
        return req("eth_getBlockByNumber", [blockTag(a.block), false]);
      case "get_transaction_receipt":
        return req("eth_getTransactionReceipt", [String(a.hash)]);
      case "eth_call":
        return { result: await req("eth_call", [txParam(a.transaction), blockTag(a.block)]) };
      case "estimate_gas": {
        const g = BigInt((await req("eth_estimateGas", [txParam(a.transaction)])) as string);
        return { gas: g.toString(), gasHex: toHex(g) };
      }
      default:
        throw new ChainToolError(tool, "not available on the demo page (read-only Atlantic RPC adapter)");
    }
  }
  return (async (tool: string, args: Record<string, unknown> = {}) => {
    if (!(READ_TOOLS as readonly string[]).includes(tool)) throw new ChainToolError(tool, "not available on the demo page (read-only Atlantic RPC adapter)");
    if (o.maxCalls !== undefined && ++used > o.maxCalls) throw new ChainToolError(tool, `this run hit its cap of ${o.maxCalls} chain reads`);
    const t0 = Date.now();
    try {
      const r = await run(tool, args);
      o.onCall?.({ tool, ms: Date.now() - t0, ok: true });
      return r;
    } catch (e) {
      o.onCall?.({ tool, ms: Date.now() - t0, ok: false });
      throw e instanceof ChainToolError ? e : rpcError(tool, e);
    }
  }) as Call;
}

/** A ChainMcp-shaped handle for code that takes one (doc-grounded builder's Deps.chain). Never broadcasts. */
export function atlanticReadOnly(call: Call): Pick<ChainMcp, "call" | "endpoint" | "network" | "chainId" | "server"> {
  return { call, endpoint: `Atlantic RPC ${ATLANTIC_RPC} (read-only adapter)`, network: "atlantic", chainId: atlantic.id, server: undefined };
}
