import type { Hex } from "viem";
import { simulate, type BalanceChange, type Call, type SimRequest, type Simulation } from "./simulate.js";

// Orchestration: simulate → only a passing simulation may reach `send`. The one call to `send` is inside the ok branch
// below, so a failed simulation can never send (a test hands in a sender that throws).

export interface SendResult {
  tx: Hex;
  status: "success" | "reverted";
  block: string;
  gasUsed: bigint;
  effectiveGasPrice?: bigint;
}
export type Send = (req: SimRequest, gas: bigint) => Promise<SendResult>;

export interface Accuracy {
  gas: { predicted: bigint; actual: bigint; /** (actual − predicted) / predicted, percent with 2 decimals */ errorPct: string };
  feeWei: { predicted: bigint; actual: bigint };
  changes: (BalanceChange & { actual: bigint; delta: bigint })[];
}

export interface DryRunResult {
  simulation: Simulation;
  /** "blocked" = the simulation failed and nothing was sent; "simulated" = passed, not sent (no --execute). */
  status: "blocked" | "simulated" | "executed" | "reverted";
  sent?: SendResult;
  accuracy?: Accuracy;
}

async function actualBalance(call: Call, c: BalanceChange, token: Hex | undefined): Promise<bigint> {
  if (c.asset === "PHRS") return BigInt((await call("get_balance", { address: c.address })).balanceWei);
  const data = `0x70a08231${c.address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
  return BigInt((await call("eth_call", { transaction: { to: token!, data } })).result);
}

export async function dryRun(call: Call, req: SimRequest, o: { execute: boolean; send?: Send }): Promise<DryRunResult> {
  const simulation = await simulate(call, req);
  if (!simulation.ok) return { simulation, status: "blocked" };
  if (!o.execute || !o.send) return { simulation, status: "simulated" };
  const sent = await o.send(req, simulation.gas!);
  if (sent.status === "reverted") return { simulation, status: "reverted", sent };
  const changes = await Promise.all(simulation.changes.map(async (c) => ({ ...c, actual: await actualBalance(call, c, req.to), delta: 0n })));
  for (const c of changes) c.delta = c.actual - c.after;
  const predicted = simulation.gas!;
  const bp = ((sent.gasUsed - predicted) * 10000n) / predicted; // basis points, truncated toward zero
  const sign = bp < 0n ? "-" : "";
  const abs = bp < 0n ? -bp : bp;
  const errorPct = `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
  const accuracy: Accuracy = {
    gas: { predicted, actual: sent.gasUsed, errorPct },
    feeWei: { predicted: simulation.costWei!, actual: sent.gasUsed * (sent.effectiveGasPrice ?? simulation.gasPriceWei) },
    changes,
  };
  return { simulation, status: "executed", sent, accuracy };
}
