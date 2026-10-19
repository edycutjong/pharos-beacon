// Live demo for the Docs MCP Onboarding log (web/docs-mcp-onboarding, api/docs-mcp-onboarding.ts). Read-only, keyless.
//   GET /api/docs-mcp-onboarding?action=health
//   GET /api/docs-mcp-onboarding?action=recheck        NDJSON: re-asks the exact query behind each of the 5 gaps, today
//   GET /api/docs-mcp-onboarding?action=first-read     NDJSON: repeats the log's end state (hosted Chain MCP read of WPROS,
//                                                       and the first Atlantic transaction's receipt)
// The log itself is frozen evidence (ONBOARDING.md + proof/transcript.jsonl). This page asks: are the gaps still there?
// Each query goes through the recorder's own record() so a live answer has the same shape as a transcript line.
import { getAddress, type Hex } from "viem";
import { busyResponse, concurrency, deployInfo, json, ndjson, openReader, publicMessage, type CallRecord, type Emit, type Reader } from "../../src/web/demo.js";
import { docsMcp, DOCS_MCP_URL, type DocsClient } from "../../src/lib/docs-mcp.js";
import type { Network } from "../../src/lib/mcp.js";
import { isGoodAnswer } from "../doc-search-cli/index.js";
import { readState } from "../read-contract-state/index.js";
import { record, type Entry } from "./ask.js";

/** WPROS on Pharos mainnet, as answered by the Docs MCP (transcript #10). */
export const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";
/** The first transaction of the log (step 8), on Atlantic. */
export const FIRST_TX = "0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88";

export type Verdict = "still a gap" | "answered now" | "unclear";

export interface Gap {
  gap: number;
  /** The transcript call the gap was found with. */
  n: number;
  title: string;
  /** Verbatim from proof/transcript.jsonl (a test checks it). */
  query: string;
  /** What would show the docs now answer it. */
  wants: string;
  check: (answer: string, sources: { title: string; url: string }[]) => Verdict;
}

/** The answer without its trailing "# Sources" list, with typographic apostrophes made plain. */
export function body(text: string): string {
  const cut = text.search(/^#{1,6}[ \t]*Sources[ \t]*$/im);
  return (cut >= 0 ? text.slice(0, cut) : text).replace(/[‘’]/g, "'").trim();
}

/** Sources of an askQuestion reply ("- [Title](https://…)" lines after "# Sources"). */
export function sourcesOf(text: string): { title: string; url: string }[] {
  const cut = text.search(/^#{1,6}[ \t]*Sources[ \t]*$/im);
  if (cut < 0) return [];
  return [...text.slice(cut).matchAll(/^\s*[-*]\s+\[(.+?)\]\((https:\/\/\S+?)\)\s*$/gm)].map((m) => ({ title: m[1]!, url: m[2]! }));
}

/** The reply says, somewhere, that the docs do not have it ("I can't confirm…", "the docs don't identify that domain"). */
export const DISCLAIMS = /\b(?:can't|cannot|could not|couldn't|unable to)\s+(?:find|confirm|locate)\b|\b(?:docs?|documentation|pages?)\s+(?:do|does)(?:n't| not)\s+(?:identify|document|mention|cover|describe|list|provide|specify)\b|\bno documentation\b/i;

export const GAPS: Gap[] = [
  {
    gap: 1, n: 1, title: "ai.pharos.xyz is not in the docs",
    query: "What is ai.pharos.xyz and how do I get started with it?",
    wants: "an answer about ai.pharos.xyz itself, passing the Doc-Search CLI's no-answer rule, that never says the docs lack it",
    check: (a, s) => (/ai\.pharos\.xyz/i.test(a) && isGoodAnswer(a, s) && !DISCLAIMS.test(a) ? "answered now" : "still a gap"),
  },
  {
    gap: 2, n: 3, title: "No faucet URL",
    query: "Where is the faucet for Atlantic testnet PHRS and how do I claim tokens?",
    wants: "a link whose address contains “faucet”",
    check: (a) => (/https?:\/\/[^\s)]*faucet/i.test(a) ? "answered now" : "still a gap"),
  },
  {
    gap: 3, n: 6, title: "No SkillEngine download",
    query: "Where do I download the Pharos Skill Engine package pharos-skill-engine-0.1.0.zip?",
    wants: "a link to a .zip or to a GitHub repository for the skill engine",
    check: (a) => (/https?:\/\/[^\s)]+\.zip\b|https?:\/\/github\.com\/[^\s)]*skill/i.test(a) ? "answered now" : "still a gap"),
  },
  {
    gap: 4, n: 7, title: "Atlantic config says PROS",
    query: "How do I point the Pharos MCP server at Atlantic testnet instead of mainnet?",
    wants: "PHAROS_NATIVE_SYMBOL set to PHRS (PROS is the wrong symbol on Atlantic)",
    check: (a) => {
      const m = /PHAROS_NATIVE_SYMBOL\W+([A-Z]+)/.exec(a);
      return !m ? "unclear" : m[1] === "PHRS" ? "answered now" : "still a gap";
    },
  },
  {
    gap: 5, n: 2, title: "Network page has no currency symbol",
    query: "How do I set up a wallet and add the Atlantic testnet network?",
    wants: "a currency symbol (PHRS) in the wallet settings it gives",
    check: (a) =>
      /(?:doesn't|does not|don't|do not)\s+(?:specify|list|give|include)\s+(?:a |the )?currency[- ]symbol/i.test(a)
        ? "still a gap"
        : /symbol[^.\n]{0,40}PHRS|PHRS[^.\n]{0,25}symbol/i.test(a)
          ? "answered now"
          : "unclear",
  },
];

export interface GapResult {
  gap: number;
  n: number;
  query: string;
  verdict: Verdict;
  wants: string;
  answer: string;
  sources: { title: string; url: string }[];
  ms: number;
  at: string;
  isError: boolean;
}

type Connect = () => Promise<DocsClient & { close(): Promise<void> }>;

/** Re-ask the 5 gap queries at once and judge each answer with its gap's check. */
export async function recheck(emit: Emit, connect: Connect = () => docsMcp(DOCS_MCP_URL, { retries: 1 })): Promise<void> {
  emit({ type: "start", endpoint: DOCS_MCP_URL, gaps: GAPS.map(({ gap, n, query, title, wants }) => ({ gap, n, query, title, wants })) });
  const t0 = performance.now();
  const client = await connect().catch((e) => {
    emit({ type: "step", id: "connect", state: "failed", label: "no connection", ms: Math.round(performance.now() - t0) });
    throw e;
  });
  try {
    emit({ type: "step", id: "connect", state: "ok", label: "Docs MCP", ms: Math.round(performance.now() - t0) });
    const results = await Promise.all(
      GAPS.map(async (g): Promise<GapResult> => {
        const t = performance.now();
        let entry: Entry;
        try {
          entry = await record(client, "ask", g.query, g.n);
        } catch (e) {
          const ms = Math.round(performance.now() - t);
          emit({ type: "step", id: `gap${g.gap}`, state: "failed", label: "askQuestion failed", ms });
          return { gap: g.gap, n: g.n, query: g.query, verdict: "unclear", wants: g.wants, answer: `askQuestion failed: ${publicMessage(e)}`, sources: [], ms, at: new Date().toISOString(), isError: true };
        }
        const ms = Math.round(performance.now() - t);
        const text = entry.content.join("\n").trim();
        const answer = body(text);
        const sources = sourcesOf(text);
        const verdict = entry.isError ? "unclear" : g.check(answer, sources);
        const r: GapResult = { gap: g.gap, n: g.n, query: g.query, verdict, wants: g.wants, answer, sources, ms, at: entry.at, isError: entry.isError };
        emit({ type: "gap", ...r });
        emit({ type: "step", id: `gap${g.gap}`, state: verdict === "still a gap" ? "refused" : verdict === "answered now" ? "ok" : "skip", label: verdict, ms });
        return r;
      }),
    );
    emit({ type: "done", action: "recheck", endpoint: DOCS_MCP_URL, results, stillGaps: results.filter((r) => r.verdict === "still a gap").length, answered: results.filter((r) => r.verdict === "answered now").length });
  } finally {
    await client.close().catch(() => {});
  }
}

/** The log's end state, repeated now: a mainnet read through the hosted Chain MCP, and the first Atlantic tx's receipt. */
export async function firstRead(emit: Emit, open: (n: Network, onCall: (r: CallRecord) => void) => Promise<Reader> = (n, c) => openReader(n, c)): Promise<void> {
  const calls: CallRecord[] = [];
  const onCall = (r: CallRecord) => {
    calls.push(r);
    emit({ type: "call", ...r });
  };
  emit({ type: "start", wpros: WPROS, firstTx: FIRST_TX });
  let t = performance.now();
  const since = () => Math.round(performance.now() - t);
  const main = await open("pharos", onCall).catch((e) => {
    emit({ type: "step", id: "connect", state: "failed", label: "no connection", ms: since() });
    throw e;
  });
  try {
    emit({ type: "step", id: "connect", state: "ok", label: `chain ${main.chainId}`, ms: since(), detail: { endpoint: main.endpoint } });
    t = performance.now();
    const head = BigInt((await main.call("get_block_number")).blockNumber);
    const state = await readState(main.call, getAddress(WPROS), head, []);
    emit({ type: "step", id: "wpros", state: "ok", label: `${state.symbol} · ${state.decimals} dec`, ms: since(), detail: { head: head.toString() } });

    t = performance.now();
    const atl = await open("atlantic", onCall);
    const receipt = (await atl.call("get_transaction_receipt", { hash: FIRST_TX })) as { status: Hex; blockNumber: Hex; gasUsed: Hex; from: Hex; to: Hex } | null;
    const ok = receipt?.status === "0x1";
    emit({ type: "step", id: "receipt", state: ok ? "ok" : "failed", label: receipt ? (ok ? "status 1" : `status ${receipt.status}`) : "not found", ms: since() });
    emit({
      type: "done",
      action: "first-read",
      mainnet: { endpoint: main.endpoint, via: main.via, head: head.toString(), state },
      atlantic: { endpoint: atl.endpoint, via: atl.via, tx: FIRST_TX, receipt: receipt ? { status: receipt.status, block: BigInt(receipt.blockNumber).toString(), gasUsed: BigInt(receipt.gasUsed).toString(), from: receipt.from, to: receipt.to } : null },
      calls: calls.length,
    });
  } finally {
    await main.close().catch(() => {});
  }
}

// Five askQuestion calls at once is the heaviest thing any page does: one re-check per server instance at a time.
const recheckGate = concurrency(1);
const readGate = concurrency(4);

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "health";
  try {
    if (req.method !== "GET") return json({ error: "use GET" }, 405);
    if (action === "health") return json({ status: "ok", task: "docs-mcp-onboarding", endpoint: DOCS_MCP_URL, gaps: GAPS.map(({ gap, n, query, title, wants }) => ({ gap, n, query, title, wants })), deploy: deployInfo() });
    if (action === "recheck") {
      if (!recheckGate.take()) return busyResponse("gap re-check");
      return ndjson((emit) => recheck(emit), () => recheckGate.release());
    }
    if (action === "first-read") {
      if (!readGate.take()) return busyResponse("first read");
      return ndjson((emit) => firstRead(emit), () => readGate.release());
    }
    return json({ error: `unknown action ${JSON.stringify(action)}; use health, recheck or first-read` }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}
