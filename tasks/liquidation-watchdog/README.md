# Liquidation Watchdog — Medium

**Task:** [Liquidation Watchdog](https://pharos-agent-arena.vercel.app/tasks/liquidation-watchdog) (Medium · 100 pts): monitor a lending position, track its health factor and alert before it gets close to liquidation, while there is still time to act.

**What is real.** Everything here is read from **Pharos mainnet (chain 1672)**: [Morpho Blue](https://www.pharosscan.xyz/address/0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb) (`0x18573fA1…4Efb`) and the lending markets it hosts, through the Pharos Chain MCP (hosted, read-only). The watchdog **signs and sends nothing**. The positions in the proofs belong to third parties; nobody is liquidated or touched by this tool, and the alert tells *their* owner what to do. At the proof block (21,132,716) six of the 13 open positions were **already under 1.10**, so the default thresholds fire on real data, with no staged scenario. The one scenario run (`--shock`) is labelled as such everywhere it appears.

**Keys:** none. **Try it:** `npm ci && npm run liquidation-watchdog -- scan` (7 days of borrower discovery; the first run walks the window at the hosted server's pace of about 100 calls a minute, 7 days is about 660 calls, then the index is cached). The default window may find fewer positions than the proofs show; the proofs used `--lookback-days 30` (about 2,840 calls on a cold start, `proof/mainnet-cold-discovery.txt`), and positions move every block, so your numbers will differ.

**Run:** `npm run liquidation-watchdog -- scan|watch|position [--lookback-days 7] [--market 0x<id>] [--user 0x<address>] [--warn 1.3] [--critical 1.1] [--rearm 0.02] [--shock 0.05] [--min-debt 1] [--top 10] [--discord] [--interval-s 60 --max-polls 10] [--index file] [--levels file] [--proof name]`
- `scan`: market-wide. Finds every account that borrowed in the look-back window, reads each position live, ranks them by distance to liquidation, prints the table and one alert per position at or below `--warn`.
- `watch`: the same, polled every `--interval-s`; each poll first reads the new blocks for new borrowers. A position alerts when its level **gets worse**; it clears only when the health factor is `--rearm` above the threshold it left, so one hovering at 1.30 does not alert every poll. Levels persist in `state/levels.json` (git-ignored, `--levels` changes it), are keyed per position and per `--shock` value, and a watch keeps only the keys for the scenario and markets it is polling: anything else, including a repaid position, is forgotten. The start of a watch says how many non-`ok` levels it found (nothing when there are none).
- `position`: one named account in one market (`--market`, `--user`).
- `--discord` also sends the closest alert, plus a count of the rest, to the webhook in `~/.config/discord/webhook-alerts` (never printed). The console prints every alert (up to 20 per scan; dust is never alerted) with an ISO timestamp.
- `--shock 0.05` is a what-if: the collateral price −5 % applied to the health column and to the alerts (labelled `[scenario: …]`).
- `--min-debt 1` (loan-token units, so 1 USDC or 1 WPROS alike): smaller debts are marked "dust, no alert" in the `scan` table (within `--top`) and never alerted in `scan` or `watch`; `position` has no dust rule.

**Uses:** Pharos Chain MCP `eth_call`, `get_logs`, `get_block`, `get_block_number` (hosted `https://mcp.pharos.xyz/mcp`); viem for ABI encoding only.

## How a health factor is computed

Morpho Blue's own rule: a position is liquidatable when `borrowed > collateral × oraclePrice / 1e36 × LLTV / 1e18`, so `health = maxBorrow / borrowed` (1.0 = liquidatable). The watchdog reads, per market, `idToMarketParams` (oracle, IRM, LLTV), `market` (totals) and the oracle's `price()`; per account, `position` (collateral, borrow shares). Debt = shares × (totalBorrowAssets+1) / (totalBorrowShares+1e6), rounded up like Morpho. Interest is **accrued to the head block** with the market's IRM `borrowRateView` and Morpho's 3-term compounding, so the number is what Morpho would decide *now*, not at the market's last update (if the IRM cannot be read, `position` prints "interest NOT accrued" and the scan proof JSON records `interestAccrued: false`). All integer maths (`src/liq/morpho.ts`).

Borrowers are discovered from Morpho's `Borrow` events (Morpho Blue keeps no borrower list). The Chain MCP caps `get_logs` at 1,000 blocks per call, so the scan walks the look-back window in windows and caches the index (new blocks extend it, nothing is re-read).

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Reads the position's collateral, debt and health factor (or equivalent) from chain." | Collateral and borrow shares from `position()`, debt from the market totals with interest accrued, health from the oracle price and LLTV. Every row prints collateral, debt and health. Reads are of the latest state at the moment of the call, not pinned to one block. 13 open positions in 5 markets were read at block 21,132,716. An independent recomputation ([`independent-check.py`](proof/independent-check.py): public RPC, none of this code, stored market totals without interest) gave **1.01346** for the closest account where the watchdog printed **1.0134** (1.01337 in the proof JSON); the small gap is mostly the interest accrued since the market's last update, plus a tiny oracle price move between the two reads. [`independent-check.txt`](proof/independent-check.txt) | [`morpho.ts:57`](../../src/liq/morpho.ts) `healthFactor` · [`:147`](../../src/liq/morpho.ts) `snapshotMarket` · [`proof/mainnet-scan-discord.json`](proof/mainnet-scan-discord.json) · [`proof/mainnet-position.json`](proof/mainnet-position.json) |
| 2 | "Configurable warning thresholds, e.g. warn at 1.3 and critical at 1.1." | `--warn` (default 1.3), `--critical` (default 1.1), `--rearm`; invalid orderings are refused (`--warn` must exceed `--critical`, `--critical` must exceed 1.0). The same 13 positions at `--warn 1.06 --critical 1.03` give 2 critical and 3 warn instead of 6 critical. | [`alert.ts:19`](../../src/liq/alert.ts) · [`:28`](../../src/liq/alert.ts) · [`proof/mainnet-thresholds.txt`](proof/mainnet-thresholds.txt) |
| 3 | "Sends alerts through at least one channel: Telegram, Discord, email, or a console with timestamps." | Two channels: the console (every alert starts with `[<ISO timestamp>]`) and Discord (`--discord`; the proof records Discord's own message id 1563582350418247763 and timestamp). `watch` alerts once per level change; poll 2 and 3 of the watch proof send nothing. | [`index.ts:134`](index.ts) `deliver` · [`proof/mainnet-scan-discord.txt`](proof/mainnet-scan-discord.txt) · [`proof/mainnet-watch.txt`](proof/mainnet-watch.txt) |
| 4 | "Suggests a concrete action in each alert, e.g. 'repay X or add Y collateral'." | Every alert ends with `Act now: repay <amount> <loan token> or add <amount> <collateral token> collateral to get back to <warn>`, solved in integer maths and rounded up to the next base unit (tests check that 2 base units less does not reach the target), and says either "Liquidated if <token> falls N % further" or, below 1.0, "Liquidatable now.". The target is the warn threshold; `watch` treats the position as cleared at warn + `--rearm` (1.32 by default). | [`morpho.ts:71`](../../src/liq/morpho.ts) `remedy` · [`alert.ts:74`](../../src/liq/alert.ts) `buildAlert` · test `remedy: the concrete action` |

## Proof

Each proof JSON records `git.dirty: false` and the commit it ran at.

| Run | Command | Result |
|---|---|---|
| **Market-wide scan + Discord** | `scan --lookback-days 30 --discord --proof mainnet-scan-discord` | 13 open positions in 5 Morpho markets (30 days of `Borrow` events, blocks 18,293,941…21,132,716); the closest, a syzUSD/USDC account, is at **1.0134** (1.32 % from liquidation, debt 1,523,810 USDC). 6 positions critical (below 1.10), none warn, the rest ok or dust. 6 timestamped console alerts; the closest delivered to Discord · [`mainnet-scan-discord.json`](proof/mainnet-scan-discord.json) |
| What-if price shock | `scan --lookback-days 30 --shock 0.05 --top 13 --proof mainnet-shock-5pct` | With the collateral price −5 %, 4 positions would be liquidatable (health 0.9627 … 0.9833) and 2 more critical (plus 2 warn); labelled `[scenario: …]` · [`mainnet-shock-5pct.json`](proof/mainnet-shock-5pct.json) |
| Other thresholds | `scan --lookback-days 30 --warn 1.06 --critical 1.03 --top 5 --proof mainnet-thresholds` | the same positions classified at 1.06 / 1.03: 2 critical, 3 warn · [`mainnet-thresholds.json`](proof/mainnet-thresholds.json) |
| One named account | `position --market 0xc79579a0…fd86 --user 0xA4A57DcF…3DCc --proof mainnet-position` | health 1.0134, critical, alert with the action · [`mainnet-position.json`](proof/mainnet-position.json) |
| Watch loop | `watch --lookback-days 30 --max-polls 3 --interval-s 20` (flags as recorded in this README; the transcript has no JSON and predates the per-poll re-discovery) | poll 1: 6 new alerts; polls 2 and 3 (same positions, same levels): 0 new alerts · [`mainnet-watch.txt`](proof/mainnet-watch.txt) |

### Real output (from `proof/mainnet-scan-discord.txt`)

```text
block 21132716: 13 open positions across 5 market(s)
# | market | account | health | drop to liquidation | debt | collateral | level
1 | syzUSD/USDC | 0xA4A5…3DCc | 1.0134 | 1.32% | 1,523,810.47 USDC | 1,547,470.90 syzUSD | critical
2 | syzUSD/USDC | 0x743D…2A73 | 1.0201 | 1.97% | 22,010.37 USDC | 22,500.00 syzUSD | critical
3 | syzUSD/USDC | 0xE6a4…fe7C | 1.0333 | 3.22% | 1,343,762.90 USDC | 1,391,416.26 syzUSD | critical
[2026-10-24T15:58:02.010Z] CRITICAL Morpho syzUSD/USDC 0xA4A5…3DCc: health factor 1.0134 (debt 1,523,810.47 USDC, collateral 1,547,470.90 syzUSD). Liquidated if syzUSD falls 1.32% further. Act now: repay 335,972.74 USDC or add 437,692.81 syzUSD collateral to get back to 1.30.
discord: delivered message 1563582350418247763 at 2026-10-24T15:58:02.295000+00:00
```

## Beyond the requirements: market-wide scan and price shock

A watchdog for one account is the minimum; this one watches **every borrower it finds in the look-back window, in every Morpho market with a `Borrow` there**, ranks them by distance to liquidation, and prints for each the collateral price drop at which it liquidates (`drop to liquidation`) and, with `--shock`, the health after a drop you choose. The Discord message goes out for the closest position.

## Limits (stated honestly)

- **Discovery is by event window.** An account whose last `Borrow` is older than `--lookback-days` is not found (30 days in the proofs). A market with no `Borrow` in the window does not appear. `position` reads any named account regardless.
- Positions are other people's. The tool alerts; it cannot repay, add collateral or liquidate (nothing is signed).
- Debt accrual uses the IRM's current rate over the elapsed time; the head-block number can differ in the last digits from a read a few seconds later (the biggest position's debt reads 1,523,810.47 USDC at 15:58:02 and 1,523,810.91 at 15:59:13 UTC).
- Oracle prices are what the market's own oracle returns; the watchdog does not second-guess them. Six of 13 positions sit under 1.10 in the proofs, which is the contract's own verdict; we did not investigate why (a static or slow oracle, or no active liquidators, would both look like this).
- Reads are not pinned to one block: market totals, oracle price and position come from "latest" at slightly different moments, and the interest accrual uses the head block's timestamp.
- Dust (debt under `--min-debt`) is listed but never alerted, even if it is liquidatable; `position` always alerts.
- Discord receives the closest alert plus a count; the console receives every alert (up to 20 per scan).
- `watch` follows the market-wide set; it cannot follow one named account (`position` is a single read), and an account whose last `Borrow` is older than the window is not in the set.
- A shock is a what-if on one number (the collateral price), not a forecast.
- Tests: 26 in `test/liquidation-watchdog.test.ts` (health maths, accrual, remedy minimality, thresholds and hysteresis, alert text, discovery windows and cache, reads through a fake Chain MCP, CLI input checks); 940 in the repo (`npx vitest run`, 55 files).
- Engine changes after the proofs (QA round 1): the remedy cap and zero-price guard, the shock table's level label and the clamped drop-to-liquidation under `--shock` are covered by tests; the watch changes (per-poll re-discovery, scenario-scoped levels, forgetting repaid positions, the remembered-levels line, `--levels` in the usage string) are NOT covered by a unit test and were only smoke-run live, so the watch proof predates them. Only the shock proof was re-recorded; the other proofs ran at commits `1443263`, `fd0afe6` and `a8dac2d` (the same engine code: the commits between them only added proof files).
