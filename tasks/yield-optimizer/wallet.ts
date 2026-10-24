// The owner's wallet, as a stand-in for MetaMask on Atlantic testnet. The Yield Optimizer (index.ts, src/yield/) only PREPARES
// transactions; this is the separate step where the owner looks at a prepared plan and signs it. It is the only file of this task
// that reads a key (PRIVATE_KEY_2 from ~/.config/pharos/testnet.env, the user's own testnet wallet), it refuses a plan that was
// not made for that wallet or that was altered after it was prepared, and it signs nothing without --execute.
//   npm run yield-wallet -- sign plan.json [--execute] [--proof name]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, type Hex } from "viem";
import { isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { atlantic, explorerTx } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { planFingerprint, type MovePlan } from "../../src/yield/plan.js";
import { rd } from "../../src/yield/sources.js";

const TASK = "yield-optimizer";
const HERE = fileURLToPath(new URL(".", import.meta.url));

export async function main({ onExit }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    { usage: "npm run yield-wallet -- sign plan.json [--execute] [--proof name]", options: { execute: { type: "boolean", default: false }, proof: { type: "string" }, "key-var": { type: "string", default: "PRIVATE_KEY_2" } }, positionals: [2, 2] },
    argv,
  );
  if (positionals[0] !== "sign") throw new UsageError("the only command is: sign plan.json");
  const plan = JSON.parse(readFileSync(positionals[1]!, "utf8")) as MovePlan;
  if (plan.kind !== "unsigned-move-plan" || plan.signed !== false) throw new UsageError("not an unsigned move plan");
  if (plan.chainId !== atlantic.id) throw new UsageError(`this wallet signs for Atlantic (${atlantic.id}) only; the plan is for chain ${plan.chainId}`);
  if (planFingerprint(plan.transactions) !== plan.planId) throw new UsageError("the plan was changed after it was prepared (its fingerprint does not match): refusing to sign");

  const mcp = await chainMcp("atlantic", { broadcast: values.execute });
  onExit(() => mcp.close());
  const signer = testnetSigner(mcp, { envVar: values["key-var"]! });
  if (signer.address.toLowerCase() !== plan.wallet.toLowerCase()) throw new UsageError(`the plan is for ${plan.wallet} but this wallet is ${signer.address}: not signing`);
  const call = mcp.call.bind(mcp) as typeof mcp.call;
  const usdc = plan.transactions[1]!.request.to as Hex; // the approve goes to the asset
  const bal = async (a: Hex) => (await rd(call, a, "balanceOf(address) view returns (uint256)", [signer.address])) as bigint;
  const share = async (c: Hex) => (await rd(call, c, "balanceOf(address) view returns (uint256)", [signer.address])) as bigint;
  const snapshot = async () => ({ usdc: await bal(usdc), from: await share(plan.from.contract), to: await share(plan.to.contract) });

  console.log(`wallet ${signer.address} · plan ${plan.planId} · ${plan.from.name} → ${plan.to.name} · Atlantic`);
  for (const t of plan.transactions) console.log(`  ${t.step}. ${t.description} · to ${t.request.to} · gas ${t.gas.units} (${t.gas.basis})`);
  const before = await snapshot();
  console.log(`before: wallet USDC ${formatUnits(before.usdc, 6)} · ${plan.from.name} shares ${before.from} · ${plan.to.name} shares ${before.to}`);
  if (!values.execute) {
    console.log("not signed: add --execute to sign and send these transactions with this wallet");
    return 0;
  }
  const sent: { step: number; action: string; hash: Hex; explorer: string; status: string; block: string; gasUsed: string; effectiveGasPrice: string | null }[] = [];
  for (const t of plan.transactions) {
    const s = await signer.send({ to: t.request.to, data: t.request.data });
    const r = await signer.waitForReceipt(s.hash);
    console.log(`  ${t.step}. ${t.action} ${r.status} in block ${r.blockNumber}, gas used ${r.gasUsed}: ${explorerTx("atlantic", s.hash)}`);
    sent.push({ step: t.step, action: t.action, hash: s.hash, explorer: explorerTx("atlantic", s.hash), status: r.status, block: r.blockNumber.toString(), gasUsed: r.gasUsed.toString(), effectiveGasPrice: r.effectiveGasPrice?.toString() ?? null });
    if (r.status !== "success") {
      console.log("a step reverted: stopping here; nothing further was signed");
      break;
    }
  }
  const after = await snapshot();
  console.log(`after:  wallet USDC ${formatUnits(after.usdc, 6)} · ${plan.from.name} shares ${after.from} · ${plan.to.name} shares ${after.to}`);
  const ok = sent.length === plan.transactions.length && sent.every((s) => s.status === "success") && after.to > before.to;
  if (values.proof) {
    const meta = proofMeta(TASK, mcp);
    const lines = { plan, before: { usdc: before.usdc.toString(), from: before.from.toString(), to: before.to.toString() }, after: { usdc: after.usdc.toString(), from: after.from.toString(), to: after.to.toString() }, sent, ok };
    console.log(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), lines as unknown as Record<string, unknown>, meta)}`);
    writeFileSync(join(HERE, "proof", `${values.proof}.txt`), sent.map((s) => `${s.step}. ${s.action} ${s.status} gas ${s.gasUsed}: ${s.explorer}`).join("\n") + "\n");
  }
  return ok ? 0 : 1;
}

if (isMain(import.meta.url)) await runCli(main);
