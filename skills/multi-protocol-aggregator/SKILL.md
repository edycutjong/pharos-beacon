---
name: multi-protocol-aggregator
description: >
  Query and act across several Pharos mainnet protocols (the RockawayX USDC vault, Morpho Blue USDC markets, the Centrifuge
  JTRSY/HYB fund vaults) through one interface: show a wallet's positions and every venue's rate, route a USDC deposit or
  withdrawal to the best venue and explain why, and prepare the unsigned transactions. Use when the user asks "where should I put
  250 USDC", "where do I take money out of", "compare my positions across protocols", or wants a deposit or withdrawal prepared
  for signature. Read-only: it holds no key and sends nothing. Keeps working when one protocol is unavailable.
version: 0.1.0
requires:
  anyBins:
  - node
  - npm
---

# Multi-Protocol Aggregator

One interface over RockawayX (ERC-4626), Morpho Blue (USDC markets) and the Centrifuge fund vaults (read and compared, never routed to: their deposits are asynchronous requests). Everything is read through the Pharos Chain MCP on mainnet. An action comes out as **unsigned transactions**; the user's wallet signs.

## Setup (once)

```bash
git clone https://github.com/edycutjong/pharos-beacon && cd pharos-beacon && npm ci
```

No key; an optional `.env` is read only for the server URL. Runs take a few minutes (the hosted server is rate limited): tell the user before starting.

## Workflow

1. **Queries**
   ```bash
   npm run multi-protocol-aggregator -- positions --wallet 0x…
   npm run multi-protocol-aggregator -- rates --wallet 0x…
   ```
   Read out the "Protocols behind the one interface" lines first: a protocol that is `DOWN` or `PARTLY UP` means its positions are UNKNOWN, not zero.
2. **Actions** (pass `--plan plan.json` to save the transactions)
   ```bash
   npm run multi-protocol-aggregator -- deposit  --wallet 0x… --amount 250
   npm run multi-protocol-aggregator -- withdraw --wallet 0x… --amount 5000     # or --amount all
   ```
   Give the user the `ROUTE` block as printed: the chosen venue and its numbers, the runner-up, every venue that was not eligible and why. Never summarise a reason away. Say clearly that nothing was signed.
3. **If a protocol is unavailable** the run still answers from the others. To rehearse it: `--down morpho` (a protocol) or `--down morpho-c79579` (one venue); every line that names the failed venue says SIMULATED (the `PARTLY UP`, `positions … UNKNOWN` and `all`-covers-only-answering-venues lines do not).

## Rules

- Never sign or send anything for the user, and never ask for a key. The plan is for their wallet.
- If the output says "no venue can take" the request, report that: do not pick a venue by hand.
- `--assume-funded` prepares a deposit the wallet cannot fund yet; say so if it was used.
- Rates are backward-looking and not a risk score: do not call a venue safe.
