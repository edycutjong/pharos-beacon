// Live demo endpoint for the Wallet Risk Checker (api/wallet-risk-checker.ts). Read-only: it runs the CLI's own checkAddress
// (src/risk/check.ts) and never signs. Pacific mainnet reads go through the hosted Chain MCP; Atlantic reads go through the
// public Atlantic RPC (src/web/atlantic-rpc.ts), because the Atlantic Chain MCP runs locally over stdio, not on Vercel.
//   GET ?action=info
//   GET ?action=check&address=0x…&network=pharos|atlantic[&block=N][&lookback=1000|5000][&list=ours|empty]   NDJSON
import { getAddress, isAddress, type Hex } from "viem";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { checkAddress, parseRiskConfig, type RiskConfig } from "../../src/risk/check.js";
import { atlanticRpcCall } from "../../src/web/atlantic-rpc.js";
import { InputError, actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, pinnedJson, stepper, trackPhases, type Emit } from "../../src/web/live.js";

export const CONFIGS = { ours: "tasks/wallet-risk-checker/risk-config.json", empty: "tasks/wallet-risk-checker/risk-config-no-list.json" } as const;
/** The CLI reads 30,000 blocks of token history; the page reads at most 5,000 so a check stays inside the RPC rate limits. */
export const LOOKBACKS = [1000, 5000] as const;

type Call = ChainMcp["call"];
export interface Conn {
  call: Call;
  endpoint: string;
  close(): Promise<void>;
}
export interface Deps {
  connect: (network: "pharos" | "atlantic") => Promise<Conn>;
  fetch?: typeof fetch;
}
const defaultDeps: Deps = {
  connect: async (network) => {
    if (network === "atlantic") return { call: atlanticRpcCall(), endpoint: "public Atlantic RPC https://atlantic.dplabs-internal.com", close: async () => {} };
    const m = await chainMcp("pharos", { timeoutMs: 20_000 });
    return { call: m.call, endpoint: `hosted Chain MCP ${m.endpoint}`, close: () => m.close() };
  },
};

export interface CheckParams {
  address: Hex;
  network: "pharos" | "atlantic";
  block?: bigint;
  lookback: number;
  list: keyof typeof CONFIGS;
}

export function parseCheck(url: URL): CheckParams {
  const q = url.searchParams;
  const a = (q.get("address") ?? "").trim();
  if (!isAddress(a, { strict: false })) throw new InputError("address must be a 0x address (40 hex characters)");
  const network = q.get("network") ?? "pharos";
  if (network !== "pharos" && network !== "atlantic") throw new InputError('network must be "pharos" (mainnet) or "atlantic" (testnet)');
  const b = q.get("block");
  if (b !== null && b !== "" && !/^\d{1,10}$/.test(b)) throw new InputError("block must be a block number (digits only)");
  const lookback = Number(q.get("lookback") ?? 5000);
  if (!(LOOKBACKS as readonly number[]).includes(lookback)) throw new InputError(`lookback must be one of ${LOOKBACKS.join(", ")} blocks`);
  const list = q.get("list") ?? "ours";
  if (list !== "ours" && list !== "empty") throw new InputError('list must be "ours" (our flagged list) or "empty" (no list)');
  return { address: getAddress(a), network, ...(b ? { block: BigInt(b) } : {}), lookback, list };
}

/**
 * The phase of each tool call inside checkAddress, in its fixed order: the head; code, nonce and balance at the head; the age
 * search (archive reads by binary search, then two block timestamps); the token history (get_logs pages, two timestamps, and a
 * get_code of a suspicious spender).
 */
export function riskPhase() {
  let sawBalance = false;
  let sawLogs = false;
  return (tool: string, _args: Record<string, unknown>, current: string | undefined): string => {
    if (tool === "get_block_number" && !current) return "head";
    if (tool === "get_logs") return (sawLogs = true), "logs";
    if (sawLogs) return "logs";
    if (tool === "get_balance") return (sawBalance = true), "reads";
    return sawBalance ? "age" : current === "head" || current === "reads" ? "reads" : current ?? "head";
  };
}
const phaseLabel = (p: string, n: number) =>
  p === "head" ? "chain head read" : p === "reads" ? `${n} reads at the block` : p === "age" ? `${n} archive reads (binary search)` : `${n} reads: token Transfer and Approval logs`;

export async function check(p: CheckParams, emit: Emit, deps: Deps = defaultDeps): Promise<void> {
  const t0 = Date.now();
  const config: RiskConfig = parseRiskConfig(await pinnedJson(CONFIGS[p.list], deps.fetch));
  const conn = await deps.connect(p.network);
  emit({ type: "start", address: p.address, network: p.network, block: p.block?.toString() ?? "latest", lookback: p.lookback, list: p.list, flagged: config.flagged.length, endpoint: conn.endpoint });
  const t = trackPhases(conn.call, emit, riskPhase(), phaseLabel);
  try {
    const report = await checkAddress(t.call, p.address, { network: p.network, config, lookbackBlocks: BigInt(p.lookback), ...(p.block !== undefined ? { block: p.block } : {}) });
    t.finish();
    const s = stepper(emit);
    s.begin("verdict");
    const flags = report.signals.filter((x) => x.level === "medium" || x.level === "high").length;
    s.end("verdict", report.verdict === "low" ? "ok" : "refused", `${report.verdict.toUpperCase()} · ${flags} red flag${flags === 1 ? "" : "s"}`);
    emit({
      type: "done", totalMs: Date.now() - t0, reads: t.total(),
      report: { ...report, block: report.block.toString(), lookbackBlocks: report.lookbackBlocks.toString() },
    });
  } catch (e) {
    t.finish(e as Error);
    throw e;
  } finally {
    await conn.close().catch(() => {});
  }
}

const gate = concurrencyGate(2);

export function handle(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  return guard(async () => {
    const url = new URL(req.url);
    const action = actionOf(url, ["info", "check"] as const, "info");
    if (action === "info") {
      return json({
        task: "wallet-risk-checker",
        reads: { pharos: "hosted Chain MCP https://mcp.pharos.xyz/mcp", atlantic: "public Atlantic RPC (the Atlantic Chain MCP runs locally over stdio, not on Vercel)" },
        config: parseRiskConfig(await pinnedJson(CONFIGS.ours, deps.fetch)),
        limits: { lookback: LOOKBACKS },
        deploy: deployInfo(),
      });
    }
    const p = parseCheck(url);
    if (!gate.take()) return busy();
    return ndjson((emit) => check(p, emit, deps), gate.release);
  });
}
