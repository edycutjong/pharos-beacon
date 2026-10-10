import { parseEther, type Hex } from "viem";
import { evaluate, type Verdict } from "./evaluate.js";
import type { Policy } from "./policy.js";
import type { Reader } from "./reader.js";

export interface Signer {
  address: Hex;
  sendNative(to: Hex, value: bigint): Promise<Hex>;
}

export type Outcome =
  | { status: "denied"; verdict: Verdict }
  | { status: "dry-run"; verdict: Verdict }
  | { status: "aborted"; verdict: Verdict; recheck: Verdict }
  | { status: "executed"; verdict: Verdict; recheck: Verdict; tx: Hex; receipt: { status: string; blockNumber: string } };

export interface GuardOptions {
  execute?: boolean;
  receiptPolls?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Evaluate the policy; act only on ALLOW. Before broadcasting, the policy is evaluated a second time at the
 * newest block so a condition that flipped between the first check and signing still blocks the action.
 */
export async function guard(policy: Policy, reader: Reader, signer: Signer | undefined, opts: GuardOptions = {}): Promise<Outcome> {
  const verdict = await evaluate(policy, reader, signer?.address);
  if (!verdict.allow) return { status: "denied", verdict };
  if (!policy.action || !opts.execute) return { status: "dry-run", verdict };
  if (!signer) throw new Error("--execute needs a signing wallet (PRIVATE_KEY)");

  const recheck = await evaluate(policy, reader, signer.address);
  if (!recheck.allow) return { status: "aborted", verdict, recheck };

  const { to, amount } = policy.action;
  const tx = await signer.sendNative(to === "$SELF" ? signer.address : to, parseEther(amount));

  // Confirm through the same Chain MCP the conditions were read from.
  const sleep = opts.sleep ?? wait;
  for (let i = 0; i < (opts.receiptPolls ?? 30); i++) {
    const r = await reader.receipt(tx).catch(() => null);
    if (r) return { status: "executed", verdict, recheck, tx, receipt: { status: r.status, blockNumber: r.blockNumber.toString() } };
    await sleep(opts.pollMs ?? 2000);
  }
  throw new Error(`tx ${tx} sent but no receipt after polling — check the explorer before retrying`);
}
