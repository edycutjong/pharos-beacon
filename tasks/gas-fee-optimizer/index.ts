// Gas Fee Optimizer (Medium · 100 pts): tracks Atlantic gas over time (base fee + priority fee via the Chain MCP), shows the
// recent history, and holds a transaction until gas is at or below your target or your deadline, whichever comes first.
// At the deadline it sends whatever the price. Then it reports what was paid against the price when you asked.
//   npm run gas-fee-optimizer -- sample [--count 6] [--interval 5]
//   npm run gas-fee-optimizer -- history [--last 10]
//   npm run gas-fee-optimizer -- send --to 0x… --value 0.0001 --deadline 90 (--target-gwei 1.2 | --target-percentile 25 [--window 20]) [--interval 5] [--lead 8] [--execute] [--proof name]
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, formatGwei, getAddress, isAddress, parseEther, parseGwei, type Hex } from "viem";
import { envOr } from "../../src/lib/env.js";
import { isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { explorerTx } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { withLock } from "../../src/lib/state.js";
import { deadlineGap, historyTable, holdUntilFavourable, loadSamples, paidReport, saveSample, takeSample, type Target } from "../../src/gas/optimizer.js";

const TASK = "gas-fee-optimizer";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const num = (flag: string, v: string | undefined, min: number, fallback?: number): number => {
  const n = v === undefined ? fallback : Number(v);
  if (n === undefined || !Number.isFinite(n) || n < min) throw new UsageError(`${flag} must be a number ≥ ${min}`);
  return n;
};

export async function main({ onExit, signal }: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- sample|history|send [flags]  (send: --to 0x… --value <PHRS> --deadline <seconds> (--target-gwei <n> | --target-percentile <1-100> [--window N]) [--interval s] [--lead s] [--execute] [--proof name])`,
      options: {
        count: { type: "string" }, interval: { type: "string" }, last: { type: "string" },
        to: { type: "string" }, value: { type: "string" }, deadline: { type: "string" }, lead: { type: "string" },
        "target-gwei": { type: "string" }, "target-percentile": { type: "string" }, window: { type: "string" },
        execute: { type: "boolean", default: false }, proof: { type: "string" },
        // GAS_STATE: another history file (a recording that must not touch the committed one).
        state: { type: "string", default: envOr("GAS_STATE", join(HERE, "state/gas.json")) },
      },
      positionals: [1, 1],
    },
    argv,
  );
  const cmd = positionals[0];
  const stateFile = values.state!;

  if (cmd === "history") {
    console.log(historyTable(loadSamples(stateFile), num("--last", values.last, 1, 10)));
    return 0;
  }
  if (cmd !== "sample" && cmd !== "send") throw new UsageError(`unknown command ${cmd}: use sample, history or send`);

  const interval = num("--interval", values.interval, 1, 5);
  let to: Hex | undefined, wei = 0n, deadlineS = 0, leadS = 0, target: Target | undefined;
  if (cmd === "send") {
    if (!values.to || !isAddress(values.to)) throw new UsageError("--to must be a 0x address");
    to = getAddress(values.to);
    try { wei = parseEther(values.value ?? ""); } catch { throw new UsageError("--value must be an amount of PHRS, e.g. 0.0001"); }
    deadlineS = num("--deadline", values.deadline, 1);
    // default: 8 s, but never more than half of a short deadline, so `--deadline 6` works without a flag the user never passed
    leadS = num("--lead", values.lead, 0, Math.min(8, deadlineS / 2));
    if (leadS >= deadlineS) throw new UsageError("--lead must be shorter than --deadline");
    if (!!values["target-gwei"] === !!values["target-percentile"]) throw new UsageError("give exactly one of --target-gwei or --target-percentile");
    if (values["target-gwei"]) {
      try { target = { kind: "price", wei: parseGwei(values["target-gwei"]) }; } catch { throw new UsageError("--target-gwei must be a number, e.g. 1.2"); }
    } else {
      const p = num("--target-percentile", values["target-percentile"], 1);
      if (p > 100) throw new UsageError("--target-percentile must be 1–100");
      target = { kind: "percentile", p, window: Math.floor(num("--window", values.window, 1, 20)) };
    }
  }

  const mcp = await chainMcp("atlantic", { broadcast: cmd === "send" && values.execute });
  onExit(() => mcp.close());
  // Taken before the run touches state/gas.json: the proof's `dirty` is about the code, not about this run's own samples.
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined;
  const sampleOnce = () => takeSample(mcp.call);

  if (cmd === "sample") {
    const n = Math.floor(num("--count", values.count, 1, 6));
    await withLock(stateFile, async () => {
      for (let i = 0; i < n && !signal.aborted; i++) {
        const s = saveSample(stateFile, await sampleOnce()).at(-1)!;
        console.log(`${s.at.slice(11, 19)} block ${s.block} price ${formatGwei(BigInt(s.priceWei))} gwei (base ${formatGwei(BigInt(s.baseFeeWei))} + priority ${formatGwei(BigInt(s.priorityWei))})`);
        if (i < n - 1) await new Promise((r) => setTimeout(r, interval * 1000));
      }
    });
    console.log(historyTable(loadSamples(stateFile)));
    return 0;
  }

  const deadline = new Date(Date.now() + deadlineS * 1000);
  // The send itself (nonce, gas estimate, broadcast, block) takes a few seconds, so the hold ends `--lead` seconds early:
  // the transaction is broadcast, and normally mined, before the deadline instead of after it.
  const decideBy = new Date(deadline.getTime() - leadS * 1000);
  console.log(`request: send ${formatEther(wei)} PHRS to ${to} · target ${target!.kind === "price" ? `${formatGwei(target!.wei)} gwei` : `p${target!.p} of the last ${target!.window} samples`} · deadline ${deadline.toISOString().slice(11, 19)}Z (${deadlineS}s) · send decided by ${decideBy.toISOString().slice(11, 19)}Z (${leadS}s lead)`);
  const decision = await withLock(stateFile, () => holdUntilFavourable({ deadline: decideBy, target: target!, intervalMs: interval * 1000, stateFile, sample: sampleOnce, log: (l) => console.log(`  ${l}`) }));
  // with a lead, "the deadline" is not what ended the hold: the send-by time (deadline − lead) is
  const why = decision.reason === "deadline reached" && leadS > 0 ? "send-by time reached (deadline − lead)" : decision.reason;
  console.log(`decision: send now — ${why} after ${(decision.heldMs / 1000).toFixed(1)}s (${decision.samplesTaken} samples${decision.sampleErrors ? `, ${decision.sampleErrors} failed` : ""})`);
  console.log(historyTable(loadSamples(stateFile), 6));

  let result: Record<string, unknown> = { sent: false };
  if (values.execute) {
    const signer = testnetSigner(mcp);
    const signed = await signer.send({ to: to!, value: wei });
    const broadcastAt = new Date();
    console.log(`broadcast ${(Math.abs(deadline.getTime() - broadcastAt.getTime()) / 1000).toFixed(1)}s ${broadcastAt <= deadline ? "before" : "AFTER"} the deadline (${broadcastAt.toISOString().slice(11, 23)}Z)`);
    const r = await signer.waitForReceipt(signed.hash);
    // Block time is whole seconds: say it as the chain does.
    const mined = await mcp.call("get_block", { block: r.blockNumber.toString() }).then((b) => (b ? new Date(Number(BigInt(b.timestamp)) * 1000) : null), () => null);
    if (mined) {
      const gap = deadlineGap(deadline, mined);
      console.log(`mined in block ${r.blockNumber} at ${mined.toISOString().slice(11, 19)}Z, ${gap.side === "same second as" ? "in the same second as" : `${gap.seconds}s ${gap.side}`} the deadline (${deadline.toISOString().slice(11, 19)}Z, whole seconds)`);
    }
    console.log(`${r.status === "success" ? "SENT" : "SENT but REVERTED"}: ${explorerTx("atlantic", signed.hash)} (block ${r.blockNumber}, gas used ${r.gasUsed})`);
    const eff = r.effectiveGasPrice ?? decision.requestPriceWei;
    const rep = paidReport(r.gasUsed, eff, decision.requestPriceWei);
    console.log(`price at request ${formatGwei(decision.requestPriceWei)} gwei · price paid ${formatGwei(eff)} gwei · gas paid ${formatEther(rep.paidWei)} PHRS vs ${formatEther(rep.atRequestPriceWei)} PHRS at the request price (${rep.savedWei >= 0n ? "saved" : "paid more"} ${formatEther(rep.savedWei < 0n ? -rep.savedWei : rep.savedWei)} PHRS, ${rep.savedPct}%)`);
    result = { sent: true, tx: signed.hash, status: r.status, block: r.blockNumber.toString(), broadcastMsBeforeDeadline: deadline.getTime() - broadcastAt.getTime(), minedAt: mined?.toISOString() ?? null, gasUsed: r.gasUsed.toString(), effectiveGasPriceWei: eff.toString(), paid: rep };
    if (r.status === "reverted") return 1;
  } else console.log("not sent: pass --execute to send");

  if (values.proof) {
    const samples = loadSamples(stateFile);
    console.log(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), { request: { to, valueWei: wei.toString(), deadlineSeconds: deadlineS, leadSeconds: leadS, target }, decision, history: samples.slice(-Math.max(decision.samplesTaken, 1)), result }, meta!)}`);
  }
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
