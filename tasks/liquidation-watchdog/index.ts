// Liquidation Watchdog (Medium · 100 pts): watches lending positions on Pharos mainnet (Morpho Blue), computes each health factor,
// alerts below configurable warn / critical thresholds with timestamps (console, optionally Discord) and says what to do.
//   npm run liquidation-watchdog -- scan  [--lookback-days 7] [--market 0x<id>] [--warn 1.3] [--critical 1.1] [--shock 0.05] [--top 10] [--discord] [--proof name]
//   npm run liquidation-watchdog -- watch [--interval-s 60] [--max-polls 10] [same thresholds] [--discord]
//   npm run liquidation-watchdog -- position --market 0x<id> --user 0x<address> [--warn 1.3] [--critical 1.1]
// All chain reads go through the Pharos Chain MCP (hosted, read-only). The watchdog never signs or sends anything.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, isHex, type Hex } from "viem";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { wait } from "../../src/lib/net.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { writeJsonAtomic } from "../../src/lib/state.js";
import { secondsPerBlock } from "../../src/arb/backtest.js";
import { buildAlert, checkThresholds, fmtToken, levelOf, marketLabel, nextLevel, pct, short, severity, type Alert, type Level, type Thresholds } from "../../src/liq/alert.js";
import { discoverBorrowers } from "../../src/liq/discover.js";
import { evaluate, readPosition, snapshotMarket, type MarketSnapshot, type PositionHealth } from "../../src/liq/morpho.js";
import { discordNotifier, loadWebhook, type Notifier } from "../../src/watch/discord.js";

const TASK = "liquidation-watchdog";
const HERE = fileURLToPath(new URL(".", import.meta.url));

export interface Row { snap: MarketSnapshot; p: PositionHealth; level: Level }

const num = (flag: string, v: string, min: number, max = Infinity) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`${flag} must be a number between ${min} and ${max}`);
  return n;
};
const marketId = (flag: string, v: string): Hex => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new UsageError(`${flag} must be a 32-byte Morpho market id (0x + 64 hex digits)`);
  return v.toLowerCase() as Hex;
};

/** The ranked table: closest to liquidation first. Pure, so tests and the proof use the same text. */
export function tableText(rows: Row[], top: number, shock: number): string {
  const head = ["#", "market", "account", "health", "drop to liquidation", ...(shock > 0 ? [`health at −${pct(shock, 1)}`] : []), "debt", "collateral", "level"];
  const out = [head.join(" | ")];
  rows.slice(0, top).forEach((r, i) => {
    const { snap, p } = r;
    const cells = [String(i + 1), marketLabel(snap), short(p.user), p.hfNumber.toFixed(4), pct(p.dropToLiquidation)];
    if (shock > 0) cells.push(shockedHf(r, shock).toFixed(4));
    cells.push(`${fmtToken(p.debt, snap.loan.decimals)} ${snap.loan.symbol}`, `${fmtToken(p.collateral, snap.collateral.decimals)} ${snap.collateral.symbol}`, r.level);
    out.push(cells.join(" | "));
  });
  return out.join("\n");
}

/** Health factor of a row if the collateral price fell by `shock` (a what-if, computed from the same read). */
export function shockedHf(r: Row, shock: number): number {
  const debt = r.p.debt;
  if (debt === 0n) return Infinity;
  const price = (r.snap.price * BigInt(Math.round((1 - shock) * 1e9))) / 1_000_000_000n;
  const maxB = (((r.p.collateral * price) / 10n ** 36n) * r.snap.params.lltv) / 10n ** 18n;
  return Number((maxB * 10n ** 18n) / debt) / 1e18;
}

export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => a.p.hfNumber - b.p.hfNumber);
}

interface LevelFile { levels: Record<string, Level> }
const loadLevels = (file: string): LevelFile => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as LevelFile) : { levels: {} });

export async function main({ onExit, signal }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- scan|watch|position [--lookback-days N] [--market 0x<id>] [--user 0x<address>] [--warn 1.3] [--critical 1.1] [--rearm 0.02] [--shock 0.05] [--top N] [--discord] [--interval-s N] [--max-polls N] [--index file] [--proof name]`,
      options: {
        "lookback-days": { type: "string", default: "7" }, market: { type: "string" }, user: { type: "string" },
        warn: { type: "string", default: "1.3" }, critical: { type: "string", default: "1.1" }, rearm: { type: "string", default: "0.02" },
        shock: { type: "string", default: "0" }, top: { type: "string", default: "10" }, discord: { type: "boolean", default: false },
        "interval-s": { type: "string", default: "60" }, "max-polls": { type: "string", default: "10" },
        index: { type: "string", default: join(HERE, "state/borrowers.json") }, levels: { type: "string", default: join(HERE, "state/levels.json") }, proof: { type: "string" },
      },
      positionals: [1, 1],
    },
    argv,
  );
  const cmd = choice("command", positionals[0], ["scan", "watch", "position"] as const);
  let t: Thresholds;
  try {
    t = checkThresholds({ warn: num("--warn", values.warn!, 1), critical: num("--critical", values.critical!, 1), rearm: num("--rearm", values.rearm!, 0) });
  } catch (e) {
    throw e instanceof UsageError ? e : new UsageError((e as Error).message);
  }
  const shock = num("--shock", values.shock!, 0, 0.99);
  const top = Math.round(num("--top", values.top!, 1, 200));
  const lookbackDays = num("--lookback-days", values["lookback-days"]!, 0.01, 400);
  const intervalS = num("--interval-s", values["interval-s"]!, 1);
  const maxPolls = Math.round(num("--max-polls", values["max-polls"]!, 1, 1000));
  if (cmd === "position" && (!values.market || !values.user)) throw new UsageError("position needs --market and --user");
  if (values.user && !isAddress(values.user)) throw new UsageError("--user must be an address");
  if (values.proof && cmd === "watch") throw new UsageError("--proof is for scan and position (a watch is a long-running log)");
  const only = values.market ? marketId("--market", values.market) : undefined;
  const notifier: Notifier | undefined = values.discord ? discordNotifier(loadWebhook()) : undefined;

  const mcp = await chainMcp("pharos");
  onExit(() => mcp.close());
  const call = mcp.call.bind(mcp);
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined;
  const log = (s: string) => console.log(s);

  const header = async () => {
    const head = BigInt((await mcp.call("get_block_number")).blockNumber);
    const block = await mcp.call("get_block", { block: head.toString() });
    if (!block) throw new Error(`the Chain MCP returned no block ${head}`);
    return { head, timestamp: BigInt(block.timestamp) };
  };

  /** Read every borrower's position and classify it. */
  async function readAll(index: Record<string, Hex[]>, ts: bigint): Promise<Row[]> {
    const rows: Row[] = [];
    for (const [id, users] of Object.entries(index)) {
      if (only && id !== only) continue;
      const snap = await snapshotMarket(call, id as Hex, ts);
      for (const user of users) {
        if (signal.aborted) throw new Error("interrupted");
        const pos = await readPosition(call, id as Hex, user);
        const p = evaluate(user, pos, snap);
        if (p.debt === 0n) continue; // repaid or liquidated since its Borrow event
        rows.push({ snap, p, level: levelOf(p.hfNumber, t) });
      }
    }
    return rows;
  }

  async function deliver(alerts: Alert[], extra = ""): Promise<{ channel: string; at: string; id?: string }[]> {
    const out: { channel: string; at: string; id?: string }[] = [];
    for (const a of alerts) log(a.text);
    if (notifier && alerts.length) {
      const first = alerts[0]!;
      const body = alerts.length > 1 ? `${first.text}\n(+${alerts.length - 1} more at or below ${t.warn.toFixed(2)}${extra})` : first.text;
      const d = await notifier.send(body);
      out.push({ channel: "discord", at: d.timestamp, id: d.id });
      log(`discord: delivered message ${d.id} at ${d.timestamp}`);
    }
    return out;
  }

  const scenarioNote = shock > 0 ? ` (scenario: collateral price −${pct(shock, 1)} applied to the health column and the alerts)` : "";

  if (cmd === "position") {
    const { head, timestamp } = await header();
    const id = only!;
    const user = getAddress(values.user!);
    const snap = await snapshotMarket(call, id, timestamp);
    const p = evaluate(user, await readPosition(call, id, user), snap);
    const row: Row = { snap, p, level: levelOf(p.hfNumber, t) };
    log(`block ${head} · Morpho ${marketLabel(snap)} ${id} · LLTV ${pct(Number(snap.params.lltv) / 1e18)} · ${snap.accrued ? "interest accrued to the head block" : "interest NOT accrued (IRM unreadable)"}`);
    if (p.debt === 0n) {
      log(`${user} has no debt in this market (collateral ${fmtToken(p.collateral, snap.collateral.decimals)} ${snap.collateral.symbol}): nothing to liquidate`);
    } else {
      log(tableText([row], 1, shock));
      const lvl = shock > 0 ? levelOf(shockedHf(row, shock), t) : row.level;
      if (lvl !== "ok") await deliver([buildAlert(lvl, snap, shock > 0 ? { ...p, hfNumber: shockedHf(row, shock), dropToLiquidation: 1 - 1 / shockedHf(row, shock) } : p, t, new Date(), shock)]);
      else log(`ok: health ${p.hfNumber.toFixed(4)} is above the warn threshold ${t.warn.toFixed(2)}`);
    }
    if (values.proof) {
      const file = join(HERE, "proof", `${values.proof}.json`);
      log(`proof: ${writeProof(file, { block: head.toString(), market: id, user, thresholds: t, position: { collateral: p.collateral.toString(), debt: p.debt.toString(), hf: p.hf?.toString() ?? null, level: row.level }, table: tableText([row], 1, shock) }, meta!)}`);
    }
    return 0;
  }

  // scan / watch: market-wide discovery first
  const { head, timestamp } = await header();
  const spb = await secondsPerBlock(call, head);
  const lookback = BigInt(Math.round((lookbackDays * 86_400) / spb));
  const from = head > lookback ? head - lookback : 0n;
  log(`block ${head} (${spb.toFixed(3)} s/block): looking for Morpho Blue borrowers in blocks ${from}…${head} (${lookbackDays} days)`);
  let lastPct = -1;
  const found = await discoverBorrowers(call, {
    from, to: head, cacheFile: values.index, signal,
    onProgress: (done, total) => {
      const p = Math.floor((Number(done) / Number(total)) * 10) * 10;
      if (p !== lastPct) log(`  discovery ${p}% (${done} of ${total} blocks)`), (lastPct = p);
    },
  });
  const counts = Object.entries(found.index.markets).map(([id, u]) => `${id.slice(0, 10)}…: ${u.length}`);
  log(`discovery: ${found.scannedBlocks} new blocks scanned${found.reused ? " (earlier ranges reused from the index)" : ""}; borrowers ever seen per market: ${counts.join(", ") || "none"}`);

  const one = async (): Promise<{ rows: Row[]; alerts: Alert[]; delivered: { channel: string; at: string; id?: string }[] }> => {
    const h = await header();
    const rows = sortRows(await readAll(found.index.markets, h.timestamp));
    log(`block ${h.head}: ${rows.length} open positions across ${new Set(rows.map((r) => r.snap.id)).size} market(s)${scenarioNote}`);
    log(tableText(rows, top, shock));
    const alerts: Alert[] = [];
    for (const r of rows) {
      const hf = shock > 0 ? shockedHf(r, shock) : r.p.hfNumber;
      const lvl = levelOf(hf, t);
      if (lvl === "ok") continue;
      const p = shock > 0 ? { ...r.p, hfNumber: hf, dropToLiquidation: hf <= 1 ? 0 : 1 - 1 / hf } : r.p;
      alerts.push(buildAlert(lvl, r.snap, p, t, new Date(), shock));
      if (alerts.length >= 20) break;
    }
    if (!alerts.length) log(`no position at or below the warn threshold ${t.warn.toFixed(2)} (closest: ${rows[0] ? rows[0].p.hfNumber.toFixed(4) : "n/a"}); no alert sent`);
    return { rows, alerts, delivered: await deliver(alerts) };
  };

  if (cmd === "scan") {
    const res = await one();
    if (values.proof) {
      const file = join(HERE, "proof", `${values.proof}.json`);
      const body = {
        block: head.toString(), lookbackDays, discovery: { from: from.toString(), to: head.toString(), scannedBlocks: found.scannedBlocks.toString(), borrowersPerMarket: Object.fromEntries(Object.entries(found.index.markets).map(([id, u]) => [id, u.length])) },
        thresholds: t, shock, openPositions: res.rows.length,
        markets: [...new Map(res.rows.map((r) => [r.snap.id, r.snap])).values()].map((s) => ({ id: s.id, label: marketLabel(s), lltv: s.params.lltv.toString(), oraclePrice: s.price.toString(), interestAccrued: s.accrued })),
        positions: res.rows.slice(0, 50).map((r) => ({ market: r.snap.id, user: r.p.user, hf: r.p.hf?.toString() ?? null, hfNumber: r.p.hfNumber, dropToLiquidation: r.p.dropToLiquidation, debt: r.p.debt.toString(), collateral: r.p.collateral.toString(), level: r.level })),
        table: tableText(res.rows, top, shock), alerts: res.alerts.map((a) => a.text), delivered: res.delivered,
      };
      log(`proof: ${writeProof(file, body, meta!)}`);
    }
    return 0;
  }

  // watch: poll the known borrowers; alert only when a position's level changes (worsening at once, clearing with hysteresis)
  const levelFile = values.levels!;
  const state = loadLevels(levelFile);
  for (let i = 0; i < maxPolls; i++) {
    if (i > 0) await wait(intervalS * 1000, signal);
    log(`--- poll ${i + 1} of ${maxPolls} ---`);
    const h = await header();
    const rows = sortRows(await readAll(found.index.markets, h.timestamp));
    const alerts: Alert[] = [];
    for (const r of rows) {
      const key = `${r.snap.id}:${r.p.user}`;
      const hf = shock > 0 ? shockedHf(r, shock) : r.p.hfNumber;
      const prev = state.levels[key] ?? "ok";
      const next = nextLevel(prev, hf, t);
      state.levels[key] = next;
      if (next !== prev && severity(next) > severity(prev) && next !== "ok") alerts.push(buildAlert(next as Exclude<Level, "ok">, r.snap, { ...r.p, hfNumber: hf, dropToLiquidation: hf <= 1 ? 0 : 1 - 1 / hf }, t, new Date(), shock));
      else if (next !== prev) log(`[${new Date().toISOString()}] ${next === "ok" ? "CLEARED" : "EASED to " + next} Morpho ${marketLabel(r.snap)} ${short(r.p.user)}: health factor ${hf.toFixed(4)}`);
    }
    writeJsonAtomic(levelFile, state);
    log(`block ${h.head}: ${rows.length} open positions, closest ${rows[0] ? rows[0].p.hfNumber.toFixed(4) : "n/a"}, ${alerts.length} new alert(s)`);
    await deliver(alerts);
  }
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
