// The live demo behind pharos.edycu.dev/doc-grounded-builder-agent (api/doc-grounded-builder-agent.ts). One "how do I…"
// request per run through the CLI's own handle(): plan from the hosted Docs MCP (sources cited) → execute → verify on chain.
// Never signs: execute is always off, so a send ends PREPARED (the unsigned transaction), exactly as the CLI does without
// --execute; the signed send is on the page as a recorded run. Mainnet reads use the hosted Chain MCP; Atlantic reads use the
// public Atlantic RPC through a read-only adapter (the Atlantic Chain MCP runs over stdio and cannot run on Vercel).
//   GET ?action=info
//   GET ?action=run&preset=balance|send|supply|receipt|bridge
//   GET ?action=run&request=<text ≤160>[&address=0x…][&to=0x…][&amount=PHRS][&token=0x…][&tx=0x<64 hex>]
import { getAddress, isAddress, type Hex } from "viem";
import { atlanticCall, atlanticReadOnly, ATLANTIC_RPC } from "../../src/lib/atlantic-call.js";
import { busy, deployInfo, gate, InputError, json, ndjson, type Emit } from "../../src/lib/demo-stream.js";
import { docsMcp, DOCS_MCP_URL, type DocsClient } from "../../src/lib/docs-mcp.js";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { TOKENS } from "../../src/lib/networks.js";
import { classify, handle as handleRequest, type Deps, type Network, type Params } from "./agent.js";
import { DEMO } from "./index.js";

/** The CLI's keyless defaults (index.ts): the author's public Atlantic address as "my", the burn address as recipient, a known Atlantic tx. */
export const DEFAULT_ADDRESS = getAddress("0x317bca01Bb101C0F1E86C21576a4e14D92B02975");
export const DEFAULT_TO = getAddress("0x000000000000000000000000000000000000dEaD");
export const DEFAULT_TX = "0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88" as Hex;

export const PRESETS = { balance: DEMO[0]!, send: DEMO[1]!, supply: DEMO[2]!, receipt: DEMO[3]!, bridge: DEMO[4]! } as const;
export type Preset = keyof typeof PRESETS;
export const STEP_IDS = ["classify", "ask", "ground", "execute", "verify", "result"] as const;

export interface Job {
  request: string;
  params: Params;
  preset?: Preset;
}

export function jobFor(q: URLSearchParams): Job {
  const preset = q.get("preset");
  let request: string;
  if (preset !== null) {
    if (!(preset in PRESETS)) throw new InputError(`unknown preset: use ${Object.keys(PRESETS).join(", ")}`);
    request = PRESETS[preset as Preset];
  } else {
    request = (q.get("request") ?? "").replace(/\s+/g, " ").trim();
    if (request.length < 4 || request.length > 160) throw new InputError("request must be 4–160 characters, e.g. “how do I check my PHRS balance?”");
  }
  const a = (name: string): Hex | undefined => {
    const v = q.get(name);
    if (v === null || v === "") return undefined;
    if (!isAddress(v)) throw new InputError(`${name} must be a 0x address`);
    return getAddress(v);
  };
  const amount = q.get("amount") || "0.001";
  if (!/^\d{1,7}(\.\d{1,18})?$/.test(amount)) throw new InputError("amount must be PHRS as a decimal number, e.g. 0.001");
  const tx = q.get("tx") || DEFAULT_TX;
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new InputError("tx must be 0x followed by 64 hex characters");
  const params: Params = {
    address: a("address") ?? DEFAULT_ADDRESS,
    to: a("to") ?? DEFAULT_TO,
    amount,
    token: a("token") ?? getAddress(TOKENS.pharos.WPROS.address),
    txHash: tx as Hex,
    execute: false, // never: the page prepares, the CLI signs
  };
  return { request, params, ...(preset !== null ? { preset: preset as Preset } : {}) };
}

type Docs = Pick<DocsClient, "callTool" | "listTools">;
type ChainHandle = Awaited<ReturnType<Deps["chain"]>>;
export interface Conns {
  docs: () => Promise<Docs & { close(): Promise<void> }>;
  mainnet: () => Promise<ChainHandle & { close(): Promise<void> }>;
  atlantic: (onCall: () => void) => ChainHandle;
}
const realConns: Conns = {
  docs: () => docsMcp(),
  mainnet: () => chainMcp("pharos"),
  atlantic: (onCall) => atlanticReadOnly(atlanticCall({ maxCalls: 30, onCall })),
};

export async function runDemo(emit: Emit, job: Job, conns: Conns = realConns): Promise<void> {
  const t0 = Date.now();
  const kind = classify(job.request);
  const net = kind === "other" ? null : ({ balance: "atlantic", send: "atlantic", supply: "pharos", receipt: "atlantic" } as const)[kind];
  emit({ type: "start", request: job.request, kind, network: net, preset: job.preset ?? null, docsMcp: DOCS_MCP_URL, atlanticRpc: ATLANTIC_RPC, chainMcp: "https://mcp.pharos.xyz/mcp" });
  emit({ type: "step", id: "classify", state: kind === "other" ? "refused" : "ok", label: kind === "other" ? "no executor: docs only" : `${kind} · ${net}`, ms: 0 });

  const rawDocs = await conns.docs();
  const closers: (() => Promise<void>)[] = [() => rawDocs.close()];
  const docCalls: string[] = [];
  let askDone = 0;
  let chainAt = 0;
  let chainCalls = 0;
  const docs: Docs = {
    listTools: rawDocs.listTools.bind(rawDocs),
    callTool: (async (p: { name: string }, ...rest: unknown[]) => {
      const s = Date.now();
      const r = await (rawDocs.callTool as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      docCalls.push(p.name);
      if (p.name === "askQuestion") {
        askDone = Date.now();
        emit({ type: "step", id: "ask", state: "ok", label: "answer + sources", ms: Date.now() - s });
      }
      return r;
    }) as Docs["callTool"],
  };
  const groundLamp = (covered: boolean, label: string) => emit({ type: "step", id: "ground", state: covered ? "ok" : "refused", label, ms: (chainAt || Date.now()) - (askDone || t0) });
  const deps: Deps = {
    docs,
    defaultFrom: DEFAULT_ADDRESS,
    async chain(network: Network, broadcast = false) {
      if (broadcast) throw new Error("the demo page never opens a broadcasting client");
      if (!chainAt) {
        chainAt = Date.now();
        groundLamp(true, "a page names the method");
      }
      if (network === "atlantic") return conns.atlantic(() => chainCalls++);
      const m = await conns.mainnet();
      closers.push(() => m.close());
      const inner = m.call as ChainMcp["call"];
      return { ...m, call: (async (tool: string, args?: Record<string, unknown>) => (chainCalls++, inner(tool as never, args))) as ChainMcp["call"] };
    },
  };
  try {
    const o = await handleRequest(job.request, job.params, deps);
    const p = o.plan;
    if (!askDone) emit({ type: "step", id: "ask", state: "failed", label: "no docs answer", ms: Date.now() - t0 });
    if (!chainAt) groundLamp(p.covered, p.covered ? "described (no executor)" : p.refused ? "NOT COVERED: docs refuse" : "NOT COVERED: no page names it");
    const ran = o.status !== "not-covered" && o.status !== "no-executor";
    emit(ran ? { type: "step", id: "execute", state: "ok", label: `${chainCalls} chain reads${o.unsigned ? " · tx prepared" : ""}`, ms: Date.now() - chainAt } : { type: "step", id: "execute", state: "skip", label: "nothing executed", ms: 0 });
    const okN = o.checks.filter((c) => c.ok).length;
    emit(ran ? { type: "step", id: "verify", state: okN === o.checks.length ? "ok" : "failed", label: `${okN} of ${o.checks.length} checks ok`, ms: 0 } : { type: "step", id: "verify", state: "skip", label: "nothing to verify", ms: 0 });
    const resLabel = { success: "SUCCESS", failure: "FAILED", prepared: "PREPARED (not signed)", "not-covered": "THE DOCS DON'T COVER THIS", "no-executor": "NOT EXECUTED" }[o.status];
    emit({ type: "step", id: "result", state: o.status === "success" || o.status === "prepared" ? "ok" : o.status === "failure" ? "failed" : "refused", label: resLabel, ms: 0 });
    emit({ type: "done", outcome: o, docCalls, chainReads: chainCalls, totalMs: Date.now() - t0, summary: `${resLabel}. ${o.note ?? (o.status === "prepared" ? "The unsigned transaction is shown for signature; this page never signs (the CLI does with --execute on Atlantic)." : `Expected: ${o.expected}`)}` });
  } finally {
    await Promise.allSettled(closers.map((c) => c()));
  }
}

const runGate = gate(3_000);

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "info";
  if (action === "info") return json(200, { deploy: deployInfo(), presets: PRESETS, defaults: { address: DEFAULT_ADDRESS, to: DEFAULT_TO, tx: DEFAULT_TX }, docsMcp: DOCS_MCP_URL, atlanticRpc: ATLANTIC_RPC });
  if (action !== "run") return json(400, { error: `unknown action ${JSON.stringify(action).slice(0, 40)}: use info or run` });
  let job: Job;
  try {
    job = jobFor(url.searchParams);
  } catch (e) {
    if (e instanceof InputError) return json(400, { error: e.message });
    throw e;
  }
  const wait = runGate.take();
  if (wait) return busy(wait);
  return ndjson((emit) => runDemo(emit, job), () => runGate.release());
}
