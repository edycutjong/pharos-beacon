// Live demo for the On-Chain Alert Bot (web/on-chain-alert-bot, api/on-chain-alert-bot.ts). Read-only.
//   GET /api/on-chain-alert-bot?action=health
//   GET /api/on-chain-alert-bot?action=run&scenario=mainnet|atlantic-proof|custom[&rules=<json>&blocks=N]     NDJSON
//   GET /api/on-chain-alert-bot?action=blocktimes        the two alert blocks' timestamps, read from Atlantic now
// A run is the bot's own pieces (compileRules, match, alertText, the src/watch poller and a sent-set): scan, alert, then
// scan the same blocks again with the cursor lost and the sent-set kept, and count the repeats (must be 0).
// Live alerts are delivered to the page. Discord delivery is a recorded run: a public button that posts to a real
// channel would let any visitor spam it.
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { busyResponse, concurrency, deployInfo, InputError, json, ndjson, openReader, pickInt, pinHead, rpcCall, type CallRecord, type Emit, type Reader } from "../../src/web/demo.js";
import { type Network } from "../../src/lib/mcp.js";
import type { Notifier } from "../../src/watch/discord.js";
import { tokenInfo } from "../../src/watch/token.js";
import { pollOnce } from "../../src/watch/watch.js";
import { parseFrom } from "../event-log-monitor/index.js";
import { alertText, compileRules, match, type RuleSpec } from "./rules.js";

/** The committed rules files, verbatim (a test checks they match rules.pharos.json and rules.atlantic.json). */
export const RULES_PHAROS = { network: "pharos", rules: [{ id: "usdc-over-100", kind: "large-transfer", token: "0xc879c018db60520f4355c26ed1a6d572cdac1815", minAmount: "100" }] } as const; // gitleaks:allow (public token contract address)
export const RULES_ATLANTIC = {
  network: "atlantic",
  rules: [
    { id: "big-wphrs-transfer", kind: "large-transfer", token: "0x838800b758277CC111B2d48Ab01e5E164f8E9471", minAmount: "0.005" }, // gitleaks:allow (public token contract address)
    { id: "wphrs-deposit", kind: "contract-event", contract: "0x838800b758277CC111B2d48Ab01e5E164f8E9471", event: "Deposit" },
  ],
} as const;

/** The two blocks whose alerts were delivered to Discord in the recorded live run. */
export const ALERT_BLOCKS = [31555669, 31555672] as const;

export interface RunSpec {
  file: { network: Network; rules: RuleSpec[] };
  blocks?: number;
  /** Replay a fixed window (the recorded Atlantic run): start block and pinned head. */
  from?: bigint;
  pin?: bigint;
}

export const MAX_RULES = 5;
export const MAX_RULES_CHARS = 2000;

/** Read and check the query string. Rules are checked shape-first here, then fully by compileRules once decimals are known. */
export function parseRun(url: URL): RunSpec {
  const scenario = url.searchParams.get("scenario") ?? "mainnet";
  if (scenario === "mainnet") return { file: structuredClone(RULES_PHAROS) as unknown as RunSpec["file"], blocks: pickInt(url.searchParams.get("blocks"), "blocks", 1, 1000, 300) };
  // The recorded run: started at head 31555664, alerts in blocks 31555669 and 31555672, a 0.0001 transfer (block 31555676) below the threshold.
  if (scenario === "atlantic-proof") return { file: structuredClone(RULES_ATLANTIC) as unknown as RunSpec["file"], from: 31555660n, pin: 31555690n };
  if (scenario !== "custom") throw new InputError("scenario must be mainnet, atlantic-proof or custom");
  const raw = url.searchParams.get("rules") ?? "";
  if (!raw.trim()) throw new InputError("custom needs a rules JSON");
  if (raw.length > MAX_RULES_CHARS) throw new InputError(`the rules JSON is limited to ${MAX_RULES_CHARS} characters`);
  let file: unknown;
  try {
    file = JSON.parse(raw);
  } catch (e) {
    throw new InputError(`the rules are not valid JSON: ${(e as Error).message.split("\n")[0]}`);
  }
  const f = file as { network?: unknown; rules?: unknown };
  if (!f || typeof f !== "object" || (f.network !== "pharos" && f.network !== "atlantic")) throw new InputError('rules file: "network" must be "atlantic" or "pharos"');
  if (!Array.isArray(f.rules) || f.rules.length === 0) throw new InputError('rules file: needs a "rules" array with at least one rule');
  if (f.rules.length > MAX_RULES) throw new InputError(`at most ${MAX_RULES} rules on the demo page`);
  return { file: f as RunSpec["file"], blocks: pickInt(url.searchParams.get("blocks"), "blocks", 1, 1000, 300) };
}

export interface PageAlert {
  rule: string;
  key: string;
  tx: Hex;
  block: string;
  text: string;
  at: string;
  explorer: string;
}

/** Delivery for the demo: the alert goes to the page (the CLI's console notifier does the same in a terminal). */
export function pageNotifier(emit: Emit): Notifier {
  return {
    name: "this page",
    async send(text) {
      const timestamp = new Date().toISOString();
      emit({ type: "delivered", at: timestamp });
      return { timestamp, content: text };
    },
  };
}

export async function run(spec: RunSpec, emit: Emit, open: (n: Network, onCall: (r: CallRecord) => void) => Promise<Reader> = (n, c) => openReader(n, c)): Promise<void> {
  const calls: CallRecord[] = [];
  const onCall = (r: CallRecord) => {
    calls.push(r);
    emit({ type: "call", ...r });
  };
  const network = spec.file.network;
  emit({ type: "start", network, rules: spec.file.rules });
  let t = performance.now();
  const since = () => Math.round(performance.now() - t);
  const reader = await open(network, onCall).catch((e) => {
    emit({ type: "step", id: "connect", state: "failed", label: "no connection", ms: since() });
    throw e;
  });
  const dir = join(tmpdir(), "beacon-web");
  const cursor1 = join(dir, `bot-${randomUUID()}.cursor.json`);
  const cursor2 = join(dir, `bot-${randomUUID()}.cursor.json`);
  try {
    emit({ type: "step", id: "connect", state: "ok", label: `chain ${reader.chainId}`, ms: since(), detail: { endpoint: reader.endpoint, via: reader.via } });
    const call = spec.pin !== undefined ? pinHead(reader.call, spec.pin) : reader.call;

    // Rules: the tokens named by large-transfer rules give the decimals that turn "100" into base units (same as the CLI).
    t = performance.now();
    const tokens = new Map<string, { decimals: number; symbol: string }>();
    for (const r of spec.file.rules) {
      if (r?.kind === "large-transfer" && typeof r.token === "string" && /^0x[0-9a-fA-F]{40}$/.test(r.token)) {
        const info = await tokenInfo(call, r.token as Hex);
        if (info) tokens.set(r.token.toLowerCase(), info);
      }
    }
    let compiled;
    try {
      compiled = compileRules(spec.file, (a) => tokens.get(a.toLowerCase())?.decimals);
    } catch (e) {
      emit({ type: "step", id: "rules", state: "failed", label: "rules refused", ms: since() });
      throw e;
    }
    const rules = compiled.rules;
    const infoOf = new Map<string, { decimals: number; symbol: string } | undefined>();
    for (const r of rules) if (!infoOf.has(r.address.toLowerCase())) infoOf.set(r.address.toLowerCase(), tokens.get(r.address.toLowerCase()) ?? (r.kind === "contract-event" ? await tokenInfo(call, r.address) : undefined));
    const head = BigInt((await call("get_block_number")).blockNumber);
    const ruleView = rules.map((r) => ({ id: r.id, kind: r.kind, address: r.address, event: r.spec.signature, min: r.minText ?? null, symbol: infoOf.get(r.address.toLowerCase())?.symbol ?? null }));
    emit({ type: "step", id: "rules", state: "ok", label: `${rules.length} rule${rules.length === 1 ? "" : "s"}`, ms: since(), detail: { rules: ruleView, head: head.toString() } });

    const from = spec.from ?? (parseFrom(`head-${spec.blocks ?? 300}`, head) as bigint);
    const filter = { address: [...new Set(rules.map((x) => x.address))], topics: [[...new Set(rules.map((x) => x.spec.topic0))]] as (Hex | Hex[] | null)[] };
    const sent: Record<string, { at: string; tx: string }> = {};
    const notifier = pageNotifier(emit);
    const alerts: PageAlert[] = [];
    let logs = 0;
    let skipped = 0;
    let deliverMs = 0;
    const onLog = (pass: 1 | 2) => async (log: Parameters<Parameters<typeof pollOnce>[0]["onLog"]>[0]) => {
      logs++;
      for (const a of match(rules, log)) {
        if (sent[a.key]) {
          skipped++;
          emit({ type: "skipped", pass, key: a.key, rule: a.rule.id, tx: a.event.tx });
          continue; // already alerted for this rule and event: no repeat
        }
        const info = infoOf.get(a.rule.address.toLowerCase());
        const text = alertText(a, network, info?.decimals, info?.symbol);
        const t0 = performance.now();
        const d = await notifier.send(text);
        deliverMs += performance.now() - t0;
        sent[a.key] = { at: d.timestamp, tx: a.event.tx };
        const alert: PageAlert = { rule: a.rule.id, key: a.key, tx: a.event.tx, block: a.event.block.toString(), text, at: d.timestamp, explorer: `${network === "pharos" ? "https://www.pharosscan.xyz" : "https://atlantic.pharosscan.xyz"}/tx/${a.event.tx}` };
        alerts.push(alert);
        emit({ type: "alert", pass, ...alert });
      }
    };

    // Pass 1: scan from `from` to the head; every match is an alert.
    t = performance.now();
    const p1 = await pollOnce({ call, ...filter, stateFile: cursor1, from, onLog: onLog(1) });
    const firstAlerts = alerts.length;
    emit({ type: "step", id: "scan", state: "ok", label: `${logs} log${logs === 1 ? "" : "s"} · ${firstAlerts} match`, ms: since(), detail: { from: from.toString(), to: p1.scannedTo?.toString() ?? null } });
    emit({ type: "step", id: "deliver", state: firstAlerts ? "ok" : "skip", label: firstAlerts ? `${firstAlerts} to this page` : "no alert in range", ms: Math.round(deliverMs) });

    // Pass 2: the cursor is lost (a new cursor file), the same blocks come back, the sent-set is kept.
    t = performance.now();
    const logs1 = logs;
    const p2 = await pollOnce({ call, ...filter, stateFile: cursor2, from, onLog: onLog(2) });
    const repeated = alerts.filter((a, i) => alerts.findIndex((b) => b.key === a.key) !== i).length;
    const fresh = alerts.length - firstAlerts;
    emit({ type: "step", id: "rescan", state: repeated ? "failed" : "ok", label: `${skipped} held back · ${repeated} repeated`, ms: since(), detail: { to: p2.scannedTo?.toString() ?? null, logs: logs - logs1, fresh } });

    emit({
      type: "done",
      network,
      endpoint: reader.endpoint,
      via: reader.via,
      chainId: reader.chainId,
      rules: ruleView,
      head: head.toString(),
      pinned: spec.pin?.toString() ?? null,
      range: { from: from.toString(), to: (p2.scannedTo ?? p1.scannedTo ?? from).toString() },
      logs: logs1,
      alerts: firstAlerts,
      newOnRescan: fresh,
      heldBack: skipped,
      repeated,
      sent,
      calls: calls.length,
    });
  } finally {
    for (const f of [cursor1, cursor2]) rmSync(f, { force: true });
    await reader.close().catch(() => {});
  }
}

/** The timestamps of the recorded alerts' blocks, read from Atlantic now (to set against Discord's message times). */
export async function blockTimes(call = rpcCall()): Promise<{ block: number; hash: string; timestampUnix: number; timestampUtc: string }[]> {
  return Promise.all(
    ALERT_BLOCKS.map(async (n) => {
      const b = (await call("get_block", { block: n })) as { hash: string; timestamp: string } | null;
      if (!b) throw new Error(`Atlantic has no block ${n}`);
      const ts = Number(BigInt(b.timestamp));
      return { block: n, hash: b.hash, timestampUnix: ts, timestampUtc: new Date(ts * 1000).toISOString() };
    }),
  );
}

const gate = concurrency(4);
let timesCache: { at: number; body: unknown } | undefined;

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "health";
  try {
    if (req.method !== "GET") return json({ error: "use GET" }, 405);
    if (action === "health") return json({ status: "ok", task: "on-chain-alert-bot", rules: { pharos: RULES_PHAROS, atlantic: RULES_ATLANTIC }, limits: { rules: MAX_RULES, blocks: 1000 }, deploy: deployInfo() });
    if (action === "blocktimes") {
      if (!timesCache || Date.now() - timesCache.at > 600_000) timesCache = { at: Date.now(), body: { source: "Atlantic eth_getBlockByNumber, read now", blocks: await blockTimes() } };
      return json(timesCache.body);
    }
    if (action === "run") {
      const spec = parseRun(url);
      if (!gate.take()) return busyResponse("alert-bot run");
      return ndjson((emit) => run(spec, emit), () => gate.release());
    }
    return json({ error: `unknown action ${JSON.stringify(action)}; use health, run or blocktimes` }, 404);
  } catch (e) {
    if (e instanceof InputError) return json({ error: e.message }, 400);
    return json({ error: (e as Error).message }, 500);
  }
}
