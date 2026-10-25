// Shared plumbing of the Audit-Log Agent and Weekly Digest Agent demo endpoints: one connection per network (Pacific mainnet
// through the hosted Chain MCP, Atlantic through the public RPC because the Atlantic Chain MCP runs locally over stdio), the
// block window the page may ask for, and the phase names of the Sequence strip.
import { isAddress, type Hex } from "viem";
import { parseWallet, type Call } from "../activity/engine.js";
import { chainMcp, type Network } from "../lib/mcp.js";
import { atlanticRpcCall } from "./atlantic-rpc.js";
import { InputError } from "./live.js";

export interface Conn { call: Call; endpoint: string; close(): Promise<void> }
export interface Deps { connect: (network: Network) => Promise<Conn> }
export const defaultDeps: Deps = {
  connect: async (network) => {
    if (network === "atlantic") return { call: atlanticRpcCall(), endpoint: "public Atlantic RPC https://atlantic.dplabs-internal.com", close: async () => {} };
    const m = await chainMcp("pharos", { timeoutMs: 20_000 });
    return { call: m.call, endpoint: `hosted Chain MCP ${m.endpoint}`, close: () => m.close() };
  },
};

/** The windows the page offers: the CLI reads days and weeks; a request on Vercel must stay inside the function time and the RPC rate limits. */
export const WINDOWS = [1000, 5000, 10_000, 30_000] as const;

/** `toBlock` pins the end of the window (a sample that must give the same answer tomorrow); without it the window ends at the head. */
export interface WindowParams { wallet: Hex; network: Network; blocks: number; toBlock?: bigint }
export function parseWindow(url: URL): WindowParams {
  const q = url.searchParams;
  const raw = (q.get("wallet") ?? "").trim();
  if (!isAddress(raw, { strict: false })) throw new InputError("wallet must be a 0x address (40 hex characters)");
  const network = q.get("network") ?? "pharos";
  if (network !== "pharos" && network !== "atlantic") throw new InputError('network must be "pharos" (mainnet) or "atlantic" (testnet)');
  const blocks = Number(q.get("blocks") ?? WINDOWS[1]);
  if (!(WINDOWS as readonly number[]).includes(blocks)) throw new InputError(`blocks must be one of ${WINDOWS.join(", ")}`);
  const to = (q.get("toBlock") ?? "").trim();
  if (to && !/^\d{1,10}$/.test(to)) throw new InputError("toBlock must be a block number (digits only)");
  return { wallet: parseWallet(raw), network, blocks, ...(to ? { toBlock: BigInt(to) } : {}) };
}

/** Which part of the read a tool call belongs to, for the lamps. */
export function activityPhase(tool: string): string {
  if (tool === "get_block_number") return "head";
  if (tool === "get_logs") return "logs";
  if (tool === "get_transaction" || tool === "get_transaction_receipt") return "txs";
  if (tool === "get_transaction_count") return "nonce";
  return "tokens";
}
export const activityLabel = (p: string, n: number) =>
  ({ head: "chain head", logs: `${n} get_logs windows`, txs: `${n} transaction + receipt reads`, nonce: `${n} nonce reads (completeness check)`, tokens: `${n} token / block reads` })[p] ?? `${n} reads`;

/** The window to read: the last `blocks` blocks up to `toBlock` (or the head), and the head it was pinned against. */
export function windowEnd(p: WindowParams, head: bigint): bigint {
  return p.toBlock !== undefined && p.toBlock < head ? p.toBlock : head;
}
