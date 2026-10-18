// The agent behind the doc-grounded-builder-agent task: "how do I X on Pharos?" → plan from the Docs MCP (sources cited) →
// do X through the Chain MCP → verify on chain against the plan. Funds only move with execute on Atlantic, never on mainnet.
import { encodeFunctionData, erc20Abi, decodeFunctionResult, formatEther, formatUnits, isAddress, parseEther, toHex, type Hex } from "viem";
import { askDocs, getDocPage, searchDocs, type DocsClient } from "../../src/lib/docs-mcp.js";
import type { ChainMcp } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import type { PreparedTx, TestnetSigner } from "../../src/lib/signer.js";
import { NOT_DOCUMENTED, sentences } from "../docs-chain-mcp-agent/index.js";
import { withCommas } from "../read-contract-state/index.js";

type Docs = Pick<DocsClient, "callTool" | "listTools">;
type Call = ChainMcp["call"];
export type Kind = "balance" | "send" | "supply" | "receipt" | "other";
export type Network = "atlantic" | "pharos";

/** What the request asks for. Anything the agent has no executor for is "other": it is only looked up in the docs. */
export function classify(request: string): Kind {
  const r = request.toLowerCase();
  if (/\b(wrap|unwrap|bridge|swap|stake|deploy|mint)\b/.test(r)) return "other";
  if (/\b(receipt|look ?up (?:a |the )?(?:tx|transaction)|transaction status|tx status)\b/.test(r)) return "receipt";
  if (/total ?supply/.test(r)) return "supply";
  // The balance and send executors are native PHRS on Atlantic: a token or mainnet wording is not theirs to answer.
  const native = !/\b(tokens?|erc-?20|usdc|usdt|wpros|weth|link|mainnet|pacific|pros)\b/.test(r);
  if (/\b(send|transfer|pay)\b/.test(r)) return native ? "send" : "other";
  if (/\bbalance\b/.test(r)) return native ? "balance" : "other";
  return "other";
}

/** Per kind: the docs question and the words a cited page must contain for the docs to count as covering the request. */
const RECIPES: Record<Exclude<Kind, "other">, { question: (r: string) => string; needs: string[]; network: Network }> = {
  balance: { question: () => "How do I check my PHRS balance on Pharos Atlantic testnet?", needs: ["eth_getBalance"], network: "atlantic" },
  send: { question: () => "How do I send PHRS on Pharos Atlantic testnet?", needs: ["cast send", "--value"], network: "atlantic" },
  supply: { question: () => "How do I read the total supply of an ERC-20 token on Pharos?", needs: ["totalSupply"], network: "pharos" },
  receipt: { question: () => "How do I look up a transaction receipt on Pharos?", needs: ["eth_getTransactionReceipt"], network: "atlantic" },
};

export interface Plan {
  question: string;
  /** Verbatim docs sentences the plan rests on. */
  excerpt: string[];
  sources: { title: string; url: string }[];
  /** Cited pages (fetched with getPage) that contain every word of `needs`. */
  groundedIn: string[];
  /** True when the docs describe the request: not refusal-shaped AND a cited page names the method. */
  covered: boolean;
  /** The answer said it could not find this. */
  refused: boolean;
  steps: string[];
  expected: string;
}

const MAX_PAGES = 6;
/** askQuestion writes "don’t list", "can’t give" … in many shapes; the shared refusal pattern plus the shapes seen in live runs. */
const EXTRA_REFUSAL = /\b(?:do|does|did|is|are|was|were|can|could|will)(?:\s+not|n't)\s+(?:be\s+)?(?:list|listed|document|documented|specify|specified|provide|provided|give|support|supported|describe|describes|cover|mention|exist)\b|\bno (?:documented|supported|listed)\b|\bnot (?:listed|supported|available)\b/i;
export const refusal = (s: string) => {
  const t = s.replace(/[\u2018\u2019]/g, "'");
  return NOT_DOCUMENTED.test(t) || EXTRA_REFUSAL.test(t);
};

/** Step 1, before anything runs: ask the Docs MCP, then check that the pages it cites really name the method. */
export async function plan(docs: Docs, kind: Kind, request: string, needs?: string[]): Promise<Plan> {
  const recipe = kind === "other" ? undefined : RECIPES[kind];
  const question = recipe ? recipe.question(request) : /\?\s*$/.test(request.trim()) ? request.trim() : `${request.trim().replace(/[.!]+$/, "")}? How do I do this on Pharos?`;
  let answer = "";
  let sources: Plan["sources"] = [];
  try {
    const a = await askDocs(docs, question);
    answer = a.answer;
    sources = [...new Map(a.sources.map((s) => [s.url, s])).values()];
  } catch {
    // no answer: not covered
  }
  const refused = sentences(answer).some(refusal);
  const words = recipe?.needs ?? needs ?? [];
  const groundedIn: string[] = [];
  if (words.length && !refused) {
    const pages = new Map<string, Promise<string>>();
    const named = async (url: string) => {
      if (!pages.has(url)) pages.set(url, getDocPage(docs, url).catch(() => ""));
      const text = await pages.get(url)!;
      return words.every((w) => text.includes(w));
    };
    await Promise.all(sources.slice(0, MAX_PAGES).map(async (s) => void ((await named(s.url)) && groundedIn.push(s.url))));
    if (!groundedIn.length) {
      // askQuestion cites only some of the pages it drew on: look the method up with searchDocumentation and read those pages.
      const hits = await searchDocs(docs, words.join(" "), { limit: 3 }).catch(() => []);
      await Promise.all(
        hits.map(async (h) => {
          if (!(await named(h.url))) return;
          groundedIn.push(h.url);
          if (!sources.some((s) => s.url === h.url)) sources.push({ title: `${h.title} (found with searchDocumentation)`, url: h.url });
        }),
      );
    }
    groundedIn.sort((a, b) => sources.findIndex((s) => s.url === a) - sources.findIndex((s) => s.url === b));
  }
  const excerpt = sentences(answer).filter((s) => !refusal(s)).slice(0, 3);
  const covered = !!answer && !refused && sources.length > 0 && (words.length === 0 || groundedIn.length > 0);
  return { question, excerpt: covered ? excerpt : [], sources, groundedIn, covered, refused, steps: [], expected: "" };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export type Status = "success" | "failure" | "prepared" | "not-covered" | "no-executor";
export interface Outcome {
  request: string;
  kind: Kind;
  network: Network | null;
  plan: Plan;
  status: Status;
  /** What the plan said would be true afterwards. */
  expected: string;
  /** What was read back from the chain. */
  observed: string;
  checks: Check[];
  /** For a send: the unsigned transaction shown for signature. */
  unsigned?: Record<string, string>;
  tx?: { hash: Hex; explorer: string };
  note?: string;
}

export interface Params {
  address?: Hex;
  to?: Hex;
  amount?: string;
  token?: Hex;
  txHash?: Hex;
  execute: boolean;
}

export interface Deps {
  docs: Docs;
  /** The chain client for a network (read-only unless `broadcast`). */
  chain(network: Network, broadcast?: boolean): Promise<Pick<ChainMcp, "call" | "endpoint" | "network" | "chainId" | "server">>;
  /** The Atlantic signer for an MCP client opened with broadcast; only used with execute. */
  signer?(mcp: never): TestnetSigner;
  /** The address the testnet key controls (read from the key, never signs); undefined without a key. */
  defaultFrom?: Hex;
}

const ok = (name: string, detail: string): Check => ({ name, ok: true, detail });
const bad = (name: string, detail: string): Check => ({ name, ok: false, detail });
const eq = (name: string, a: unknown, b: unknown): Check => (String(a) === String(b) ? ok(name, `${a}`) : bad(name, `${a} ≠ ${b}`));

function finish(base: Omit<Outcome, "status" | "checks"> & { checks: Check[]; prepared?: boolean }): Outcome {
  const { prepared, ...rest } = base;
  return { ...rest, status: base.checks.some((c) => !c.ok) ? "failure" : prepared ? "prepared" : "success" };
}

async function balanceAt(call: Call, address: Hex, block: string) {
  return BigInt((await call("get_balance", { address, block })).balanceWei);
}

async function view(call: Call, to: Hex, fn: "totalSupply" | "decimals" | "symbol", block: string) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: fn });
  const { result } = await call("eth_call", { transaction: { to, data }, block });
  if (typeof result !== "string" || result === "0x") throw new Error(`${fn}() on ${to} returned no data at block ${block}: not a token contract`);
  return decodeFunctionResult({ abi: erc20Abi, functionName: fn, data: result as Hex }) as bigint | number | string;
}

/** Handle one "how do I …?" request end to end. */
export async function handle(request: string, params: Params, deps: Deps): Promise<Outcome> {
  const kind = classify(request);
  const network = kind === "other" ? null : RECIPES[kind].network;
  const p = await plan(deps.docs, kind, request);
  const stub = { request, kind, network, plan: p, expected: "", observed: "", checks: [] as Check[] };

  if (kind === "other") {
    // No executor: whatever the docs say, nothing is run. A refusal is reported as "the docs don't cover this".
    if (!p.covered) return { ...stub, status: "not-covered", note: "The docs don't cover this, so no plan is made and nothing is executed (no improvised steps)." };
    return { ...stub, status: "no-executor", note: "The docs describe this, but this agent has no executor for it: the cited pages are the plan, nothing was executed." };
  }
  if (!p.covered) {
    return { ...stub, status: "not-covered", note: `The docs don't cover this: no cited page names ${RECIPES[kind].needs.join(" + ")}, so no plan is made and nothing is executed.` };
  }

  const mcp = await deps.chain(network!, kind === "send" && params.execute);
  const call = mcp.call as Call;
  const head = (await call("get_block_number")).blockNumber;
  const done = (o: Partial<Outcome> & { checks: Check[]; expected: string; observed: string; steps: string[]; prepared?: boolean }) => {
    const { steps, ...rest } = o;
    return finish({ ...stub, ...rest, plan: { ...p, steps, expected: o.expected } });
  };

  if (kind === "balance") {
    const address = params.address ?? deps.defaultFrom;
    if (!address) throw new Error("balance needs --address 0x… (or a testnet key to take the address from)");
    const b = await call("get_balance", { address, block: head });
    const again = await balanceAt(call, address, head);
    return done({
      steps: [`Chain MCP get_balance(${address}) at block ${head} (docs: eth_getBalance returns wei)`, `Divide by 10^18 for PHRS`, `Re-read at block ${head}`],
      expected: `${formatEther(BigInt(b.balanceWei))} PHRS: the wei balance divided by 10^18, identical on a re-read at the same block`,
      observed: `${b.balanceWei} wei = ${formatEther(BigInt(b.balanceWei))} PHRS at block ${head}`,
      checks: [eq("re-read at the same block equals the first read", again, b.balanceWei), eq("tool's PHRS figure equals wei / 10^18", b.balance, formatEther(BigInt(b.balanceWei)))],
    });
  }

  if (kind === "supply") {
    if (!params.token || !isAddress(params.token)) throw new Error("supply needs --token 0x… (a token contract on Pharos mainnet)");
    const [raw, decimals, symbol] = await Promise.all([view(call, params.token, "totalSupply", head), view(call, params.token, "decimals", head), view(call, params.token, "symbol", head)]);
    const again = await view(call, params.token, "totalSupply", head);
    const shown = withCommas(formatUnits(raw as bigint, Number(decimals)));
    return done({
      steps: [`Chain MCP eth_call totalSupply() on ${params.token} at block ${head}`, `Chain MCP eth_call decimals() (${decimals}) and symbol()`, `Divide by 10^decimals (docs), re-read at block ${head}`],
      expected: `totalSupply() as a raw integer; ${shown} ${symbol} once divided by 10^${decimals}, identical on a re-read at the same block`,
      observed: `${raw} base units = ${shown} ${symbol} at block ${head}`,
      checks: [eq("re-read at the same block equals the first read", again, raw)],
    });
  }

  if (kind === "receipt") {
    if (!params.txHash) throw new Error("receipt needs --tx 0x…");
    const r = await call("get_transaction_receipt", { hash: params.txHash });
    return done({
      steps: [`Chain MCP get_transaction_receipt(${params.txHash})`, "Read status, blockNumber, gasUsed"],
      expected: "a receipt with status 0x1 (success)",
      observed: r ? `status ${r.status}, block ${BigInt(r.blockNumber)}, gasUsed ${BigInt(r.gasUsed)}` : "no receipt (the node does not know this hash)",
      checks: [r ? (r.status === "0x1" ? ok("receipt status", "0x1 success") : bad("receipt status", `${r.status}: the transaction reverted`)) : bad("receipt found", "none")],
      tx: { hash: params.txHash, explorer: explorerTx(network!, params.txHash) },
    });
  }

  // send: Atlantic only. Prepared for signature; signed and sent only with execute.
  if (!params.to || !isAddress(params.to)) throw new Error("send needs --to 0x… and --amount <PHRS>");
  if (!params.amount || !/^\d+(\.\d{1,18})?$/.test(params.amount)) throw new Error("--amount is PHRS as a decimal number, e.g. 0.001");
  const value = parseEther(params.amount);
  const from = params.execute ? deps.signer!(mcp as never).address : (params.address ?? deps.defaultFrom);
  if (!from) throw new Error("send needs --from 0x… (or a testnet key) to prepare the transaction");
  const intent = { to: params.to, value };
  let tx: PreparedTx;
  let signer: TestnetSigner | undefined;
  if (params.execute) {
    signer = deps.signer!(mcp as never);
    tx = await signer.prepare(intent);
  } else {
    const [nonce, gas, block, price] = await Promise.all([
      call("get_transaction_count", { address: from, block: "pending" }),
      call("estimate_gas", { transaction: { from, to: params.to, value: toHex(value) } }),
      call("get_block", { block: "latest" }),
      call("get_gas_price"),
    ]);
    const priority = BigInt(price.maxPriorityFeePerGasWei);
    tx = { chainId: mcp.chainId, to: params.to, value, nonce: Number(nonce.nonce), gas: BigInt(gas.gas), maxFeePerGas: BigInt(block!.baseFeePerGas!) * 2n + priority, maxPriorityFeePerGas: priority };
  }
  const unsigned = { from, to: tx.to, value: `${tx.value} wei (${params.amount} PHRS)`, chainId: String(tx.chainId), nonce: String(tx.nonce), gas: String(tx.gas), maxFeePerGas: String(tx.maxFeePerGas), maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas) };
  const fromBefore = await balanceAt(call, from, head);
  const toBefore = await balanceAt(call, params.to, head);
  const worst = tx.value + tx.gas * tx.maxFeePerGas;
  const funded = fromBefore >= worst ? ok("sender can cover value + max fee", `${fromBefore} wei ≥ ${worst} wei`) : bad("sender can cover value + max fee", `${fromBefore} wei < ${worst} wei`);
  const steps = [
    `Docs: a native transfer is \`cast send <to> --value <amount>\`; here the Chain MCP prepares it (nonce ${tx.nonce}, gas ${tx.gas}, fees from the latest block)`,
    params.execute ? `Sign locally and broadcast through the Chain MCP (send_raw_transaction)` : "Show the unsigned transaction for signature (no key used, nothing sent)",
    `Re-read the receipt and both balances through the Chain MCP`,
  ];
  if (!params.execute) {
    return done({ steps, unsigned, prepared: true, expected: `after signing: receipt status 0x1, recipient +${tx.value} wei, sender −(${tx.value} wei + gasUsed × effectiveGasPrice)`, observed: `PREPARED, not signed and not sent; balances at block ${head}: sender ${fromBefore} wei, recipient ${toBefore} wei`, checks: [funded] });
  }
  const signed = await signer!.sign(tx);
  await signer!.broadcast(signed);
  const r = await signer!.waitForReceipt(signed.hash);
  const rb = r.blockNumber.toString();
  const [fromAfter, toAfter] = await Promise.all([balanceAt(call, from, rb), balanceAt(call, params.to, rb)]);
  const fee = r.gasUsed * (r.effectiveGasPrice ?? tx.maxFeePerGas);
  const checks = [
    funded,
    r.status === "success" ? ok("receipt status", "success") : bad("receipt status", "reverted"),
    eq("recipient balance rose by the amount", toAfter - toBefore, value),
    r.effectiveGasPrice === undefined ? bad("sender fell by the amount + fee", "the receipt has no effectiveGasPrice") : eq("sender fell by the amount + gasUsed × effectiveGasPrice", fromBefore - fromAfter, value + fee),
  ];
  return done({
    steps,
    unsigned,
    checks,
    expected: `receipt status 0x1, recipient +${value} wei, sender −(${value} wei + gasUsed × effectiveGasPrice)`,
    observed: `${r.status} in block ${rb}; recipient ${toBefore} → ${toAfter} wei, sender ${fromBefore} → ${fromAfter} wei, fee ${fee} wei`,
    tx: { hash: signed.hash, explorer: explorerTx("atlantic", signed.hash) },
  });
}

export function format(o: Outcome, i: number, n: number): string {
  const out = [`[${i + 1}/${n}] request: "${o.request}"  → ${o.kind === "other" ? "no executor" : o.kind}${o.network ? ` on ${o.network}` : ""}`];
  out.push("  1. PLAN (Docs MCP, before acting)");
  out.push(`     asked: ${o.plan.question}`);
  if (o.plan.covered) {
    out.push(...o.plan.excerpt.map((x) => `     "${x}"`), ...(o.plan.groundedIn.length ? [`     (checked: ${RECIPES[o.kind as Exclude<Kind, "other">].needs.join(" + ")} is named on ${o.plan.groundedIn[0]})`] : []));
  } else out.push(`     NOT COVERED: ${o.plan.refused ? "the docs answer says they cannot confirm this" : "no cited page names the method"}`);
  if (o.plan.sources.length) out.push("     sources:", ...o.plan.sources.slice(0, 4).map((s) => `       - ${s.title}: ${s.url}`));
  if (o.status === "not-covered" || o.status === "no-executor") {
    out.push(`  RESULT: ${o.status === "not-covered" ? "THE DOCS DON'T COVER THIS" : "NOT EXECUTED"}. ${o.note}`);
    return out.join("\n");
  }
  out.push("  2. EXECUTE (Chain MCP)", ...o.plan.steps.map((s, j) => `     ${j + 1}) ${s}`));
  if (o.unsigned) out.push("     unsigned transaction (for signature):", ...Object.entries(o.unsigned).map(([k, v]) => `       ${k}: ${v}`));
  if (o.tx) out.push(`     tx ${o.tx.hash}  ${o.tx.explorer}`);
  out.push("  3. VERIFY (on chain)", `     expected: ${o.expected}`, `     observed: ${o.observed}`, ...o.checks.map((c) => `     ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`));
  out.push(`  RESULT: ${o.status.toUpperCase()}${o.status === "prepared" ? " (needs --execute on Atlantic to sign and send)" : ""}`);
  return out.join("\n");
}
