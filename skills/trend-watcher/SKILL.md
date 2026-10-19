---
name: trend-watcher
description: >
  Watch a number on Pharos over time and act only when a trend is confirmed, never on one noisy reading. Use when the user
  wants "alert me when X has fallen N times in a row", to track a wallet balance, a token's total supply or the base fee
  across runs, or to see the stored history and the exact observation where a trend was met. It keeps its history in a
  file between runs, stores each block once, and a single spike does not trigger it.
version: 0.1.0
requires:
  anyBins:
  - node
  - npm
---

# Trend Watcher

A skill with memory. Every run reads ONE observation through the Pharos Chain MCP (`get_block_number`, then `get_balance`,
`eth_call` totalSupply or `get_block` at that block), appends it to the history file, and acts only when the stored history
shows `--steps` consecutive moves in one direction. A move is strictly lower (or higher with `--direction rise`); a flat
step or a move the other way resets the streak.

## Setup (once)

```bash
git clone https://github.com/edycutjong/pharos-beacon && cd pharos-beacon && npm ci
npm run setup:mcp        # only for Atlantic (testnet); mainnet (--network pharos) is keyless
```

## Workflow

1. **Collect:** the metric (`balance --address 0x…`, `supply --token 0x… [--decimals 18]`, or `basefee`), the network, the
   direction and the number of consecutive moves (`--steps`, at least 2, so a trend always needs at least 3 observations).
2. **Observe on a schedule** (every run adds one reading):
   ```bash
   npm run trend-watcher -- observe --metric balance --address <0x…> --network atlantic --steps 3 --direction fall
   ```
3. **Show the history** when asked: `npm run trend-watcher -- history <same flags>`. It lists every stored observation with its
   block, the move, the streak, the exact row where the rule was met (`◀ TREND MET`) and a sparkline.
4. **Report** what the run did: stored / de-duplicated, the streak, and when the trend was met the slope (per observation and per
   block). Add `--discord` to send the trigger to the alert webhook instead of the console.

## Guardrails

- The default history file (`tasks/trend-watcher/state/history.json`) belongs to ONE metric; give each metric its own `--state <file>`; a different metric is refused, a corrupt file is refused, never guessed at.
- The same block is stored once (`--block N` re-reads a block and is de-duplicated); an older block is refused.
- The action runs once per trend. A crash between the action and its record can repeat that one alert, never lose it.
- A trigger needs the full streak in the stored history: do not lower `--steps` to make something fire, and say plainly when the
  metric is flat (a flat metric never triggers).
