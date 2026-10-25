// Live demo endpoint for the Saga Executor (api/router.ts → this file). A page has no key, so it NEVER runs the saga. It offers two things:
//   mode=plan      LIVE keyless reads on Atlantic (public RPC): the pool's quote for the amount and whether the vault is open, then the four
//                  steps and the rollback order, exactly what `saga-executor plan` prints.
//   mode=recorded  a REPLAY of one of the three recorded Atlantic runs (success, forced failure with rollback, crash and resume) from
//                  proof/*.txt, every transaction linked to the explorer. It says "recorded" everywhere: it is not a live run.
// The pool and the vault are our own test contracts (Atlantic has none): tasks/saga-executor/contracts.
//   GET ?action=info
//   GET ?action=run&mode=plan[&amount=0.001]            |  GET ?action=run&mode=recorded&which=success|forced-failure|crash-resume
import { encodeFunctionData, formatUnits, parseUnits, type Hex } from "viem";
import { explorerTx } from "../../src/lib/networks.js";
import { poolAbi, vaultAbi } from "../../src/saga/defi.js";
import { atlanticRpcCall } from "../../src/web/atlantic-rpc.js";
import { InputError, actionOf, busy, concurrencyGate, deployInfo, guard, json, ndjson, stepper, type Emit } from "../../src/web/live.js";
import type { View } from "../../src/web/view.js";
import { RECORDED } from "./recorded.js";

const WPHRS = { address: "0x838800b758277CC111B2d48Ab01e5E164f8E9471" as Hex, decimals: 18 };
const USDC = { address: "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B" as Hex, decimals: 6 };
const POOL: Hex = "0x88176Fb095C178446816F5a1D7C32E35af1Fdac8";
const VAULT: Hex = "0xEAd78727Ab9523622C4fE706D15059A551502671";
const WHICH = ["success", "forced-failure", "crash-resume"] as const;
const TITLE: Record<(typeof WHICH)[number], string> = {
  success: "All four steps verified, deposit landed",
  "forced-failure": "Step 4 reverts (vault closed): the earlier steps are undone, newest first",
  "crash-resume": "Killed right after the swap was sent; resumed from the journal, swap not sent twice",
};

export type RunParams = { mode: "plan"; amount: string } | { mode: "recorded"; which: (typeof WHICH)[number] };

export function parseRun(url: URL): RunParams {
  const q = url.searchParams;
  const mode = q.get("mode") ?? "plan";
  if (mode === "recorded") {
    const which = (q.get("which") ?? "forced-failure") as (typeof WHICH)[number];
    if (!WHICH.includes(which)) throw new InputError(`which must be one of ${WHICH.join(", ")}`);
    return { mode, which };
  }
  if (mode !== "plan") throw new InputError("mode must be plan or recorded");
  const amount = (q.get("amount") ?? "0.001").trim();
  if (!/^\d{1,3}(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 0.01) throw new InputError("amount must be a WPHRS amount above 0 and at most 0.01 (our test pool holds 0.005 WPHRS)");
  return { mode, amount };
}

export async function run(p: RunParams, emit: Emit): Promise<void> {
  const t0 = Date.now();
  const s = stepper(emit);
  if (p.mode === "recorded") {
    emit({ type: "start", network: "atlantic", mode: "recorded replay" });
    s.begin("replay");
    const rows = RECORDED[p.which]!;
    s.end("replay", "ok", `${rows.length} journal lines`);
    const failed = rows.some((r) => r.event === "FAILED" || r.event === "REFUSED");
    const view: View = {
      tone: failed ? "warn" : "ok",
      verdict: `RECORDED run: ${TITLE[p.which]}`,
      note: "This is a replay of a run recorded earlier on Atlantic with the saga wallet's key (the page has no key and sends nothing). Every transaction hash links to the explorer. The pool and the vault are our own test contracts: Atlantic has none.",
      tables: [{ head: ["Time (UTC)", "Step", "Event", "Detail"], rows: rows.map((r) => [r.time, r.step, r.event, r.tx ? { t: r.detail.length > 150 ? `${r.detail.slice(0, 149)}…` : r.detail, href: explorerTx("atlantic", r.tx) } : r.detail]) }],
      evidence: [["Source", `tasks/saga-executor/proof/${p.which === "crash-resume" ? "crash-resume-1-killed.txt + crash-resume-3-resumed.txt" : `${p.which}.txt`}`], ["Network", "Pharos Atlantic testnet (recorded)"], ["Pool", { t: POOL, href: `https://atlantic.pharosscan.xyz/address/${POOL}` }], ["Vault", { t: VAULT, href: `https://atlantic.pharosscan.xyz/address/${VAULT}` }]],
      summary: `Recorded replay: ${TITLE[p.which]}.`,
    };
    emit({ type: "done", totalMs: Date.now() - t0, view });
    return;
  }
  emit({ type: "start", network: "atlantic", endpoint: "public Atlantic RPC" });
  const call = atlanticRpcCall();
  let open: boolean;
  let out: bigint;
  try {
    s.begin("vault");
    open = BigInt((await call("eth_call", { transaction: { to: VAULT, data: encodeFunctionData({ abi: vaultAbi, functionName: "open" }) } })).result as Hex) === 1n;
    s.end("vault", "ok", open ? "open" : "CLOSED");
    s.begin("quote");
    out = BigInt((await call("eth_call", { transaction: { to: POOL, data: encodeFunctionData({ abi: poolAbi, functionName: "quote", args: [WPHRS.address, parseUnits(p.amount, WPHRS.decimals)] }) } })).result as Hex);
    s.end("quote", "ok", `${formatUnits(out, USDC.decimals)} USDC`);
  } catch (e) {
    s.end(s.current ?? "vault", "failed", (e as Error).message.slice(0, 160));
    throw e;
  }
  const usdc = formatUnits(out, USDC.decimals);
  const view: View = {
    tone: open ? "ok" : "warn",
    verdict: open ? `Plan: ${p.amount} WPHRS → ${usdc} USDC → vault (the vault is open)` : `Plan: the vault is CLOSED, so step 4 would fail and the saga would roll back`,
    note: "A live, keyless read of our own Atlantic test pool and vault through the public RPC, then the plan the saga would follow. Nothing is signed or sent: running it needs the saga wallet's key, so use the recorded runs below to see the steps happen.",
    tables: [{ head: ["#", "Step", "What", "Verified by"], rows: [
      ["1", "approve-in", `approve the pool to pull ${p.amount} WPHRS`, "allowance read back"],
      ["2", "swap", `swap it for ${usdc} USDC (pool quote)`, "Swap event + balances read back"],
      ["3", "approve-out", "approve the vault to pull that USDC", "allowance read back"],
      ["4", "deposit", "deposit it into the vault", "vault balance read back"],
      ["↩", "rollback", "undo, newest first: withdraw → revoke vault allowance → swap back → revoke pool allowance", "balances read back against the start"],
    ] }],
    evidence: [["Pool", { t: POOL, href: `https://atlantic.pharosscan.xyz/address/${POOL}` }], ["Vault", { t: VAULT, href: `https://atlantic.pharosscan.xyz/address/${VAULT}` }], ["Vault state", open ? "open" : "CLOSED"], ["Signed", "nothing: this page has no key"]],
    summary: `Plan read live from Atlantic: ${p.amount} WPHRS → ${usdc} USDC, vault ${open ? "open" : "closed"}.`,
  };
  emit({ type: "done", totalMs: Date.now() - t0, view });
}

const gate = concurrencyGate(2);

export function handle(req: Request): Promise<Response> {
  return guard(async () => {
    const url = new URL(req.url);
    const action = actionOf(url, ["info", "run"] as const, "info");
    if (action === "info") return json({ task: "saga-executor", modes: ["plan (live, keyless)", "recorded (replay of three Atlantic runs)"], recorded: WHICH, deploy: deployInfo() });
    const p = parseRun(url);
    if (!gate.take()) return busy();
    return ndjson((emit) => run(p, emit), gate.release);
  });
}
