---
name: gas-fee-optimizer
description: >
  Time a non-urgent transaction on Pharos Atlantic testnet for the lowest gas price within a deadline. Use when the user
  wants to track gas over time, see recent gas history, or "send this when gas is cheap but no later than X". It holds the
  transaction until the gas price is at or below a target (a fixed price, or a low percentile of recent samples) and ALWAYS
  sends at the deadline, then reports the gas paid against the price when the request was made.
version: 0.1.0
requires:
  anyBins:
  - node
  - npm
---

# Gas Fee Optimizer

Gas price = latest block base fee + priority fee, read through the Pharos Chain MCP (`get_block`, `get_gas_price`).

## Setup (once)

```bash
git clone https://github.com/edycutjong/pharos-beacon && cd pharos-beacon && npm ci
npm run setup:mcp        # builds the open-source pharos-mcp server for Atlantic
```

Sending needs `PRIVATE_KEY` in `~/.config/pharos/testnet.env`. Never type a key into a command.

## Workflow

1. **Collect:** recipient, amount (PHRS), the deadline in seconds from now, and the target: a fixed price in gwei, or a
   percentile of recent samples (e.g. 25 = send when gas is in the cheapest quarter of recent history).
2. **Show the history first:** `npm run gas-fee-optimizer -- sample --count 6 --interval 5` then `-- history`. Say plainly if gas is flat
   (Atlantic's usually is: then waiting cannot save anything).
3. **Run it without `--execute`** to see when it would send; **send only on explicit confirmation** of that recipient, amount and deadline:
   ```bash
   npm run gas-fee-optimizer -- send --to <0x…> --value <PHRS> --deadline <seconds> --target-gwei <n> --execute
   ```
4. **Report** why it sent (target reached, or deadline reached), the price at request vs the price paid, and the gas paid in PHRS.

## Guardrails

- The deadline always wins: at the deadline the transaction is sent whatever the price, including when gas reads are failing.
- A percentile target needs 5 samples of history first (one sample is always its own percentile); until then it keeps sampling.
- Atlantic testnet only. Do not lower the target to force an early send, and do not raise the deadline to wait for a better price without the user asking.
