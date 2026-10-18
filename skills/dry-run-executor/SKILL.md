---
name: dry-run-executor
description: >
  Simulate a transaction on Pharos Atlantic testnet before sending it. Use when the user wants to know whether a transfer
  or contract call would succeed or revert, what it would cost in PHRS, and what it would change (balances before and
  after), or says "dry run this", "simulate before I send", "will this fail?". A failing simulation blocks the send
  automatically: nothing is signed. A passing one can be sent with --execute and is then compared with the receipt.
version: 0.1.0
requires:
  anyBins:
  - node
  - npm
---

# Dry-Run Executor

Simulates with `eth_call` and `estimate_gas` through the Pharos Chain MCP. The simulation never broadcasts.

## Setup (once)

```bash
git clone https://github.com/edycutjong/pharos-beacon && cd pharos-beacon && npm ci
npm run setup:mcp        # builds the open-source pharos-mcp server for Atlantic (keyless reads)
```

The sender is the address of `PRIVATE_KEY` in `~/.config/pharos/testnet.env`; to simulate another sender pass `--from 0x…`
(simulation only). Never type a key into a command.

## Workflow

1. **Collect the transaction.** A PHRS transfer (`--to`, `--value`), an ERC-20 transfer (`--token USDC|USDT|WBTC|WETH|WPHRS --to --amount`)
   or raw calldata (`--to` the contract, `--data 0x…`, optional `--value`). Ask for anything missing.
2. **Simulate first, always** (sends nothing):
   ```bash
   npm run dry-run-executor -- --to <0x…> --value <PHRS>
   ```
3. **Read the verdict to the user:** WOULD SUCCEED or WOULD FAIL with the reason (decoded revert reason, a node refusal such as
   insufficient funds, or a failed gas estimate), the fee in PHRS, and the sender/recipient balances before → after.
4. **If it would fail, stop.** Exit code 3, nothing signed. Explain the reason and what to change. Do not retry with the same
   inputs or work around the block.
5. **Send only on explicit confirmation** of that exact transaction, after a WOULD SUCCEED:
   ```bash
   npm run dry-run-executor -- --to <0x…> --value <PHRS> --execute
   ```
   Report the explorer link and the "prediction vs receipt" lines (gas predicted vs used, balances predicted vs read back).

## Guardrails

- Atlantic testnet only. `--execute` always sends from your own key; `--from` cannot be combined with it.
- The "after" balances are a prediction from the call (value moves, a decoded ERC-20 `transfer` moves tokens); other
  state changes a contract makes are not predicted, and the report says "predicted", not "will be".
- A simulation reflects the chain at one block; a later transaction can change the outcome.
