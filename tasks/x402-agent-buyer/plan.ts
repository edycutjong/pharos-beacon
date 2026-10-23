// The demo tasks: what the agent is asked to do, what each answer is worth to it, and its money limits.
// Prices (USDC): gas-snapshot 0.001 · whale-brief 0.01 · whale-range 0.005 per started 1,000 blocks (see x402-paywalled-api/config.ts).
import type { Policy, Want } from "./agent.js";

const u = (usdc: string) => BigInt(Math.round(Number(usdc) * 1e6));

export interface Task { id: string; goal: string; policy: Policy; wants: Want[] }

export const TASKS: Record<string, Task> = {
  // Completes: two purchases, two questions it already has the answer to (U1: one is asked through a different route), one
  // answer it finds not worth its price.
  finish: {
    id: "finish",
    goal: "Is it a good time to move USDC on Atlantic, and who is moving big USDC on Pharos mainnet?",
    policy: { budget: u("0.05"), perCallCap: u("0.02") },
    wants: [
      { id: "gas", path: "gas-snapshot", purpose: "Atlantic gas price now, to cost the transfer", maxWorth: u("0.002") },
      { id: "whales", path: "whale-brief", purpose: "largest USDC transfers on Pharos mainnet, last ~1,000 blocks", maxWorth: u("0.02"), top: 3 },
      { id: "whales-1k", path: "whale-range?blocks=1000", purpose: "the same 1,000 blocks through the other whale route", maxWorth: u("0.01") },
      { id: "gas-again", path: "gas-snapshot", purpose: "gas price again, to decide when to send", maxWorth: u("0.002") },
      { id: "deep-history", path: "whale-range?blocks=3000", purpose: "three windows of whale history (nice to have)", maxWorth: u("0.01"), optional: true },
    ],
  },
  // Stops: the third answer would take the spend over the budget.
  budget: {
    id: "budget",
    goal: "Same job on a 0.02 USDC budget: it runs out before the deep history.",
    policy: { budget: u("0.02"), perCallCap: u("0.02") },
    wants: [
      { id: "gas", path: "gas-snapshot", purpose: "Atlantic gas price now", maxWorth: u("0.002") },
      { id: "whales", path: "whale-brief", purpose: "largest USDC transfers on Pharos mainnet, last ~1,000 blocks", maxWorth: u("0.02") },
      { id: "history", path: "whale-range?blocks=3000", purpose: "whale history over 3,000 blocks", maxWorth: u("0.02") },
      { id: "summary-gas", path: "gas-snapshot", purpose: "fresh gas price for the report", maxWorth: u("0.002") },
    ],
  },
  // The per-call cap: the dear answer is refused whatever the budget says, the cheap ones go through.
  cap: {
    id: "cap",
    goal: "A 0.012 USDC cap per call with plenty of budget: the 0.015 answer is refused.",
    policy: { budget: u("0.05"), perCallCap: u("0.012") },
    wants: [
      { id: "gas", path: "gas-snapshot", purpose: "Atlantic gas price now", maxWorth: u("0.002") },
      { id: "history", path: "whale-range?blocks=3000", purpose: "whale history over 3,000 blocks", maxWorth: u("0.02"), optional: true },
      { id: "whales", path: "whale-brief", purpose: "largest USDC transfers on Pharos mainnet, last ~1,000 blocks", maxWorth: u("0.02") },
    ],
  },
  // One purchase, for the retry proofs (--simulate-failure before|after).
  retry: {
    id: "retry",
    goal: "One purchase, with a network failure after the payment is signed.",
    policy: { budget: u("0.01"), perCallCap: u("0.01") },
    wants: [{ id: "gas", path: "gas-snapshot", purpose: "Atlantic gas price now", maxWorth: u("0.002") }],
  },
};
