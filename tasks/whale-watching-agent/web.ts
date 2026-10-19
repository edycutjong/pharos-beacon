// Live demo endpoint for the Whale-Watching Agent (api/whale-watching-agent.ts). Read-only, Pacific mainnet, hosted Chain MCP.
//   GET ?action=info                                         the committed watchlist and the limits of this endpoint
//   GET ?action=run&window=recent&blocks=2000[&usdc=25000&wpros=2000]   scan the latest blocks, streamed as NDJSON
//   GET ?action=run&window=pinned[&usdc=…&wpros=…]                      re-read the pinned window of the recorded 299,999.5 USDC mint
// It runs the CLI's own functions (src/whale/scan.ts) on the committed watchlist; only the thresholds can be changed per run.
import { getAddress, type Hex } from "viem";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import { InputError, actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, pinnedJson, stepper, type Emit } from "../../src/web/live.js";
import { explain, fmtAmount, isSignificant, kindResolver, loadTokens, makeNamer, parseWatchlist, scanMoves, summarise, type Move, type Report, type Watchlist } from "../../src/whale/scan.js";

export const WATCHLIST_PATH = "tasks/whale-watching-agent/watchlist.json";
/** Blocks per live scan: 1,000 to 4,000 (16 get_logs calls at most, inside the hosted server's 120 requests a minute). */
export const BLOCK_CHOICES = [1000, 2000, 4000] as const;
/** The recorded run's report [7] (299,999.5 USDC minted into watch-1, block 20528623) and [8] (watch-1 → watch-2, block 20531788). */
export const PINNED = { from: 20528600n, to: 20531800n } as const;
/** Reports explained per run (each costs 6–10 archive reads), the largest multiples of their threshold first. */
export const MAX_EXPLAINED = 4;

type Conn = Pick<ChainMcp, "call" | "close" | "endpoint" | "chainId">;
export interface Deps {
  connect: () => Promise<Conn>;
  fetch?: typeof fetch;
}
const defaultDeps: Deps = { connect: () => chainMcp("pharos", { timeoutMs: 20_000 }) };

export interface RunParams {
  window: "recent" | "pinned";
  blocks: number;
  thresholds: { USDC?: string; WPROS?: string };
}

const threshold = (url: URL, name: string): string | undefined => {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(v) || Number(v) <= 0) throw new InputError(`${name} must be a positive number of tokens, e.g. 25000 (up to 12 digits, 6 decimals)`);
  return v;
};

/** Validate the query of a run. Throws InputError with the reason. */
export function parseRun(url: URL): RunParams {
  const window = url.searchParams.get("window") ?? "recent";
  if (window !== "recent" && window !== "pinned") throw new InputError('window must be "recent" or "pinned"');
  const blocks = Number(url.searchParams.get("blocks") ?? 2000);
  if (!(BLOCK_CHOICES as readonly number[]).includes(blocks)) throw new InputError(`blocks must be one of ${BLOCK_CHOICES.join(", ")}`);
  return { window, blocks, thresholds: { USDC: threshold(url, "usdc"), WPROS: threshold(url, "wpros") } };
}

/** The committed watchlist with this run's thresholds (by token symbol, after decimals() and symbol() are read). */
const withThresholds = (wl: Watchlist, symbols: Map<string, string>, t: RunParams["thresholds"]): Watchlist => ({
  ...wl,
  tokens: wl.tokens.map((tok) => {
    const sym = symbols.get(tok.address.toLowerCase());
    const v = sym === "USDC" ? t.USDC : sym === "WPROS" ? t.WPROS : undefined;
    return v ? { ...tok, threshold: v } : tok;
  }),
});

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function reportJson(r: Report) {
  const m = r.move;
  const f = (raw: bigint) => fmtAmount(raw, m.token.decimals, m.token.symbol);
  return {
    tx: m.tx, explorer: explorerTx("pharos", m.tx), logIndex: m.logIndex, block: m.block.toString(), timestamp: r.timestamp ?? null,
    token: m.token.symbol, direction: r.direction, amount: f(m.amountRaw), multiple: r.multiple,
    from: m.from, fromName: r.fromName, to: m.to, toName: r.toName, why: r.why, tags: r.tags,
    subject: r.subject, balanceBefore: f(r.beforeRaw), balanceAfter: f(r.afterRaw),
    ...(r.receiver ? { receiver: { address: r.receiver.address, name: r.receiver.name, before: f(r.receiver.beforeRaw), after: f(r.receiver.afterRaw) } } : {}),
  };
}

export async function run(p: RunParams, emit: Emit, deps: Deps = defaultDeps): Promise<void> {
  const t0 = Date.now();
  const s = stepper(emit);
  s.begin("connect");
  const mcp = await deps.connect();
  try {
    const head = BigInt((await mcp.call("get_block_number")).blockNumber);
    s.end("connect", "ok", `chain ${mcp.chainId} · head ${head}`);

    s.begin("watchlist");
    const committed = parseWatchlist(await pinnedJson(WATCHLIST_PATH, deps.fetch));
    const base = await loadTokens(mcp.call, committed.tokens);
    const wl = withThresholds(committed, new Map(base.map((t) => [t.address.toLowerCase(), t.symbol])), p.thresholds);
    const tokens = await loadTokens(mcp.call, wl.tokens);
    const kindOf = kindResolver(mcp.call);
    const watched = [];
    for (const w of wl.addresses) watched.push({ ...w, kind: await kindOf(w.address) });
    s.end("watchlist", "ok", `${watched.length} addresses · ${tokens.map((t) => `${t.symbol} ≥ ${t.threshold}`).join(", ")}`);

    const from = p.window === "pinned" ? PINNED.from : head - BigInt(p.blocks) + 1n;
    const to = p.window === "pinned" ? PINNED.to : head;
    emit({
      type: "start", network: "pharos", chainId: mcp.chainId, endpoint: mcp.endpoint, head: head.toString(), window: p.window,
      range: { from: from.toString(), to: to.toString(), blocks: (to - from + 1n).toString() },
      watched, thresholds: tokens.map((t) => ({ token: getAddress(t.address), symbol: t.symbol, threshold: t.threshold, decimals: t.decimals })),
      source: wl.source,
    });

    const all: Move[] = [];
    for (const t of tokens) {
      const id = `scan-${t.symbol.toLowerCase()}`;
      s.begin(id);
      const moves = await scanMoves(mcp.call, t, wl.addresses.map((a) => a.address), from, to);
      all.push(...moves);
      s.end(id, "ok", `${moves.length} transfers · ${moves.filter(isSignificant).length} ≥ ${t.threshold}`);
    }

    s.begin("explain");
    const significant = all.filter(isSignificant);
    const largest = new Map<string, bigint>();
    for (const m of significant) if ((largest.get(m.token.address) ?? 0n) < m.amountRaw) largest.set(m.token.address, m.amountRaw);
    const ranked = [...significant].sort((a, b) => {
      const ma = Number((a.amountRaw * 100n) / a.token.thresholdRaw), mb = Number((b.amountRaw * 100n) / b.token.thresholdRaw);
      return mb - ma || (a.block < b.block ? -1 : 1);
    });
    const pick = ranked.slice(0, MAX_EXPLAINED).sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
    const namer = makeNamer(wl, "pharos", tokens, kindOf);
    const reports = [];
    for (const m of pick) reports.push(reportJson(await explain(mcp.call, m, wl, namer, kindOf, { largest: largest.get(m.token.address)! })));
    s.end("explain", significant.length ? "ok" : "skip", significant.length ? `${reports.length} of ${significant.length} explained` : "nothing at or above the thresholds");

    s.begin("summary");
    const rows = summarise(wl, tokens, all).map((r) => ({
      label: r.label, address: r.address, token: r.token, transfers: r.transfers, significant: r.significant,
      in: fmtAmount(r.inRaw, r.decimals, ""), out: fmtAmount(r.outRaw, r.decimals, ""), largest: fmtAmount(r.largestRaw, r.decimals, ""),
    }));
    const totals = tokens.map((t) => {
      const mine = significant.filter((m) => m.token.address === t.address);
      return { token: t.symbol, significant: mine.length, moved: fmtAmount(mine.reduce((x, m) => x + m.amountRaw, 0n), t.decimals, t.symbol) };
    });
    const unexplained = ranked.slice(MAX_EXPLAINED).map((m) => ({
      tx: m.tx, explorer: explorerTx("pharos", m.tx), block: m.block.toString(), token: m.token.symbol,
      amount: fmtAmount(m.amountRaw, m.token.decimals, m.token.symbol), from: short(m.from), to: short(m.to),
    }));
    s.end("summary", "ok", `${rows.filter((r) => r.transfers > 0).length} of ${rows.length} rows active`);
    emit({ type: "done", totalMs: Date.now() - t0, transfers: all.length, significant: significant.length, reports, unexplained, rows, totals });
  } finally {
    await mcp.close().catch(() => {});
  }
}

const gate = concurrencyGate(2);

export function handle(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  return guard(async () => {
    const url = new URL(req.url);
    const action = actionOf(url, ["info", "run"] as const, "info");
    if (action === "info") {
      return json({
        task: "whale-watching-agent", network: "pharos", chainId: 1672, reads: "hosted Chain MCP https://mcp.pharos.xyz/mcp (keyless, read-only)",
        watchlist: parseWatchlist(await pinnedJson(WATCHLIST_PATH, deps.fetch)),
        limits: { blocks: BLOCK_CHOICES, explainedPerRun: MAX_EXPLAINED, pinned: { from: PINNED.from.toString(), to: PINNED.to.toString() } },
        deploy: deployInfo(),
      });
    }
    const p = parseRun(url);
    if (!gate.take()) return busy();
    return ndjson((emit) => run(p, emit, deps), gate.release);
  });
}
