// Dry-Run Executor (Medium · 100 pts): simulates a transaction (eth_call + estimate_gas through the Chain MCP) and reports
// predicted success or revert (with the reason), the fee in PHRS and the balances before and after. A failed simulation
// blocks the send (exit 3, nothing signed). With --execute a passing one is sent and the receipt is compared with the prediction.
//   npm run dry-run-executor -- --to 0x… --value 0.001 [--execute] [--proof name]
//   npm run dry-run-executor -- --token USDC --to 0x… --amount 1.5 [--execute] [--proof name]
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, isAddress, parseEther, parseUnits, type Hex } from "viem";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { explorerTx, TOKENS } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { dryRun, type DryRunResult, type Send } from "../../src/dryrun/run.js";
import { fmt, type SimRequest } from "../../src/dryrun/simulate.js";
import { secret } from "../../src/lib/env.js";
import { privateKeyToAccount } from "viem/accounts";

const TASK = "dry-run-executor";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TOKEN_NAMES = Object.keys(TOKENS.atlantic) as (keyof typeof TOKENS.atlantic)[];

const addr = (flag: string, v: string | undefined): Hex => {
  if (!v || !isAddress(v)) throw new UsageError(`${flag} must be a 0x address`);
  return getAddress(v);
};

export function formatResult(r: DryRunResult): string {
  const s = r.simulation;
  const out = [`simulation @ block ${s.block}: ${s.ok ? "WOULD SUCCEED" : `WOULD FAIL — ${s.failure}`}`];
  out.push(`  from ${s.request.from} → to ${s.request.to}${s.request.value ? ` · value ${formatEther(s.request.value)} PHRS` : ""}`);
  if (s.gas !== undefined) out.push(`  gas ${s.gas} × ${s.gasPriceWei} wei = ${formatEther(s.costWei!)} PHRS fee`);
  const note = s.ok ? "predicted" : "blocked: unchanged";
  for (const c of s.changes) out.push(`  ${c.who.padEnd(9)} ${fmt(c)} (${note})`);
  if (r.status === "blocked") out.push("BLOCKED: the simulation failed, so nothing was signed or sent");
  if (r.status === "simulated") out.push("not sent: pass --execute to send it");
  if (r.sent) out.push(`${r.status === "executed" ? "SENT" : "SENT but REVERTED"}: ${explorerTx("atlantic", r.sent.tx)} (block ${r.sent.block})`);
  if (r.accuracy) {
    const a = r.accuracy;
    out.push(`prediction vs receipt: gas ${a.gas.predicted} → ${a.gas.actual} used (${a.gas.errorPct}%) · fee ${formatEther(a.feeWei.predicted)} → ${formatEther(a.feeWei.actual)} PHRS`);
    for (const c of a.changes) out.push(`  ${c.who.padEnd(9)} ${c.asset}: predicted ${formatUnits(c.after, c.decimals)}, chain says ${formatUnits(c.actual, c.decimals)} (${c.delta === 0n ? "exact" : `off by ${formatUnits(c.delta, c.decimals)}`})`);
  }
  return out.join("\n");
}

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseCli(
    {
      usage: `npm run ${TASK} -- (--to 0x… --value <PHRS> | --token ${TOKEN_NAMES.join("|")} --to 0x… --amount <n>) [--data 0x…] [--from 0x…] [--execute] [--proof name]`,
      options: {
        to: { type: "string" }, value: { type: "string" }, token: { type: "string" }, amount: { type: "string" }, data: { type: "string" },
        from: { type: "string" }, execute: { type: "boolean", default: false }, proof: { type: "string" },
      },
    },
    argv,
  );
  const to = addr("--to", values.to);
  let req: SimRequest;
  const pk = secret("PRIVATE_KEY");
  const from = values.from ? addr("--from", values.from) : pk ? privateKeyToAccount(pk as Hex).address : undefined;
  if (!from) throw new UsageError("no sender: set PRIVATE_KEY (~/.config/pharos/testnet.env) or pass --from 0x…");
  if (values.execute && values.from) throw new UsageError("--from is for simulating another sender; --execute always sends from your own key");
  if (values.token) {
    if (values.value || values.data) throw new UsageError("--token takes --amount, not --value/--data");
    const name = choice("--token", values.token, TOKEN_NAMES);
    const tok = TOKENS.atlantic[name];
    if (!values.amount) throw new UsageError("--token needs --amount");
    let amount: bigint;
    try { amount = parseUnits(values.amount, tok.decimals); } catch { throw new UsageError(`--amount ${values.amount} is not a number`); }
    req = { from, to: tok.address as Hex, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }), token: { symbol: name, decimals: tok.decimals } };
  } else {
    if (values.amount) throw new UsageError("--amount is for --token; use --value for PHRS");
    let value = 0n;
    try { value = values.value ? parseEther(values.value) : 0n; } catch { throw new UsageError(`--value ${values.value} is not a number`); }
    if (!values.value && !values.data) throw new UsageError("give --value (PHRS) or --data, or use --token --amount");
    if (values.data && !/^0x([0-9a-fA-F]{2})*$/.test(values.data)) throw new UsageError("--data must be 0x hex bytes");
    req = { from, to, value, ...(values.data ? { data: values.data as Hex } : {}) };
  }

  const mcp: ChainMcp = await chainMcp("atlantic", { broadcast: values.execute });
  onExit(() => mcp.close());
  const send: Send = async (r, gas) => {
    const signer = testnetSigner(mcp);
    const signed = await signer.send({ to: r.to, value: r.value, ...(r.data ? { data: r.data } : {}), gas });
    const rc = await signer.waitForReceipt(signed.hash);
    return { tx: signed.hash, status: rc.status, block: rc.blockNumber.toString(), gasUsed: rc.gasUsed, ...(rc.effectiveGasPrice !== undefined ? { effectiveGasPrice: rc.effectiveGasPrice } : {}) };
  };
  const result = await dryRun(mcp.call, req, { execute: values.execute!, send });
  console.log(formatResult(result));
  if (values.proof) {
    console.log(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), { result }, proofMeta(TASK, mcp))}`);
  }
  if (result.status === "blocked") return 3;
  return result.status === "reverted" ? 1 : 0;
}

if (isMain(import.meta.url)) await runCli(main);
