// Docs MCP + Chain MCP Agent (Medium · 100 pts): explain a contract function from the Pharos docs, then call that same
// function on chain and read the result in the light of the explanation.
//   npm run docs-chain-mcp-agent -- [--contract 0x…] [--function name|symbol|decimals|totalSupply|balanceOf] [--arg 0x…] [--block N] [--json] [--proof]
// With no flags it runs the five-function demo on Pharos mainnet (USDC and WPROS from the docs token registry).
// Docs MCP: askQuestion (the explanation and its sources) + getPage (is the address listed on the cited page).
// Chain MCP: the hosted, keyless mainnet server, eth_call pinned to one block. No language model: same inputs, same report.
// When the docs do not describe a function the agent says so, still reads the value, and gives it raw: no explanation
// and no units from general knowledge.
import { decodeFunctionResult, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseAbi, type Hex } from "viem";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { askDocs, docsMcp, DOCS_MCP_URL, getDocPage, type DocsClient } from "../../src/lib/docs-mcp.js";
import { chainMcp, ChainToolError, type ChainMcp } from "../../src/lib/mcp.js";
import { TOKENS } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { largestTransferRecipient, withCommas } from "../read-contract-state/index.js";

const TASK = "docs-chain-mcp-agent";
export const FUNCTIONS = ["name", "symbol", "decimals", "totalSupply", "balanceOf", "getChainId"] as const;
/** ERC-20 views plus Multicall3.getChainId(), the one non-token function the demo asks about. */
const ABI = [...erc20Abi, ...parseAbi(["function getChainId() view returns (uint256)"])];
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"; // docs Canonical Contracts page
export type Fn = (typeof FUNCTIONS)[number];
export type Call = ChainMcp["call"];
type Docs = Pick<DocsClient, "callTool" | "listTools">;

export interface Target {
  contract: Hex;
  /** How the docs name the contract, e.g. "USDC (Circle-deployed)". */
  label: string;
  fn: Fn;
  /** balanceOf only. */
  holder?: Hex;
  holderLabel?: string;
}

const REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";
const registryLabels: Record<string, string> = {
  [TOKENS.pharos.USDC.address.toLowerCase()]: "USDC (Circle-deployed)",
  [TOKENS.pharos.WPROS.address.toLowerCase()]: "WPROS (Wrapped PROS)",
  [TOKENS.pharos.LINK.address.toLowerCase()]: "LINK",
  [TOKENS.pharos.WETH.address.toLowerCase()]: "WETH",
  [MULTICALL3.toLowerCase()]: "Multicall3 (canonical contract)",
};

/** The docs say they do not cover it: askQuestion answers with a refusal-shaped sentence, often next to sources. */
export const NOT_DOCUMENTED =
  /\b(?:cannot|can't|can not|could not|couldn't|unable to)\s+(?:find|locate|confirm|verify)\b|\b(?:does|do|did)\s*(?:not|n't)\s+(?:explain|describe|document|say|specify|mention|cover|list|include|define|give)\b|\bnot (?:covered|documented|described|mentioned|explained|specified)\b|\bno (?:relevant |matching )?(?:information|details|mention|documentation)\b/i;

/** Plain prose: code blocks dropped, markdown emphasis, backticks and link targets removed. */
const prose = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

export const sentences = (text: string) =>
  prose(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z`*[])/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The docs sentences that name the function, with no refusal among them. Empty = the docs do not describe it. */
export function excerptFor(answer: string, fn: Fn): string[] {
  const words = fn === "balanceOf" ? [fn, "decimals"] : [fn];
  const keep = sentences(answer).filter((s) => !NOT_DOCUMENTED.test(s) && words.some((w) => new RegExp(`\\b${w}\\b`).test(s)));
  return keep.some((s) => new RegExp(`\\b${fn}\\b`).test(s)) ? keep.slice(0, 3) : [];
}

export interface Explanation {
  question: string;
  documented: boolean;
  /** Verbatim sentences from the askQuestion answer that the interpretation cites. */
  excerpt: string[];
  sources: { title: string; url: string }[];
  /** Is the contract address on the token registry page (getPage)? null = the page could not be fetched. */
  listedInDocs: boolean | null;
  /** Cited pages (getPage) whose text names the function. The explanation only counts when at least one does. */
  groundedIn: string[];
  error?: string;
}

const signature = (t: Target) => (t.fn === "balanceOf" ? "balanceOf(address)" : `${t.fn}()`);

const MAX_PAGES = 6; // cited pages fetched per function

export async function explain(docs: Docs, t: Target, registry: { text: string | null }, pages = new Map<string, Promise<string>>()): Promise<Explanation> {
  const question = `What does the ${signature(t)} function of ${t.fn === "getChainId" ? "the Multicall3 canonical contract" : `a token like ${t.label}`} do on Pharos, and how should its result be read?`;
  let answer = "";
  let sources: Explanation["sources"] = [];
  let error: string | undefined;
  try {
    const a = await askDocs(docs, question);
    answer = a.answer;
    sources = [...new Map(a.sources.map((s) => [s.url, s])).values()];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // askQuestion is a language model and can answer from general knowledge, so its answer only counts when a page it
  // cites names the function itself (an exact, case-sensitive match on the function name in the page text).
  let excerpt = error || !sources.length ? [] : excerptFor(answer, t.fn);
  const groundedIn: string[] = [];
  if (excerpt.length) {
    const name = new RegExp(`\\b${t.fn}\\b`);
    await Promise.all(
      sources.slice(0, MAX_PAGES).map(async (s) => {
        if (!pages.has(s.url)) pages.set(s.url, getDocPage(docs, s.url).catch(() => ""));
        if (name.test(await pages.get(s.url)!)) groundedIn.push(s.url);
      }),
    );
    groundedIn.sort((a, b) => sources.findIndex((s) => s.url === a) - sources.findIndex((s) => s.url === b));
    if (!groundedIn.length) excerpt = [];
  }
  const listedInDocs = registry.text === null ? null : registry.text.toLowerCase().includes(t.contract.toLowerCase());
  return { question, documented: excerpt.length > 0, excerpt, sources, listedInDocs, groundedIn, ...(error ? { error } : {}) };
}

export interface Reading {
  block: string;
  /** The decoded value as a string (bigint → decimal digits). */
  raw: string;
  /** Set for balanceOf / totalSupply, read from the same block, only used when the docs explained the function. */
  decimals?: number;
  symbol?: string;
}

async function view(call: Call, to: Hex, fn: Fn, block: bigint, args?: readonly [Hex]) {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, ...(args ? { args } : {}) } as never);
  const { result } = await call("eth_call", { transaction: { to, data }, block: block.toString() });
  if (typeof result !== "string" || result === "0x") throw new Error(`${fn}() on ${to} returned no data at block ${block}: not a token contract`);
  return decodeFunctionResult({ abi: ABI, functionName: fn, data: result as Hex } as never) as string | number | bigint;
}

export async function readOnChain(call: Call, t: Target, block: bigint, withUnits: boolean): Promise<Reading> {
  const value = await view(call, t.contract, t.fn, block, t.fn === "balanceOf" ? [t.holder!] : undefined);
  const reading: Reading = { block: block.toString(), raw: String(value) };
  // Units are only fetched for a function the docs explained; for an undocumented one the answer stays raw.
  if (withUnits && (t.fn === "balanceOf" || t.fn === "totalSupply")) {
    // A contract without decimals() / symbol() is not an error: the reading falls back to the raw value.
    try {
      reading.decimals = Number(await view(call, t.contract, "decimals", block));
      reading.symbol = String(await view(call, t.contract, "symbol", block));
    } catch (e) {
      if (!(e instanceof ChainToolError) && !/returned no data/.test(String(e))) throw e;
      delete reading.decimals;
      delete reading.symbol;
    }
  }
  return reading;
}

/** The result read against the explanation. Cites the docs excerpt it relies on; says plainly when there is none. */
export function interpret(t: Target, e: Explanation, r: Reading): string {
  if (!e.documented) {
    return `The docs do not describe ${signature(t)}, so there is no explanation to read this against and no unit is applied. Raw result: ${r.raw}.`;
  }
  const cite = `Docs: "${e.excerpt.join(" ")}"`;
  switch (t.fn) {
    case "decimals":
      return `${cite} The chain returned ${r.raw}, so 1 whole token is 10^${r.raw} base units, and an amount shown with ${r.raw} decimal places is the base-unit integer divided by that.`;
    case "balanceOf": {
      if (r.decimals === undefined) return `${cite} Raw balance ${r.raw} base units.`;
      const amount = formatUnits(BigInt(r.raw), r.decimals);
      return `${cite} The chain returned ${r.raw} base units for the holder ${t.holder} (${t.holderLabel}); the same block's decimals() is ${r.decimals}, so that is ${withCommas(amount)} ${r.symbol}.`;
    }
    case "totalSupply": {
      if (r.decimals === undefined) return `${cite} Raw supply ${r.raw} base units.`;
      return `${cite} The chain returned ${r.raw} base units; with decimals() ${r.decimals} that is ${withCommas(formatUnits(BigInt(r.raw), r.decimals))} ${r.symbol}.`;
    }
    case "getChainId":
      return `${cite} The chain returned ${r.raw}; the docs name the chain this contract is called on.`;
    default:
      return `${cite} The chain returned ${JSON.stringify(r.raw)}.`;
  }
}

export interface Step {
  target: Target;
  docs: Explanation;
  chain: Reading;
  interpretation: string;
}

export async function run(docs: Docs, call: Call, targets: Target[], block: bigint): Promise<Step[]> {
  let registry: { text: string | null } = { text: null };
  try {
    registry = { text: await getDocPage(docs, REGISTRY) };
  } catch {
    // listedInDocs stays null for every target
  }
  const pages = new Map<string, Promise<string>>();
  const steps: Step[] = [];
  for (const target of targets) {
    const e = await explain(docs, target, registry, pages); // 1. the docs explain it first …
    const chain = await readOnChain(call, target, block, e.documented); // 2. … then the same function is called …
    steps.push({ target, docs: e, chain, interpretation: interpret(target, e, chain) }); // 3. … and the result is read against the explanation
  }
  return steps;
}

export const slug = (t: Target) => `${t.label.split(/[ (]/)[0]!.toLowerCase().replace(/[^a-z0-9]+/g, "-") || t.contract.toLowerCase()}-${t.fn.toLowerCase()}`;

export function format(steps: Step[], block: string): string {
  const out = [`Pharos mainnet (chain 1672), every read pinned to block ${block}`, ""];
  steps.forEach((s, i) => {
    const { target: t, docs: d, chain: c } = s;
    out.push(`[${i + 1}/${steps.length}] ${t.label} · ${signature(t)}${t.holder ? `  holder ${t.holder} [${t.holderLabel}]` : ""}`);
    out.push(`  contract ${t.contract}${d.listedInDocs === null ? "" : d.listedInDocs ? "  (this address is listed on the docs Token Registry page)" : "  (this address is NOT on the docs Token Registry page)"}`);
    out.push("  1. Docs MCP (askQuestion):");
    if (d.error) out.push(`     docs call failed: ${d.error}`);
    else if (d.documented) out.push(...d.excerpt.map((x) => `     "${x}"`), `     (checked: ${signature(t)} is named on ${d.groundedIn.join(", ")})`);
    else out.push(`     NOT DESCRIBED in the docs: ${d.sources.length ? `no cited page names ${t.fn}` : "askQuestion found nothing"}, so no explanation is given (nothing is filled in from general knowledge).`);
    // The page that names the function is listed first and marked, so the "(checked: …)" line points at a page the reader can see.
    const named = (x: { url: string }) => d.groundedIn.includes(x.url);
    if (d.sources.length) out.push("     sources:", ...[...d.sources.filter(named), ...d.sources.filter((x) => !named(x))].slice(0, 4).map((x) => `       - ${x.title}: ${x.url}${named(x) ? `  (names ${t.fn})` : ""}`));
    out.push(`  2. Chain MCP (eth_call @ ${c.block}): ${c.raw}`);
    out.push(`  3. Reading: ${s.interpretation}`, "");
  });
  return out.join("\n").trimEnd();
}

export async function main(
  { onExit }: RunContext,
  argv = process.argv.slice(2),
  connect: (n: "pharos") => Promise<Pick<ChainMcp, "call" | "close" | "endpoint" | "network" | "chainId" | "server">> = chainMcp,
  connectDocs: () => Promise<Docs & { close(): Promise<void> }> = () => docsMcp(),
): Promise<number> {
  const { values } = parseCli(
    {
      usage: `npm run ${TASK} -- [--contract 0x…] [--function ${FUNCTIONS.join("|")}] [--arg 0x…] [--block N] [--json] [--proof]`,
      options: { contract: { type: "string" }, function: { type: "string" }, arg: { type: "string" }, block: { type: "string" }, json: { type: "boolean", default: false }, proof: { type: "boolean", default: false } },
    },
    argv,
  );
  if ((values.contract === undefined) !== (values.function === undefined)) throw new UsageError("--contract and --function go together (leave both out for the demo)");
  if (values.contract !== undefined && !isAddress(values.contract)) throw new UsageError(`--contract must be an address (got ${JSON.stringify(values.contract)})`);
  if (values.block !== undefined && !/^\d+$/.test(values.block)) throw new UsageError("--block must be a block number (decimal digits)");
  const fn = values.function === undefined ? undefined : choice("--function", values.function, FUNCTIONS);
  if (fn === "balanceOf" ? !values.arg || !isAddress(values.arg) : values.arg !== undefined) throw new UsageError(fn === "balanceOf" ? "--function balanceOf needs --arg 0x<holder address>" : "--arg is only for --function balanceOf");

  const mcp = await connect("pharos"); // the hosted, keyless Chain MCP; checks the endpoint serves chain 1672
  onExit(() => mcp.close());
  const docs = await connectDocs();
  onExit(() => docs.close());
  const head = BigInt((await mcp.call("get_block_number")).blockNumber);
  const block = values.block ? BigInt(values.block) : head;
  if (block > head) throw new UsageError(`--block ${block} is ahead of the chain head ${head}`);

  let targets: Target[];
  if (values.contract && fn) {
    const contract = getAddress(values.contract);
    const label = registryLabels[contract.toLowerCase()] ?? `contract ${contract}`;
    targets = [{ contract, label, fn, ...(fn === "balanceOf" ? { holder: getAddress(values.arg!), holderLabel: registryLabels[values.arg!.toLowerCase()] ?? "the --arg address" } : {}) }];
  } else {
    const usdc = getAddress(TOKENS.pharos.USDC.address);
    const wpros = getAddress(TOKENS.pharos.WPROS.address);
    const multicall = getAddress(MULTICALL3);
    // A holder that really has USDC (the recipient of the largest recent Transfer); the WPROS contract if none is found.
    const symbol = String(await view(mcp.call, usdc, "symbol", block));
    const recent = await largestTransferRecipient(mcp.call, usdc, block, symbol);
    const holder = recent ?? { address: wpros, label: "the WPROS token contract" };
    targets = [
      { contract: usdc, label: registryLabels[usdc.toLowerCase()]!, fn: "decimals" },
      { contract: usdc, label: registryLabels[usdc.toLowerCase()]!, fn: "balanceOf", holder: holder.address, holderLabel: holder.label },
      { contract: wpros, label: registryLabels[wpros.toLowerCase()]!, fn: "decimals" },
      { contract: wpros, label: registryLabels[wpros.toLowerCase()]!, fn: "totalSupply" },
      { contract: multicall, label: registryLabels[multicall.toLowerCase()]!, fn: "getChainId" },
    ];
  }

  const steps = await run(docs, mcp.call, targets, block);
  console.log(values.json ? JSON.stringify({ block: block.toString(), steps }, null, 2) : format(steps, block.toString()));
  console.log(`\nvia ${mcp.endpoint} (Chain MCP) and ${DOCS_MCP_URL} (Docs MCP)`);
  if (values.proof) {
    for (const s of steps) {
      const file = `proof/${slug(s.target)}.json`;
      console.log(`proof: ${writeProof(new URL(file, import.meta.url), { head: head.toString(), step: s }, proofMeta(TASK, mcp))}`);
    }
  }
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
