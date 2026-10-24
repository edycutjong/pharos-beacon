---
name: arbitrage-scanner
description: >
  Compare one price across two sources on Pharos (a Uniswap-V3-style pool against a FaroSwap pool, or two test pools), net the
  swap fees, price impact, a slippage allowance and gas off the gross spread, and act only when the net profit clears a
  configurable threshold; otherwise log exactly why it skipped. Use when the user asks "is there an arbitrage", "is this spread
  worth taking after fees and gas", "scan two pools for a profitable round trip", "how often did this spread survive costs", or
  wants a backtest of a spread over the last day. Mainnet is read-only (a decision to act yields an unsigned plan); a trade runs
  only on Atlantic and only with --execute.
version: 0.1.0
requires:
  anyBins:
  - node
  - npm
---

# Arbitrage Scanner

One scan reads two sources through the Pharos Chain MCP, prices every round trip (buy the base token on one, sell it on the other) at several sizes in both directions, and decides on the best one. Every scan is appended to a JSONL log with the gross spread, each cost line, the net result and the decision.

## Setup (once)

```bash
git clone https://github.com/edycutjong/pharos-beacon && cd pharos-beacon && npm ci
npm run setup:mcp        # only for Atlantic: builds the public PharosNetwork/pharos-mcp server (pinned commit)
```

Mainnet scans need no key. The Atlantic trade uses `PRIVATE_KEY` in `~/.config/pharos/testnet.env`; never type a key into a command.

## Workflow

1. **Scan the real mainnet pair** (read-only, nothing signed):
   ```bash
   npm run arbitrage-scanner -- scan --min-profit 0.001 --slippage-bps 10
   ```
   Read the user the two sources and their mid prices, the best route, and the decision line. A SKIP says which cost ate the spread; an ACT prints an unsigned plan (legs, minimum out), never a signature.
2. **Change the threshold or sizes when asked** (`--min-profit`, `--sizes 0.01,0.05`, `--gas-units`); the same scan can ACT at one threshold and SKIP at another. Never lower a threshold to make a scan act.
3. **Backtest** a spread on real history (the same two sources and rule at pinned past blocks):
   ```bash
   npm run arbitrage-scanner -- backtest --hours 24 --every-min 60
   ```
   Report how many scans had a positive gross spread, how many survived costs, and the best net.
4. **Atlantic trade** (our own two ArbPool test pools; Atlantic has no DEX): scan first, and run only on the user's explicit go-ahead:
   ```bash
   npm run arbitrage-scanner -- scan --network atlantic            # prepares the plan, sends nothing
   npm run arbitrage-scanner -- scan --network atlantic --execute  # leg 1, a fresh read of leg 2, leg 2 only if still profitable
   ```
   Report the explorer links, the USDC and WPHRS before and after, and predicted against realised net.

## How the decision is made

- gross = amount × (sell mid ÷ buy mid − 1); fees = nominal swap fee of each leg; impact = what the pool curves took beyond the fees; slippage buffer = `--slippage-bps` of the amount; gas = `--gas-units` × gas price, priced in USDC at the sell pool's mid.
- net = USDC back − USDC in − slippage buffer − gas, from the pools' own quotes. ACT only when the best net is positive and at least `--min-profit`.
- The Uniswap-style quote is exact inside the current tick range; a size that would leave it is refused, not guessed.

## Guardrails

- Mainnet (chain 1672) is read-only by construction; only the Atlantic signer exists, and it refuses other chains.
- `move-rate` moves the price of our own Atlantic test pool (the demonstration of a market move); do not use it unless the user asks.
- If a quote is refused or a read fails, the scan says so and skips: it never prices from a stale or guessed number.
