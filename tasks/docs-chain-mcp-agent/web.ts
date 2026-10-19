// The live demo behind pharos.edycu.dev/docs-chain-mcp-agent (api/docs-chain-mcp-agent.ts). One function per run, the
// CLI's own three steps (explain → readOnChain → interpret) on Pharos mainnet: the hosted Docs MCP explains, the hosted
// Chain MCP (keyless, read-only) calls. Each MCP tool call is timed and streamed so the page lights a lamp per step.
//   GET ?action=info
//   GET ?action=run&preset=usdc-decimals|usdc-balanceof|wpros-decimals|wpros-totalsupply|multicall-getchainid
//   GET ?action=run&contract=0x…&function=name|symbol|decimals|totalSupply|balanceOf|getChainId[&arg=0x<holder>]
import { getAddress, isAddress, type Hex } from "viem";
import { busy, deployInfo, gate, InputError, json, ndjson, type Emit } from "../../src/lib/demo-stream.js";
import { docsMcp, DOCS_MCP_URL, getDocPage, type DocsClient } from "../../src/lib/docs-mcp.js";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { TOKENS } from "../../src/lib/networks.js";
import { largestTransferRecipient } from "../read-contract-state/index.js";
import { explain, FUNCTIONS, interpret, readOnChain, type Fn, type Target } from "./index.js";

const REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";
const USDC = getAddress(TOKENS.pharos.USDC.address);
const WPROS = getAddress(TOKENS.pharos.WPROS.address);
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
const LABELS: Record<string, string> = {
  [USDC.toLowerCase()]: "USDC (Circle-deployed)",
  [WPROS.toLowerCase()]: "WPROS (Wrapped PROS)",
  [TOKENS.pharos.LINK.address.toLowerCase()]: "LINK",
  [TOKENS.pharos.WETH.address.toLowerCase()]: "WETH",
  [MULTICALL3.toLowerCase()]: "Multicall3 (canonical contract)",
};

export const PRESETS = {
  "usdc-decimals": { contract: USDC, fn: "decimals", label: "USDC · decimals()" },
  "usdc-balanceof": { contract: USDC, fn: "balanceOf", label: "USDC · balanceOf(a live holder)" },
  "wpros-decimals": { contract: WPROS, fn: "decimals", label: "WPROS · decimals()" },
  "wpros-totalsupply": { contract: WPROS, fn: "totalSupply", label: "WPROS · totalSupply()" },
  "multicall-getchainid": { contract: MULTICALL3, fn: "getChainId", label: "Multicall3 · getChainId()" },
} as const satisfies Record<string, { contract: Hex; fn: Fn; label: string }>;
export type Preset = keyof typeof PRESETS;
export const STEP_IDS = ["head", "ask", "ground", "call", "read"] as const;

export interface Job {
  contract: Hex;
  fn: Fn;
  holder?: Hex;
  /** balanceOf with no holder given: pick the recipient of the largest recent USDC transfer (as the CLI demo does). */
  findHolder: boolean;
  preset?: Preset;
}

/** The job from the query string; InputError on anything malformed. */
export function jobFor(q: URLSearchParams): Job {
  const preset = q.get("preset");
  if (preset !== null) {
    if (!(preset in PRESETS)) throw new InputError(`unknown preset: use ${Object.keys(PRESETS).join(", ")}`);
    const p = PRESETS[preset as Preset];
    return { contract: p.contract, fn: p.fn, findHolder: p.fn === "balanceOf", preset: preset as Preset };
  }
  const contract = q.get("contract");
  if (!contract || !isAddress(contract)) throw new InputError("contract must be a 0x address (or pass a preset)");
  const fn = q.get("function") ?? "";
  if (!(FUNCTIONS as readonly string[]).includes(fn)) throw new InputError(`function must be one of ${FUNCTIONS.join(", ")}`);
  const arg = q.get("arg");
  if (fn === "balanceOf") {
    if (!arg || !isAddress(arg)) throw new InputError("balanceOf needs arg=0x<holder address>");
    return { contract: getAddress(contract), fn: fn as Fn, holder: getAddress(arg), findHolder: false };
  }
  if (arg) throw new InputError("arg is only for balanceOf");
  return { contract: getAddress(contract), fn: fn as Fn, findHolder: false };
}

type Docs = Pick<DocsClient, "callTool" | "listTools">;
type Chain = Pick<ChainMcp, "call" | "close" | "endpoint">;

export interface Deps {
  chain: () => Promise<Chain>;
  docs: () => Promise<Docs & { close(): Promise<void> }>;
}
const realDeps: Deps = { chain: () => chainMcp("pharos"), docs: () => docsMcp() };

/** Wrap the docs client so every askQuestion / getPage is timed and reported. */
function watchDocs(docs: Docs, on: (tool: string, ms: number, args: Record<string, unknown>) => void): Docs {
  return {
    listTools: docs.listTools.bind(docs),
    callTool: (async (params: { name: string; arguments?: Record<string, unknown> }, ...rest: unknown[]) => {
      const t0 = Date.now();
      const r = await (docs.callTool as (...a: unknown[]) => Promise<unknown>)(params, ...rest);
      on(params.name, Date.now() - t0, params.arguments ?? {});
      return r;
    }) as Docs["callTool"],
  };
}

const sig = (fn: Fn) => (fn === "balanceOf" ? "balanceOf(address)" : `${fn}()`);

export async function runDemo(emit: Emit, job: Job, deps: Deps = realDeps): Promise<void> {
  const t0 = Date.now();
  const label = LABELS[job.contract.toLowerCase()] ?? `contract ${job.contract}`;
  emit({ type: "start", contract: job.contract, label, fn: job.fn, signature: sig(job.fn), preset: job.preset ?? null, chainMcp: "https://mcp.pharos.xyz/mcp", docsMcp: DOCS_MCP_URL });
  const [mcp, rawDocs] = await Promise.all([deps.chain(), deps.docs()]);
  try {
    // 1. one block for the whole run (the CLI pins every read the same way)
    let s = Date.now();
    const block = BigInt((await mcp.call("get_block_number")).blockNumber);
    let holder = job.holder;
    let holderLabel = job.holder ? (LABELS[job.holder.toLowerCase()] ?? "the address you gave") : undefined;
    if (job.fn === "balanceOf" && job.findHolder) {
      const recent = await largestTransferRecipient(mcp.call, job.contract, block, "USDC");
      holder = recent?.address ?? WPROS;
      holderLabel = recent?.label ?? "the WPROS token contract";
    }
    emit({ type: "step", id: "head", state: "ok", label: `block ${block.toLocaleString("en-US")}${holder && job.findHolder ? " · holder picked" : ""}`, ms: Date.now() - s, block: block.toString(), holder: holder ?? null, holderLabel: holderLabel ?? null });

    // 2 + 3. the docs explain it first; the answer only counts when a cited page names the function
    const docCalls: { tool: string; ms: number; url?: string }[] = [];
    let askMs = 0;
    let asked = false;
    const docs = watchDocs(rawDocs, (tool, ms, args) => {
      docCalls.push({ tool, ms, ...(typeof args.url === "string" ? { url: args.url } : {}) });
      if (tool === "askQuestion") {
        askMs = ms;
        asked = true;
        emit({ type: "step", id: "ask", state: "ok", label: "answer + sources", ms });
      }
    });
    s = Date.now();
    let registry: { text: string | null } = { text: null };
    try {
      registry = { text: await getDocPage(docs, REGISTRY) };
    } catch {
      /* listedInDocs stays null */
    }
    const target: Target = { contract: job.contract, label, fn: job.fn, ...(holder ? { holder, holderLabel: holderLabel! } : {}) };
    const sAsk = Date.now();
    const e = await explain(docs, target, registry);
    if (!asked) emit({ type: "step", id: "ask", state: "failed", label: e.error ? "docs call failed" : "no answer", ms: Date.now() - sAsk });
    const askAt = docCalls.findIndex((c) => c.tool === "askQuestion");
    const pages = askAt < 0 ? 0 : docCalls.slice(askAt + 1).filter((c) => c.tool === "getPage").length; // cited pages, not the registry read before the question
    emit({
      type: "step",
      id: "ground",
      state: e.documented ? "ok" : "refused",
      label: e.documented ? `named on ${e.groundedIn.length} cited page${e.groundedIn.length > 1 ? "s" : ""}` : "NOT DESCRIBED",
      ms: Math.max(0, Date.now() - sAsk - askMs),
      pagesChecked: pages,
    });

    // 4. the same function, same contract, same block, via the Chain MCP
    s = Date.now();
    const reading = await readOnChain(mcp.call, target, block, e.documented);
    emit({ type: "step", id: "call", state: "ok", label: `eth_call → ${reading.raw.length > 14 ? reading.raw.slice(0, 12) + "…" : reading.raw}`, ms: Date.now() - s });

    // 5. read against the explanation (deterministic code, no language model)
    const interpretation = interpret(target, e, reading);
    emit({ type: "step", id: "read", state: e.documented ? "ok" : "refused", label: e.documented ? "read with the docs" : "raw value only", ms: 0 });
    emit({ type: "done", block: block.toString(), target, docs: e, chain: reading, interpretation, docCalls, totalMs: Date.now() - t0, summary: e.documented ? `Explained by the docs (${e.groundedIn.length} cited page names ${job.fn}), then read on chain at block ${block}.` : `The docs do not describe ${sig(job.fn)}: no explanation is given, and the chain value is shown raw.` });
  } finally {
    await Promise.allSettled([mcp.close(), rawDocs.close()]);
  }
}

const runGate = gate(3_000);

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "info";
  if (action === "info") return json(200, { deploy: deployInfo(), presets: PRESETS, functions: FUNCTIONS, chainMcp: "https://mcp.pharos.xyz/mcp", docsMcp: DOCS_MCP_URL });
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
