// Atlantic reads for the web demos. The Atlantic Chain MCP runs locally over stdio (src/lib/mcp.ts), which a Vercel Function
// cannot start, so the demo pages read Atlantic through its public JSON-RPC endpoint instead. This adapter answers the same tool
// names with the same result shapes as the Chain MCP (ChainToolResults), so the tasks' own functions run on it unchanged.
// Read-only by construction: there is no send_raw_transaction here.
import { formatEther, formatGwei, type Hex } from "viem";
import { ChainToolError, type ChainMcp } from "../lib/mcp.js";
import { atlantic } from "../lib/networks.js";

export const ATLANTIC_RPC = atlantic.rpcUrls.default.http[0];

type Call = ChainMcp["call"];

const hex = (v: bigint | number) => `0x${v.toString(16)}` as Hex;
const dec = (h: unknown) => BigInt(String(h ?? "0x0")).toString();

/** "latest", "pending" (the pay tasks read the sender's pending nonce) or a decimal block number → the JSON-RPC block tag. */
export function blockTag(b: unknown): string {
  if (b === undefined || b === null || b === "latest") return "latest";
  if (b === "pending") return "pending";
  if (typeof b === "string" && /^\d+$/.test(b)) return hex(BigInt(b));
  if (typeof b === "string" && /^0x[0-9a-fA-F]+$/.test(b)) return b;
  throw new ChainToolError("block", `not a block number: ${JSON.stringify(b)}`);
}

/** A transaction object as the Chain MCP takes it → JSON-RPC (a decimal `value` becomes hex). */
function txObject(t: unknown): Record<string, unknown> {
  const o = { ...((t ?? {}) as Record<string, unknown>) };
  if (o.value !== undefined && typeof o.value === "string" && /^\d+$/.test(o.value)) o.value = hex(BigInt(o.value));
  if (typeof o.value === "bigint") o.value = hex(o.value);
  return o;
}

export interface RpcCallOptions {
  url?: string;
  /** Minimum gap between two requests (the public RPC refuses bursts: "request too fast per second"). Default 110 ms. */
  gapMs?: number;
  /** Attempts after a throttle or network error (default 4). */
  retries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const throttledMsg = /too fast|rate|limit|busy|timeout/i;

/** A Chain-MCP-shaped `call` for Atlantic over JSON-RPC. Requests are sent one at a time, spaced, and retried on throttling. */
export function atlanticRpcCall(o: RpcCallOptions = {}): Call & { requests(): number } {
  const url = o.url ?? ATLANTIC_RPC;
  const gap = o.gapMs ?? 110;
  const retries = o.retries ?? 4;
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;
  let count = 0;
  let id = 0;

  async function once(tool: string, method: string, params: unknown[]): Promise<unknown> {
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    count++;
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
    if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status} from the Atlantic RPC`), { transient: true });
    const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    if (body.error) {
      const msg = String(body.error.message ?? "error");
      if (body.error.code === -32011 || body.error.code === -32005 || (body.error.code !== 3 && throttledMsg.test(msg))) {
        throw Object.assign(new Error(msg), { transient: true });
      }
      throw new ChainToolError(tool, msg, body.error.code, body.error.data);
    }
    return body.result;
  }

  async function rpc(tool: string, method: string, params: unknown[]): Promise<unknown> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await once(tool, method, params);
        } catch (e) {
          const transient = (e as { transient?: boolean }).transient || (e instanceof TypeError) || (e as Error).name === "TimeoutError";
          if (!transient || attempt >= retries) throw e instanceof ChainToolError ? e : new ChainToolError(tool, (e as Error).message);
          await sleep(600 * (attempt + 1));
        }
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  }

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    switch (name) {
      case "get_block_number": {
        const h = (await rpc(name, "eth_blockNumber", [])) as Hex;
        return { blockNumber: dec(h), blockNumberHex: h };
      }
      case "get_balance": {
        const h = (await rpc(name, "eth_getBalance", [args.address, blockTag(args.block)])) as Hex;
        return { address: args.address, balanceWei: dec(h), balance: formatEther(BigInt(h)), symbol: atlantic.nativeCurrency.symbol, balanceHex: h };
      }
      case "get_transaction_count": {
        const h = (await rpc(name, "eth_getTransactionCount", [args.address, blockTag(args.block)])) as Hex;
        return { nonce: dec(h), nonceHex: h };
      }
      case "get_code":
        return { code: (await rpc(name, "eth_getCode", [args.address, blockTag(args.block)])) as Hex };
      case "get_gas_price": {
        const g = (await rpc(name, "eth_gasPrice", [])) as Hex;
        let p: Hex = "0x0";
        try {
          p = (await rpc(name, "eth_maxPriorityFeePerGas", [])) as Hex;
        } catch {
          // not every node serves it; the Chain MCP reports 0 then too
        }
        return { gasPriceWei: dec(g), gasPriceGwei: formatGwei(BigInt(g)), gasPriceHex: g, maxPriorityFeePerGasWei: dec(p), maxPriorityFeePerGasGwei: formatGwei(BigInt(p)), maxPriorityFeePerGasHex: p };
      }
      case "get_chain_info":
        // The activity engine asks for the coin symbol; the rest of the Chain MCP's answer is not needed here.
        return { chainId: atlantic.id, name: atlantic.name, nativeSymbol: atlantic.nativeCurrency.symbol, nativeDecimals: atlantic.nativeCurrency.decimals };
      case "get_block":
        return rpc(name, "eth_getBlockByNumber", [blockTag(args.block), args.includeTransactions === true]);
      case "get_transaction":
        return rpc(name, "eth_getTransactionByHash", [args.hash]);
      case "get_transaction_receipt":
        return rpc(name, "eth_getTransactionReceipt", [args.hash]);
      case "eth_call":
        return { result: (await rpc(name, "eth_call", [txObject(args.transaction), blockTag(args.block)])) as Hex };
      case "estimate_gas": {
        const g = (await rpc(name, "eth_estimateGas", [txObject(args.transaction)])) as Hex;
        return { gas: dec(g), gasHex: g };
      }
      case "get_logs": {
        const q: Record<string, unknown> = { fromBlock: blockTag(args.fromBlock), toBlock: blockTag(args.toBlock) };
        if (args.address !== undefined) q.address = args.address;
        if (args.topics !== undefined) q.topics = args.topics;
        return rpc(name, "eth_getLogs", [q]);
      }
      default:
        throw new ChainToolError(name, `${name} is not available on the read-only Atlantic RPC adapter`);
    }
  };
  return Object.assign(call as Call, { requests: () => count });
}
