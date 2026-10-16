---
name: threshold-guardian
description: >
  Evaluate several on-chain conditions on Pharos together before deciding whether an action may fire. Use when the
  user wants to guard an action with conditions ("only send if my balance stays above X, gas is below Y and the
  recipient is not a contract"), check if it is safe to act right now, or get a pass/fail decision trace for a set of
  thresholds on Pharos mainnet or Atlantic testnet. Every condition is read live through the Pharos Chain MCP; the
  verdict is ALLOW only if every condition passes, and a condition whose read fails counts as a failure.
version: 0.1.0
requires:
  anyBins:
  - node
  - npm
---

# Threshold Guardian

Turns "do X only if A, B and C hold on-chain" into a JSON policy, evaluates every condition live through the
Pharos Chain MCP, and prints a decision trace: each condition's observed value, its threshold, PASS/FAIL, and the
final ALLOW/DENY. It fails closed. With `--execute` on Atlantic testnet it re-checks every condition right before
signing and confirms the receipt through the Chain MCP.

The decision logic is the point: one trigger is not enough, all conditions must hold at once.

## Setup (once)

The skill drives the CLI in the beacon repo. Run every `npm` command and `tasks/...` path below from the cloned repo
root. Needs Node (version in `.nvmrc`), npm and, for `setup:mcp`, git.

```bash
git clone https://github.com/edycutjong/pharos-beacon && cd pharos-beacon && npm ci
npm run setup:mcp        # only for Atlantic testnet: builds the open-source pharos-mcp server for local stdio use
```

- Mainnet reads go to the hosted keyless Chain MCP `https://mcp.pharos.xyz/mcp`. No key, no setup.
- Atlantic testnet reads use the same open-source server run locally, because the hosted one serves mainnet only.
- A key is needed to execute, and also to dry-run any Atlantic policy that uses `"$SELF"` (without it those conditions
  fail and the verdict is DENY). Mainnet policies and policies without `$SELF` dry-run with no key. Put `PRIVATE_KEY`
  in `~/.config/pharos/testnet.env` (loaded automatically) or export it in the session. Never type it into a command
  and never put it in a file that git tracks.

## Workflow

1. **Collect the conditions.** Map each of the user's conditions to a `kind` (table below). Ask for any missing
   threshold, address or network rather than guessing. Default network: `pharos` (mainnet, dry-run).
2. **Write the policy** to `tasks/threshold-guardian/policies/<name>.json`. Give each condition a `label` in plain words, because the trace
   prints it. Full schema: `references/policy.md`.
3. **Dry-run it first, always** (a policy that uses `"$SELF"` needs `PRIVATE_KEY` set for the dry-run too):
   ```bash
   npm run guard -- tasks/threshold-guardian/policies/<name>.json
   ```
4. **Explain the trace** to the user: which conditions passed, which failed and by how much, and the verdict.
5. **Execute only on explicit user confirmation**, only on Atlantic testnet, and only after a dry-run returned ALLOW
   (with `PRIVATE_KEY` set as above):
   ```bash
   npm run guard -- tasks/threshold-guardian/policies/<name>.json --execute --proof
   ```
   Report the tx link and the receipt status. `--proof` saves the policy plus full outcome as JSON to
   `tasks/threshold-guardian/proof/<policy-file-name>.<status>.json` inside the clone and overwrites a file with the same
   name, so give a new policy its own file name instead of re-running a shipped policy with `--proof`.

## Condition kinds

| `kind` | Checks | Chain MCP tool |
|---|---|---|
| `native_balance` | PROS/PHRS balance of an address vs a threshold | `get_balance` |
| `erc20_balance` | token balance vs a threshold; decimals read on-chain | `eth_call` (`balanceOf`, `decimals`) |
| `gas_price` | current gas price vs a gwei ceiling | `get_gas_price` |
| `is_contract` | address has (or has no) bytecode | `get_code` |
| `nonce_settled` | no pending transaction stuck for the address | `get_transaction_count` (latest + pending) |
| `log_activity` | number of events from a contract in the last N ≤ 1000 blocks, optionally one topic | `get_logs` |

Balance, code, `eth_call` and log reads are pinned to the block fetched at the start (`get_block_number`); gas price
and nonces are read live. Operators: `gte gt lte lt eq`. `"$SELF"` means the signing wallet (Atlantic only).

## Reading the result

| `status` | Meaning | Exit |
|---|---|---|
| `dry-run` | every condition passed; nothing was sent (no action, or no `--execute`) | 0 |
| `denied` | at least one condition failed or could not be read; nothing was sent | 1 |
| `aborted` | passed first, but a condition flipped at the pre-send re-check; nothing was sent | 1 |
| `executed` | re-check passed, transfer sent, receipt `success` | 0 |
| `reverted` | transfer sent but reverted on-chain | 1 |
| `error: …` | the run could not finish: the Chain MCP or its block number was unreachable, or `--execute` had no key (nothing sent); or the transfer was sent but no receipt appeared in time (check the explorer before retrying) | 1 |
| (exit 2) | the policy file is missing, unreadable or invalid; the message says why | 2 |

## Guardrails

- Actions are native transfers on Atlantic testnet only. The policy validator rejects a mainnet action, so mainnet
  policies are always dry-run.
- Never pass `--execute` without the user confirming that exact policy and amount.
- Amounts are decimal strings in whole units, never floats, and may not have more decimals than the unit allows,
  so nothing is rounded silently.
- If the Chain MCP cannot be reached, nothing is sent: a condition whose read fails counts as FAIL (so the verdict is
  DENY), and a failed connection or block-number read ends the run with `error: …` and exit 1. Do not retry with a
  different data source to force an ALLOW.

## Examples

Ready-made policies in `tasks/threshold-guardian/policies/`:

- `wpros-watch.json`: mainnet, 4 conditions, dry-run (no key needed). Good first run.
- `pay-when-safe.json`: Atlantic, 5 conditions, sends 0.001 PHRS when all pass (the "fires" case). Needs
  `PRIVATE_KEY` even for the dry-run, because two conditions use `"$SELF"`.
- `pay-when-safe-deny.json`: the same policy with a reserve the wallet cannot meet (the "holds" case).

Complements `pharos-skill-engine` (cast and forge commands): use that skill for one-off reads and writes, and this one
when an action must be gated on several conditions at once.
