// Shared plumbing for the live demo pages' Vercel Functions (api/<task>.ts → tasks/<task>/web.ts). Read-only by design:
// nothing in here can sign or send. Each page streams its steps as NDJSON so the Sequence strip lights as they happen.
//
// Networks on Vercel: Pacific mainnet reads go through the hosted Chain MCP (keyless). The Atlantic Chain MCP runs locally
// over stdio, which a Vercel Function cannot do, so Atlantic reads use `rpcCall`: the same tools with the same argument
// and reply shapes as the sponsor server (PharosNetwork/pharos-mcp src/server.ts), sent as plain JSON-RPC to the Atlantic RPC.
// The task code (watchers, diagnose) cannot tell the two apart, which is the point: the page runs the CLI's own code.
import { formatEther, isAddress, isHex, type Hex } from "viem";
import { ChainToolError, CHAIN_ID, chainMcp, MAX_LOG_WINDOW, type ChainMcp, type Network } from "../lib/mcp.js";
import { atlantic } from "../lib/networks.js";

export type Call = ChainMcp["call"];

/** Bad input from the page or a stranger: answered with a 400 and this message. */
export class InputError extends Error {
  override name = "InputError";
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** What the footer shows: the commit this deployment was built from. */
export function deployInfo() {
  return { commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null, env: process.env.VERCEL_ENV ?? "local" };
}

export type Emit = (event: { type: string; [k: string]: unknown }) => void;

/** Stream `run`'s events as NDJSON, one JSON object per line. A throw becomes a final {type:"error"} line. */
export function ndjson(run: (emit: Emit) => Promise<void>, onEnd?: () => void): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (e) => controller.enqueue(enc.encode(`${JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`));
      try {
        await run(emit);
      } catch (e) {
        emit({ type: "error", message: publicMessage(e) });
      } finally {
        onEnd?.();
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

/** An error's first line, without long request dumps. */
export function publicMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0]!.slice(0, 300);
}

/** At most `max` runs at once per server instance (best effort: Vercel may run several instances). */
export function concurrency(max: number) {
  let busy = 0;
  return {
    take(): boolean {
      if (busy >= max) return false;
      busy++;
      return true;
    },
    release(): void {
      busy = Math.max(0, busy - 1);
    },
    get busy() {
      return busy;
    },
  };
}

export const busyResponse = (what: string) =>
  json({ error: `another ${what} is running on this server right now; try again in a few seconds`, retryAfterSeconds: 5 }, 429, { "retry-after": "5" });

// ---- input checks (the endpoint is public) ----

export function pickNetwork(v: string | null, fallback: Network = "atlantic"): Network {
  if (v === null || v === "") return fallback;
  if (v === "pharos" || v === "atlantic") return v;
  throw new InputError('network must be "atlantic" or "pharos"');
}

export function pickHash(v: string | null, what = "a transaction hash"): Hex {
  const s = (v ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new InputError(`${what} is 0x followed by 64 hex characters`);
  return s.toLowerCase() as Hex;
}

export function pickAddress(v: string | null, what = "the contract"): Hex {
  const s = (v ?? "").trim();
  if (!isAddress(s, { strict: false })) throw new InputError(`${what} must be an address (0x + 40 hex characters)`);
  return s as Hex;
}

export function pickInt(v: string | null, name: string, min: number, max: number, fallback: number): number {
  if (v === null || v === "") return fallback;
  if (!/^\d{1,9}$/.test(v) || Number(v) < min || Number(v) > max) throw new InputError(`${name} must be a whole number from ${min} to ${max}`);
  return Number(v);
}

// ---- timing every Chain MCP tool call ----

export interface CallRecord {
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  ok: boolean;
  /** For a failed call: the tool error (a revert is code 3, which is often the expected answer). */
  error?: { reason: string; code?: number };
}

/** Wrap a Chain MCP `call` so every tool call is timed and reported (the Raw tab and the strip use it). */
export function timedCall(call: Call, onCall: (r: CallRecord) => void): Call {
  const wrapped = async (tool: string, args: Record<string, unknown> = {}, opts?: unknown) => {
    const t0 = performance.now();
    try {
      const out = await (call as (t: string, a?: Record<string, unknown>, o?: unknown) => Promise<unknown>)(tool, args, opts);
      onCall({ tool, args, ms: Math.round(performance.now() - t0), ok: true });
      return out;
    } catch (e) {
      const err = e instanceof ChainToolError ? { reason: e.reason, ...(e.code !== undefined ? { code: e.code } : {}) } : { reason: publicMessage(e) };
      onCall({ tool, args, ms: Math.round(performance.now() - t0), ok: false, error: err });
      throw e;
    }
  };
  return wrapped as Call;
}

// ---- Atlantic: the sponsor server's tools over plain JSON-RPC ----

export const ATLANTIC_RPC = atlantic.rpcUrls.default.http[0]!;

/** What the JSON-RPC endpoint answered with an `error` member: thrown as a ChainToolError, exactly as the MCP server reports it. */
async function rpc(url: string, method: string, params: unknown[], tool: string): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: attempt + 1, method, params }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = new Error(`the Atlantic RPC answered HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string; code?: number; data?: unknown } } | null;
    if (!body) throw new ChainToolError(tool, `the Atlantic RPC answered HTTP ${res.status} without JSON`);
    if (body.error) throw new ChainToolError(tool, String(body.error.message ?? "error").trim() || "error", body.error.code, body.error.data);
    return body.result;
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** The sponsor server's normalizeBlockTag: latest/earliest/…, a hex quantity or a decimal number. */
export function blockTag(v: unknown): string {
  if (v === undefined || v === null) return "latest";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new ChainToolError("block", "block must be non-negative");
    return `0x${v.toString(16)}`;
  }
  const s = String(v).trim().toLowerCase();
  if (["latest", "earliest", "pending", "safe", "finalized"].includes(s)) return s;
  if (/^0x[0-9a-f]+$/.test(s)) return s;
  if (/^[0-9]+$/.test(s)) return `0x${BigInt(s).toString(16)}`;
  throw new ChainToolError("block", "block must be a named tag, decimal number, or hex quantity");
}

const hexQty = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new ChainToolError(what, `Invalid RPC quantity: ${String(v)}`);
  return BigInt(v);
};

/** The sponsor server's validateTransaction: only these fields, addresses and hex checked. */
function txArg(t: unknown, tool: string): Record<string, string> {
  const input = (t ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of ["from", "to"] as const) {
    if (input[k] === undefined || input[k] === null || input[k] === "") continue;
    if (typeof input[k] !== "string" || !isAddress(input[k] as string, { strict: false })) throw new ChainToolError(tool, `${k} must be a valid EVM address`);
    out[k] = input[k] as string;
  }
  for (const k of ["data", "value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "nonce"] as const) {
    if (input[k] === undefined || input[k] === null || input[k] === "") continue;
    if (typeof input[k] !== "string" || !isHex(input[k])) throw new ChainToolError(tool, `${k} must be 0x-prefixed hexadecimal data`);
    out[k] = input[k] as string;
  }
  return out;
}

/**
 * A Chain MCP `call` for Atlantic that speaks JSON-RPC directly. Same tool names, arguments, reply shapes and errors as
 * the sponsor server, for the read tools the demo pages use. send_raw_transaction is not offered: the pages never send.
 */
export function rpcCall(url: string = ATLANTIC_RPC): Call {
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    switch (tool) {
      case "get_chain_info": {
        const chainIdHex = (await rpc(url, "eth_chainId", [], tool)) as Hex;
        const blockHex = (await rpc(url, "eth_blockNumber", [], tool)) as Hex;
        const chainId = Number(hexQty(chainIdHex, tool));
        return {
          name: "Pharos", chainId, chainIdHex, expectedChainId: atlantic.id, chainIdMatches: chainId === atlantic.id,
          latestBlock: hexQty(blockHex, tool).toString(), latestBlockHex: blockHex, nativeSymbol: atlantic.nativeCurrency.symbol,
          clientVersion: "n/a (direct JSON-RPC)", rpcUrl: url,
        };
      }
      case "get_block_number": {
        const hex = (await rpc(url, "eth_blockNumber", [], tool)) as Hex;
        return { blockNumber: hexQty(hex, tool).toString(), blockNumberHex: hex };
      }
      case "get_block":
        return rpc(url, "eth_getBlockByNumber", [blockTag(args.block), args.includeTransactions === true], tool);
      case "get_transaction":
      case "get_transaction_receipt": {
        const hash = String(args.hash ?? "");
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ChainToolError(tool, "hash must be a 32-byte hex hash");
        return rpc(url, tool === "get_transaction" ? "eth_getTransactionByHash" : "eth_getTransactionReceipt", [hash], tool);
      }
      case "eth_call":
        return { result: await rpc(url, "eth_call", [txArg(args.transaction, tool), blockTag(args.block)], tool) };
      case "estimate_gas": {
        const gasHex = (await rpc(url, "eth_estimateGas", [txArg(args.transaction, tool)], tool)) as Hex;
        return { gas: hexQty(gasHex, tool).toString(), gasHex };
      }
      case "get_balance": {
        const address = String(args.address ?? "");
        if (!isAddress(address, { strict: false })) throw new ChainToolError(tool, "address must be a valid EVM address");
        const balanceHex = (await rpc(url, "eth_getBalance", [address, blockTag(args.block)], tool)) as Hex;
        const wei = hexQty(balanceHex, tool);
        return { address, balanceWei: wei.toString(), balance: formatEther(wei), symbol: atlantic.nativeCurrency.symbol, balanceHex };
      }
      case "get_logs": {
        const filter: Record<string, unknown> = { fromBlock: blockTag(args.fromBlock ?? "latest"), toBlock: blockTag(args.toBlock ?? "latest") };
        if (args.address !== undefined) filter.address = args.address;
        if (args.topics !== undefined) filter.topics = args.topics;
        const from = /^0x/.test(filter.fromBlock as string) ? BigInt(filter.fromBlock as string) : undefined;
        const to = /^0x/.test(filter.toBlock as string) ? BigInt(filter.toBlock as string) : undefined;
        if (from !== undefined && to !== undefined) {
          if (to < from) throw new ChainToolError(tool, "toBlock must be greater than or equal to fromBlock");
          if (to - from + 1n > BigInt(MAX_LOG_WINDOW)) throw new ChainToolError(tool, `Block range too large: ${to - from + 1n} blocks requested, maximum is ${MAX_LOG_WINDOW}.`);
        }
        return rpc(url, "eth_getLogs", [filter], tool);
      }
      default:
        throw new ChainToolError(tool, `the demo's Atlantic reader does not offer ${tool}`);
    }
  };
  return call as Call;
}

/** A read-only connection for one demo run, whichever network. Always `await reader.close()`. */
export interface Reader {
  network: Network;
  chainId: number;
  /** Shown on the page: where the reads come from. */
  endpoint: string;
  via: "hosted Chain MCP" | "direct JSON-RPC";
  call: Call;
  close(): Promise<void>;
}

/** Pacific mainnet → the hosted Chain MCP; Atlantic → `rpcCall`, with the same chain check the MCP client does at connect. */
export async function openReader(network: Network, onCall?: (r: CallRecord) => void, open: typeof chainMcp = chainMcp): Promise<Reader> {
  if (network === "pharos") {
    const mcp = await open("pharos", { retries: 1, timeoutMs: 20_000 });
    return { network, chainId: mcp.chainId, endpoint: mcp.endpoint, via: "hosted Chain MCP", call: onCall ? timedCall(mcp.call, onCall) : mcp.call, close: () => mcp.close() };
  }
  const base = rpcCall();
  const call = onCall ? timedCall(base, onCall) : base;
  const info = (await call("get_chain_info")) as { chainId: number };
  if (info.chainId !== CHAIN_ID.atlantic) throw new Error(`${ATLANTIC_RPC} serves chain ${info.chainId}, not Atlantic (${CHAIN_ID.atlantic}): refusing to read from it`);
  return { network, chainId: CHAIN_ID.atlantic, endpoint: ATLANTIC_RPC, via: "direct JSON-RPC", call, close: async () => {} };
}

/** A `call` whose get_block_number never goes past `head`: replays a fixed, recorded window with the watcher's own code. */
export function pinHead(call: Call, head: bigint | (() => bigint)): Call {
  const pinned = async (tool: string, args?: Record<string, unknown>, opts?: unknown) => {
    const out = await (call as (t: string, a?: Record<string, unknown>, o?: unknown) => Promise<unknown>)(tool, args, opts);
    if (tool !== "get_block_number") return out;
    const real = BigInt((out as { blockNumber: string }).blockNumber);
    const cap = typeof head === "function" ? head() : head;
    const n = real < cap ? real : cap;
    return { blockNumber: n.toString(), blockNumberHex: `0x${n.toString(16)}` };
  };
  return pinned as Call;
}
