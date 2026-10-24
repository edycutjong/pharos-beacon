---
name: saga-executor
description: >
  Run a multi-step, dependent on-chain workflow (approve, swap, approve, deposit) on Pharos Atlantic testnet where every step is
  verified before the next starts, transient failures are retried, and a permanent failure rolls back what already landed.
  Use when the user wants "approve then swap then deposit", a workflow "that must not leave funds stranded halfway", a rollback
  or compensation path, retry with backoff, or to resume a workflow that was interrupted. Never sends without --execute.
version: 0.1.0
requires:
  anyBins:
  - node
  - npm
---

# Saga Executor

A journaled saga against the repo's own test pool and vault on Atlantic (Atlantic has no DEX or vault; `tasks/saga-executor/contracts` holds the Solidity). The journal is written before every send, so a killed process resumes instead of repeating.

## Setup (once)

```bash
git clone https://github.com/edycutjong/pharos-beacon && cd pharos-beacon && npm ci
npm run setup:mcp        # builds the open-source pharos-mcp server for Atlantic
```

The saga wallet is `PRIVATE_KEY_2` in `~/.config/pharos/testnet.env`; the vault owner is `PRIVATE_KEY`. Never type a key into a command.

## Workflow

1. **Show the plan first** (sends nothing; reads the pool quote and whether the vault is open):
   ```bash
   npm run saga-executor -- plan --amount 0.001
   ```
2. **Run on explicit confirmation** of that amount:
   ```bash
   npm run saga-executor -- run --id <name> --execute [--proof <name>]
   ```
   Read the state log to the user as it prints: `step n/4`, SIGNED, SENT, MINED, VERIFIED per step.
3. **If the process was interrupted**, never run again with a new id. Resume:
   ```bash
   npm run saga-executor -- status --id <name>
   npm run saga-executor -- resume --id <name> --execute
   ```
4. **Report** the final status, the balance-invariant table (every touched balance against its pre-saga or expected value), the PHRS spent on gas (not refundable) and the explorer links.

## Retry and rollback policy

- **Transient** (node refused for a low fee, no receipt in time, throttled RPC): retried up to 3 sends, wait 2 s then 4 s, the SAME nonce with the fee raised 25% so at most one can land.
- **Permanent** (a revert, a receipt with status 0, a read-back that does not match, anything unrecognised): no retry; every step that landed is undone newest first, each undo verified.
- A rollback that itself fails permanently, or a step whose last send may still land, leaves the saga STUCK and names the action. It does not roll back while a send may still land. Fix the cause and run `resume --id <name> --execute`; do not start a new saga on that wallet until it is resolved.

## Guardrails

- Atlantic testnet only; the signer refuses any other chain. Exit codes: 0 completed · 3 rolled back cleanly (nothing stranded) · 1 stuck or error · 2 bad usage.
- Fault flags (`--inject drop:swap`, `underpriced:swap`, `crash:swap:sent`) exist to demonstrate recovery; do not use them unless the user asks for a demonstration.
- `--no-preflight` sends with a fixed gas limit so a failing step is mined with status 0 (for the demonstration of a mined failure).
- `vault close|open` is the owner's switch used to force the deposit to fail; leave the vault open.
