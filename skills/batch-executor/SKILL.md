---
name: batch-executor
description: >
  Bundle several independent actions (PHRS or ERC-20 sends) into ONE transaction on Pharos Atlantic testnet through Multicall3.
  Use when the user wants to send to several recipients at once, "batch these transfers", "do these in one transaction",
  or asks what batching saves. Reports the gas against sending one by one and the steps saved, and when one action fails
  names it and says what happened to the rest. Dry-runs everything first; nothing is sent without --execute.
version: 0.1.0
requires:
  anyBins:
  - node
  - npm
---

# Batch Executor

One Multicall3 `aggregate3Value` transaction, every call with `allowFailure`, so one failing action does not undo the others.

## Setup (once)

```bash
git clone https://github.com/edycutjong/pharos-beacon && cd pharos-beacon && npm ci
npm run setup:mcp        # builds the open-source pharos-mcp server for Atlantic (keyless reads)
```

The sender is the address of `PRIVATE_KEY` in `~/.config/pharos/testnet.env`. Never type a key into a command.

## Workflow

1. **Collect the actions** (at least 3, each with its own recipient) into a plan file, like `tasks/batch-executor/plans/all-success.json`:
   `{"type":"native","to":"0x…","value":"0.0001"}` or `{"type":"erc20","token":"WPHRS","to":"0x…","amount":"0.0001"}`.
2. **Simulate first** (sends nothing):
   ```bash
   npm run batch-executor -- --plan <file.json>      # add --from 0x… to simulate as another address without a key
   ```
3. **Read the simulation to the user:** per action WOULD SUCCEED or WOULD FAIL with the reason, each action's gas alone, and the batch's gas.
4. **Failing actions.** A failing PHRS action blocks the batch (its PHRS would stay stuck in Multicall3). Offer `--drop-failing`, which removes the failing actions and simulates the rest again. Do not work around a block.
5. **Send only on explicit confirmation** of that exact plan. Token actions need an allowance to Multicall3; `--approve` raises it to exactly the batch total:
   ```bash
   npm run batch-executor -- --plan <file.json> --approve [--drop-failing] --execute
   ```
6. **Report** the explorer link, each action APPLIED / NOT APPLIED with its reason, and the `gas:` and `steps:` lines. Say that the "alone" figures are estimates.

## Guardrails

- Atlantic testnet only; the signer refuses any other chain. Exit codes: 0 all applied · 4 sent, some actions failed · 3 nothing sent (blocked) · 1 mined revert · 2 bad plan.
- An allowance to Multicall3 can be used by anyone routing a call through it: keep it exact and small, and never approve it on a wallet with real funds.
- "What happened to each action" is read from the recipients' balances afterwards, since Multicall3 emits no per-action event.
