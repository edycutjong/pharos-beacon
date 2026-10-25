// Live demo endpoint for the Multi-Protocol Aggregator (api/router.ts → this file). Read-only, mainnet only: it runs the CLI's own
// aggregate() over six venues of three protocols at one block and renders the same report. A deposit or withdrawal is only ever an
// UNSIGNED plan for the owner's wallet: this file imports no signer. `down` is the simulated-outage drill and is labelled SIMULATED.
//   GET ?action=info
// A bad `down` venue id or a refused withdrawal is only known after the reads, so it ends the stream with an error event.
//   GET ?action=run&kind=rates|positions|deposit|withdraw[&wallet=0x…][&amount=250|all][&down=morpho,…][&holdDays=30][&block=N]   NDJSON
import { getAddress, isAddress, parseUnits, type Hex } from "viem";
import { pharos } from "../../src/lib/networks.js";
import { PROS_POOL, headerAt, readProsPrice } from "../../src/portfolio/read.js";
import { DEFAULT_RATE_OPTIONS, parseWindows } from "../../src/yield/model.js";
import { MAINNET_VAULT_SOURCES, USDC_MAINNET, morphoUsdcSources } from "../../src/yield/sources.js";
import { venuesFromSources } from "../../src/aggregator/adapters.js";
import { renderReport } from "../../src/aggregator/format.js";
import { InsufficientFunds, aggregate, type Request } from "../../src/aggregator/run.js";
import { InputError, stepper, trackPhases, type Emit } from "../../src/web/live.js";
import { numParam, serve, type Deps } from "../../src/web/mainnet-live.js";
import type { View } from "../../src/web/view.js";

const KINDS = ["rates", "positions", "deposit", "withdraw"] as const;
const PROTOCOLS = ["rockawayx", "morpho", "centrifuge"];
/** A real mainnet RockawayX holder from the recorded runs, so a withdrawal has something to route. */
export const SAMPLE_WALLET = "0x62A0e4b7fD967fab5be1a733c09b22eBC4510673";

export interface RunParams { kind: (typeof KINDS)[number]; wallet: Hex; amount?: string; down: string[]; holdDays: number; block?: bigint }

export function parseRun(url: URL): RunParams {
  const q = url.searchParams;
  const kind = (q.get("kind") ?? "rates") as RunParams["kind"];
  if (!KINDS.includes(kind)) throw new InputError(`kind must be one of ${KINDS.join(", ")}`);
  const w = (q.get("wallet") ?? SAMPLE_WALLET).trim();
  if (!isAddress(w, { strict: false })) throw new InputError("wallet must be a 0x address (40 hex digits)");
  const amount = (q.get("amount") ?? "").trim();
  if (kind === "deposit" || kind === "withdraw") {
    if (!amount) throw new InputError(`${kind} needs amount (a USDC amount${kind === "withdraw" ? " or all" : ""})`);
    if (amount === "all" ? kind === "deposit" : !/^\d{1,10}(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) throw new InputError("amount must be a positive USDC amount with at most 6 decimals (all only for a withdrawal)");
  } else if (amount) throw new InputError("amount is for deposit and withdraw");
  const down = (q.get("down") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const d of down) if (!PROTOCOLS.includes(d) && !/^[a-z]+-[0-9a-f]{6}$/.test(d)) throw new InputError(`down: "${d.slice(0, 40)}" is not a protocol (${PROTOCOLS.join(", ")}) or a venue id like morpho-c79579`);
  const block = (q.get("block") ?? "").trim();
  if (block && !/^\d{1,10}$/.test(block)) throw new InputError("block must be a block number (digits only)");
  return { kind, wallet: getAddress(w), ...(amount ? { amount } : {}), down, holdDays: numParam(q, "holdDays", 30, 0.5, 365), ...(block ? { block: BigInt(block) } : {}) };
}

/** The header read comes first, then every venue read is one "venues" phase (a lamp per phase change, not per call). */
const phaseOf = (tool: string, _a: unknown, cur: string | undefined) => (cur === undefined ? "header" : cur === "header" && tool !== "get_block_number" && tool !== "get_block" ? "venues" : cur);

const brief = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function run(p: RunParams, emit: Emit, deps: Deps): Promise<void> {
  const t0 = Date.now();
  const conn = await deps.connect();
  emit({ type: "start", network: "pharos", endpoint: conn.endpoint });
  const t = trackPhases(conn.call, emit, phaseOf, (_ph, n) => `${n} call${n === 1 ? "" : "s"}`);
  try {
    const call = t.call;
    const h = await headerAt(call, p.block);
    const price = await readProsPrice(call, h.block);
    const nativeUsd = { value: price.price, basis: `PROS in USDC from the WPROS/USDC pool ${PROS_POOL} slot0 at block ${h.block}` };
    const m = await morphoUsdcSources(call, USDC_MAINNET, h.block, h.timestamp);
    const venues = venuesFromSources([...MAINNET_VAULT_SOURCES, ...m.sources]);
    const unknown = p.down.filter((d) => !PROTOCOLS.includes(d) && !venues.some((v) => v.id === d));
    if (unknown.length) throw new InputError(`down: no venue ${unknown.join(", ")}; venues: ${venues.map((v) => v.id).join(", ")}`);
    const request: Request = p.kind === "deposit" || p.kind === "withdraw"
      ? { kind: p.kind, assets: p.amount === "all" ? "all" : parseUnits(p.amount!, 6) } as Request
      : { kind: p.kind };
    const report = await aggregate({
      call, chainId: pharos.id, network: "pharos", wallet: p.wallet, venues, usdc: USDC_MAINNET, assetDecimals: 6, windows: parseWindows("1d,7d,30d"), holdDays: p.holdDays,
      nativeUsd, request, block: p.block, rate: { ...DEFAULT_RATE_OPTIONS, haircut: 0.5 }, down: p.down, venueTimeoutMs: 60_000, assumeFunded: p.kind === "deposit", skipped: m.skipped,
    }).catch((e) => {
      if (e instanceof InsufficientFunds) throw new InputError(`refused: ${e.message}`);
      throw e;
    });
    t.finish();
    const s = stepper(emit);
    s.begin("route");
    s.end("route", report.route ? "ok" : "skip", report.route ? `${report.route.allocations.length} venue${report.route.allocations.length === 1 ? "" : "s"}` : "no routing for a query");
    const lines = renderReport(report);
    const view: View = {
      tone: p.down.length || report.down.length ? "warn" : "ok",
      verdict: brief(report.route ? report.route.explanation[0] ?? "Routed" : `${report.views.length} venues read at block ${report.block}`),
      note: `Pharos mainnet block ${report.block}. Three protocols (RockawayX, Morpho Blue, Centrifuge) behind one Adapter interface. Async funds are shown, never chosen. Nothing is signed: a deposit or withdrawal is an unsigned plan for the owner's wallet.${p.down.length ? " A venue marked SIMULATED is a drill, not a real outage." : ""}`,
      tables: report.plan ? [{ head: ["Step", "Action", "Venue", "Gas"], rows: report.plan.transactions.map((x) => [String(x.step), x.description, x.venue, `${x.gas.units.toLocaleString("en-US")} (${x.gas.basis})`]) }] : [],
      text: lines.join("\n"),
      evidence: [
        ["Wallet", { t: p.wallet, href: `https://www.pharosscan.xyz/address/${p.wallet}` }],
        ["Block", `${report.block}${p.block !== undefined ? " (pinned)" : " (the head, read first)"}`],
        ["Request", p.kind === "deposit" || p.kind === "withdraw" ? `${p.kind} ${p.amount} USDC` : p.kind],
        ["Chain MCP reads", `${t.total()} calls`],
        ["Signed", "nothing: this page has no key"],
      ],
      summary: report.route ? brief(report.route.explanation[0] ?? "Routed.") : `${report.views.length} venues read.`,
    };
    emit({ type: "done", totalMs: Date.now() - t0, reads: t.total(), view });
  } catch (e) {
    t.finish(e as Error);
    throw e;
  } finally {
    await conn.close().catch(() => {});
  }
}

export const handle = serve("multi-protocol-aggregator", parseRun, run, { kinds: KINDS, protocols: PROTOCOLS });
