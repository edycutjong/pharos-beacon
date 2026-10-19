// The live demo behind pharos.edycu.dev/dry-run-executor (api/dry-run-executor.ts). Simulation only: the same dryRun()
// the CLI runs, with execute off, so nothing is ever signed or sent. Reads come from the public Atlantic RPC through a
// read-only adapter (the Atlantic Chain MCP runs over stdio and cannot run on Vercel). The real sends are on the page as
// recorded runs from the committed proof files.
//   GET ?action=info                                   deploy stamp + scenarios
//   GET ?action=run&scenario=send|deposit|token|revert|broke
//   GET ?action=run&scenario=custom&from=0x…&to=0x…(&value=PHRS | &token=USDC&amount=n | &data=0x…)
import { encodeFunctionData, erc20Abi, formatEther, formatGwei, formatUnits, getAddress, isAddress, parseEther, parseUnits, type Hex } from "viem";
import { atlanticCall, ATLANTIC_RPC, type CallEvent, type Rpc } from "../../src/lib/atlantic-call.js";
import { busy, deployInfo, gate, InputError, json, ndjson, type Emit } from "../../src/lib/demo-stream.js";
import { TOKENS } from "../../src/lib/networks.js";
import { dryRun } from "../../src/dryrun/run.js";
import type { SimRequest } from "../../src/dryrun/simulate.js";

/** The author's public Atlantic test wallet (in every proof). The page only simulates from it; it never signs. */
export const AUTHOR = getAddress("0x317bca01Bb101C0F1E86C21576a4e14D92B02975");
/** The fresh recipient of the recorded runs. */
export const FRESH = getAddress("0x0Ef32f97565aDB7BDf3538b934F65877A848aD4B");
/** An address that holds no PHRS on Atlantic (checked 2026-10-19), for the "cannot pay" case. */
export const EMPTY = getAddress("0x00000000000000000000000000000000000B0b00");
const TOKEN_NAMES = Object.keys(TOKENS.atlantic) as (keyof typeof TOKENS.atlantic)[];

export const SCENARIOS = {
  send: { label: "Send 0.0001 PHRS", what: "a plain PHRS transfer from our test wallet to a fresh address" },
  deposit: { label: "Call WPHRS deposit()", what: "a contract call that wraps 0.0001 PHRS" },
  token: { label: "Transfer 0.00001 WPHRS", what: "an ERC-20 transfer, both token balances predicted" },
  revert: { label: "Transfer 1,000,000,000 USDC", what: "a transfer the sender cannot cover: the token reverts" },
  broke: { label: "Send from an empty wallet", what: "a sender with no PHRS for the value and the fee" },
} as const;
export type Scenario = keyof typeof SCENARIOS | "custom";
export const STEP_IDS = ["read", "call", "estimate", "funds", "predict", "decide"] as const;

const MAX_VALUE = parseEther("1000000");

function tokenTransfer(from: Hex, name: keyof typeof TOKENS.atlantic, to: Hex, amount: string): SimRequest {
  const tok = TOKENS.atlantic[name];
  let n: bigint;
  try {
    n = parseUnits(amount, tok.decimals);
  } catch {
    throw new InputError(`amount ${JSON.stringify(amount)} is not a number`);
  }
  return { from, to: tok.address as Hex, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, n] }), token: { symbol: name, decimals: tok.decimals } };
}

const addr = (name: string, v: string | null): Hex => {
  if (!v || !isAddress(v)) throw new InputError(`${name} must be a 0x address`);
  return getAddress(v);
};

/** The transaction to simulate, from the query string. Throws InputError on anything malformed. */
export function requestFor(q: URLSearchParams): { scenario: Scenario; req: SimRequest } {
  const scenario = (q.get("scenario") ?? "send") as Scenario;
  switch (scenario) {
    case "send":
      return { scenario, req: { from: AUTHOR, to: FRESH, value: parseEther("0.0001") } };
    case "deposit":
      return { scenario, req: { from: AUTHOR, to: getAddress(TOKENS.atlantic.WPHRS.address), value: parseEther("0.0001"), data: "0xd0e30db0" } };
    case "token":
      return { scenario, req: tokenTransfer(AUTHOR, "WPHRS", FRESH, "0.00001") };
    case "revert":
      return { scenario, req: tokenTransfer(AUTHOR, "USDC", FRESH, "1000000000") };
    case "broke":
      return { scenario, req: { from: EMPTY, to: FRESH, value: parseEther("0.0001") } };
    case "custom": {
      const from = addr("from", q.get("from"));
      const to = addr("to", q.get("to"));
      const token = q.get("token");
      if (token) {
        if (!(TOKEN_NAMES as string[]).includes(token)) throw new InputError(`token must be one of ${TOKEN_NAMES.join(", ")}`);
        const amount = q.get("amount") ?? "";
        if (!/^\d{1,18}(\.\d{1,18})?$/.test(amount)) throw new InputError("amount must be a decimal number, e.g. 1.5");
        return { scenario, req: tokenTransfer(from, token as keyof typeof TOKENS.atlantic, to, amount) };
      }
      const value = q.get("value") || "0";
      if (!/^\d{1,7}(\.\d{1,18})?$/.test(value)) throw new InputError("value must be PHRS as a decimal number, e.g. 0.0001");
      const wei = parseEther(value);
      if (wei > MAX_VALUE) throw new InputError("value is capped at 1,000,000 PHRS on this page");
      const data = q.get("data") || undefined;
      if (data !== undefined && (!/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length > 2 + 2 * 4096)) throw new InputError("data must be 0x hex bytes (at most 4096 bytes)");
      if (wei === 0n && !data) throw new InputError("give a value (PHRS), data, or a token and amount");
      return { scenario, req: { from, to, value: wei, ...(data ? { data: data as Hex } : {}) } };
    }
    default:
      throw new InputError(`unknown scenario ${JSON.stringify(scenario).slice(0, 40)}: use ${[...Object.keys(SCENARIOS), "custom"].join(", ")}`);
  }
}

/**
 * One simulation, streamed: a step event per lamp as the real reads come back, then "done" with the full result.
 * The decision lamp is the requirement-4 gate: BLOCKED when the simulation fails, otherwise "would send" (never sent here).
 */
export async function runDemo(emit: Emit, scenario: Scenario, req: SimRequest, rpc?: Rpc): Promise<void> {
  const t0 = Date.now();
  emit({ type: "start", scenario, request: describe(req), via: `Atlantic RPC ${ATLANTIC_RPC} (read-only)` });
  let phase = "read";
  let readMs = 0;
  let callState: { state: string; label: string; ms: number } | undefined;
  let estimate: { state: string; label: string; ms: number } | undefined;
  const calls: CallEvent[] = [];
  const raw = atlanticCall({ ...(rpc ? { rpc } : {}), maxCalls: 20, onCall: (e) => calls.push(e) });
  // Watch the calls simulate() makes, to light the lamps in order: the tx's own eth_call carries `from`, balanceOf reads do not.
  const call = (async (tool: string, args: Record<string, unknown> = {}) => {
    const isTx = (tool === "eth_call" || tool === "estimate_gas") && !!(args.transaction as { from?: string } | undefined)?.from;
    if (isTx && phase === "read") {
      phase = "call";
      readMs = Date.now() - t0;
    }
    const s = Date.now();
    try {
      const r = await raw(tool as never, args);
      if (isTx && tool === "eth_call") callState = { state: "ok", label: "runs, no revert", ms: Date.now() - s };
      if (isTx && tool === "estimate_gas") estimate = { state: "ok", label: `${BigInt((r as { gas: string }).gas).toLocaleString("en-US")} gas`, ms: Date.now() - s };
      return r;
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (isTx && tool === "eth_call") callState = { state: code === 3 ? "refused" : "failed", label: code === 3 ? "reverts" : "node refused", ms: Date.now() - s };
      if (isTx && tool === "estimate_gas") estimate = { state: "failed", label: "estimate failed", ms: Date.now() - s };
      throw e;
    }
  }) as typeof raw;

  const result = await dryRun(call, req, { execute: false });
  const s = result.simulation;
  const steps = [
    { id: "read", state: "ok", label: `block ${Number(s.block).toLocaleString("en-US")} · ${formatGwei(s.gasPriceWei)} gwei`, ms: readMs || Date.now() - t0 },
    callState ? { id: "call", ...callState } : { id: "call", state: "skip", label: "not reached", ms: 0 },
    estimate ? { id: "estimate", ...estimate } : { id: "estimate", state: "skip", label: callState?.state === "ok" ? "not reached" : "skipped after the revert", ms: 0 },
    s.failure?.startsWith("not enough PHRS")
      ? { id: "funds", state: "failed", label: "cannot pay value + fee", ms: 0 }
      : s.gas !== undefined
        ? { id: "funds", state: "ok", label: "value + fee covered", ms: 0 }
        : { id: "funds", state: "skip", label: "not reached", ms: 0 },
    { id: "predict", state: "ok", label: `${s.changes.length} balances${s.ok ? " predicted" : " unchanged"}`, ms: 0 },
    result.status === "blocked" ? { id: "decide", state: "refused", label: "BLOCKED", ms: 0 } : { id: "decide", state: "ok", label: "would send (not sent here)", ms: 0 },
  ];
  for (const st of steps) emit({ type: "step", ...st });
  emit({
    type: "done",
    status: result.status,
    ok: s.ok,
    block: s.block,
    failure: s.failure ?? null,
    revertData: s.revertData ?? null,
    gas: s.gas ?? null,
    gasPriceWei: s.gasPriceWei,
    feePHRS: s.costWei !== undefined ? formatEther(s.costWei) : null,
    changes: s.changes.map((c) => ({ ...c, beforeText: formatUnits(c.before, c.decimals), afterText: formatUnits(c.after, c.decimals) })),
    request: describe(req),
    calls: calls.map((c) => c.tool),
    totalMs: Date.now() - t0,
    summary: result.status === "blocked" ? `WOULD FAIL — ${s.failure}. BLOCKED: nothing was signed or sent.` : `WOULD SUCCEED: ${s.gas} gas, ${formatEther(s.costWei!)} PHRS fee. The page never sends; the CLI sends only with --execute.`,
  });
}

function describe(r: SimRequest) {
  return { from: r.from, to: r.to, value: r.value.toString(), valuePHRS: formatEther(r.value), data: r.data ?? null, token: r.token ?? null };
}

const runGate = gate(2_000);

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "info";
  if (action === "info") return json(200, { deploy: deployInfo(), via: ATLANTIC_RPC, scenarios: SCENARIOS, tokens: TOKEN_NAMES, author: AUTHOR, fresh: FRESH });
  if (action !== "run") return json(400, { error: `unknown action ${JSON.stringify(action).slice(0, 40)}: use info or run` });
  let parsed: ReturnType<typeof requestFor>;
  try {
    parsed = requestFor(url.searchParams);
  } catch (e) {
    if (e instanceof InputError) return json(400, { error: e.message });
    throw e;
  }
  const wait = runGate.take();
  if (wait) return busy(wait);
  return ndjson((emit) => runDemo(emit, parsed.scenario, parsed.req), () => runGate.release());
}
