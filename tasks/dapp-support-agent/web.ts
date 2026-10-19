// Live demo for the dApp Support Agent (web/dapp-support-agent, api/dapp-support-agent.ts). Read-only.
//   GET /api/dapp-support-agent?action=health
//   GET /api/dapp-support-agent?action=diagnose&hash=0x…&network=atlantic|pharos      NDJSON
// It runs the agent's own diagnose() and formatDiagnosis(): get_transaction, get_transaction_receipt, a replay with
// eth_call at the block before, then token and gas reads. Mainnet goes through the hosted Chain MCP; Atlantic reads use
// the same tools over JSON-RPC (src/web/demo.ts), because the Atlantic Chain MCP runs over stdio.
import type { Hex } from "viem";
import { busyResponse, concurrency, deployInfo, InputError, json, ndjson, openReader, pickHash, pickNetwork, type CallRecord, type Emit, type Reader } from "../../src/web/demo.js";
import type { Network } from "../../src/lib/mcp.js";
import { atlantic, pharos } from "../../src/lib/networks.js";
import { diagnose, formatDiagnosis } from "./diagnose.js";

/** The transactions in the README's proof table, with the cause the CLI recorded for each (the page compares). */
export const EXAMPLES = [
  { id: "balance", label: "Insufficient token balance", network: "atlantic", hash: "0x9db3e679e2d7a9f8a6a21052800be283a45862722418f94ae7bb11fa79285f11", recorded: "insufficient-balance" },
  { id: "allowance", label: "Insufficient allowance", network: "atlantic", hash: "0x8b9b9353b9df376bf05067d5cc3fc921730ddc7a78cbbdac0c071e5d2970bf93", recorded: "insufficient-allowance" },
  { id: "out-of-gas", label: "Out of gas", network: "atlantic", hash: "0x4e6cc4339009576aada882d2d843d1ee0e33f0bce2ddeddfdc8d41cc41414ab5", recorded: "out-of-gas" },
  { id: "empty-revert", label: "Revert with no message", network: "atlantic", hash: "0xf05ce6e6b1394e833196fc88b27bbea37a96300cc0683c7a26fbd7aa15db2515", recorded: "insufficient-balance" },
  { id: "mainnet-third-party-revert", label: "Mainnet, not ours: reason string", network: "pharos", hash: "0x360551d640f569c208de26a7380230fac002cdc7fc7378501decc6a6bc64227c", recorded: "revert-reason" },
  { id: "mainnet-third-party-not-reproduced", label: "Mainnet, not ours: not reproducible", network: "pharos", hash: "0xa449024e34e2249da119183eb5b877f4b2294d70daf8d5b1c0929fe99b136951", recorded: "not-reproduced" },
  { id: "success", label: "A transaction that did not fail", network: "atlantic", hash: "0xee5ef39c357f34e39a4c8902dd59b51bcc0a116d6a686bbffa9501c0dd525e0b", recorded: "succeeded" },
] as const;

export function parseDiagnose(url: URL): { hash: Hex; network: Network } {
  return { hash: pickHash(url.searchParams.get("hash")), network: pickNetwork(url.searchParams.get("network"), "atlantic") };
}

/** Which lamp a tool call belongs to: the replay is the eth_call that carries the original gas limit. */
export function lampOf(c: Pick<CallRecord, "tool" | "args">): "tx" | "receipt" | "replay" | "reads" | null {
  if (c.tool === "get_transaction") return "tx";
  if (c.tool === "get_transaction_receipt") return "receipt";
  if (c.tool === "eth_call" && (c.args.transaction as { gas?: unknown } | undefined)?.gas !== undefined) return "replay";
  if (c.tool === "eth_call" || c.tool === "estimate_gas") return "reads";
  return null;
}

export async function run(hash: Hex, network: Network, emit: Emit, open: (n: Network, onCall: (r: CallRecord) => void) => Promise<Reader> = (n, c) => openReader(n, c)): Promise<void> {
  const calls: CallRecord[] = [];
  let reads = { n: 0, ms: 0 };
  const onCall = (r: CallRecord) => {
    calls.push(r);
    emit({ type: "call", ...r });
    const lamp = lampOf(r);
    if (lamp === "tx") emit({ type: "step", id: "tx", state: r.ok ? "ok" : "failed", label: r.ok ? "fetched" : "failed", ms: r.ms });
    else if (lamp === "receipt") emit({ type: "step", id: "receipt", state: r.ok ? "ok" : "failed", label: r.ok ? "fetched" : "failed", ms: r.ms });
    else if (lamp === "replay") emit({ type: "step", id: "replay", state: r.ok ? "ok" : "refused", label: r.ok ? "replay succeeds" : r.error?.code === 3 ? "reverts (code 3)" : (r.error?.reason ?? "error").slice(0, 40), ms: r.ms });
    else if (lamp === "reads") reads = { n: reads.n + 1, ms: reads.ms + r.ms };
  };
  emit({ type: "start", hash, network });
  const t0 = performance.now();
  const reader = await open(network, onCall).catch((e) => {
    emit({ type: "step", id: "connect", state: "failed", label: "no connection", ms: Math.round(performance.now() - t0) });
    throw e;
  });
  try {
    emit({ type: "step", id: "connect", state: "ok", label: `chain ${reader.chainId}`, ms: Math.round(performance.now() - t0), detail: { endpoint: reader.endpoint, via: reader.via } });
    const t = performance.now();
    const d = await diagnose(reader.call, hash);
    // Steps that diagnose() did not need (a success has no replay) are shown as skipped.
    for (const id of ["tx", "receipt", "replay"] as const) if (!calls.some((c) => lampOf(c) === id)) emit({ type: "step", id, state: "skip", label: "not needed" });
    emit({ type: "step", id: "reads", state: reads.n ? "ok" : "skip", label: reads.n ? `${reads.n} read${reads.n === 1 ? "" : "s"}` : "not needed", ms: reads.n ? reads.ms : undefined });
    emit({ type: "step", id: "explain", state: d.outcome === "failed" ? "ok" : d.outcome === "succeeded" ? "ok" : "refused", label: d.cause, ms: Math.round(performance.now() - t) });
    const chain = network === "pharos" ? pharos : atlantic;
    const text = formatDiagnosis(d, { label: `${network} (chain ${chain.id}) via ${reader.endpoint}`, explorer: chain.blockExplorers.default.url });
    const example = EXAMPLES.find((x) => x.hash === hash.toLowerCase() && x.network === network);
    emit({
      type: "done",
      network,
      chainId: chain.id,
      endpoint: reader.endpoint,
      via: reader.via,
      explorer: `${chain.blockExplorers.default.url}/tx/${hash}`,
      diagnosis: d,
      text,
      recorded: example ? { id: example.id, cause: example.recorded, matches: example.recorded === d.cause } : null,
      calls: calls.length,
    });
  } finally {
    await reader.close().catch(() => {});
  }
}

const gate = concurrency(4);

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "health";
  try {
    if (req.method !== "GET") return json({ error: "use GET" }, 405);
    if (action === "health") return json({ status: "ok", task: "dapp-support-agent", examples: EXAMPLES, deploy: deployInfo() });
    if (action === "diagnose") {
      const { hash, network } = parseDiagnose(url);
      if (!gate.take()) return busyResponse("diagnosis");
      return ndjson((emit) => run(hash, network, emit), () => gate.release());
    }
    return json({ error: `unknown action ${JSON.stringify(action)}; use health or diagnose` }, 404);
  } catch (e) {
    if (e instanceof InputError) return json({ error: e.message }, 400);
    return json({ error: (e as Error).message }, 500);
  }
}
