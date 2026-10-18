# Gas Fee Optimizer — Medium

**Task:** [Gas Fee Optimizer](https://pharos-agent-arena.vercel.app/tasks/gas-fee-optimizer) (Trading / Monitoring · Medium · 100 pts):
monitors network gas price and times transaction submission for lowest cost.
**Run:** `npm run gas-fee-optimizer -- sample [--count 6] [--interval 5]` · `-- history [--last 10]` ·
`-- send --to 0x… --value 0.0001 --deadline 60 (--target-gwei 1.5 | --target-percentile 25 [--window 20]) [--interval 5] [--lead 8] [--execute] [--proof name]`
(Atlantic needs the one-time `npm run setup:mcp`.) `sample` and `send` append to the committed `state/gas.json`; to try it without touching the tree, prefix the command with `GAS_STATE=/tmp/gas.json` (or pass `--state`). Without `--execute` it holds and decides but never sends.
**Uses:** Chain MCP ✅ (`get_block`, `get_gas_price`, and for `--execute` nonce, estimate, broadcast, receipt) · SkillEngine ✅
[`skills/gas-fee-optimizer/`](../../skills/gas-fee-optimizer/SKILL.md) · Docs MCP: not used

**Install as a skill:** `npx skills add https://github.com/edycutjong/pharos-beacon --skill gas-fee-optimizer`.

> **Atlantic gas was flat in all 29 samples we took (2026-10-18, 06:18–15:10Z, in several sittings).** Every sample in [`state/gas.json`](state/gas.json) reads 1 gwei (base fee 1, priority 0). So the live
> runs below show the *mechanics* (sent early, held to the deadline) but no real saving: the report says `saved 0 PHRS, 0.00%`.
> The logic that would save money on a moving price is covered by tests with an injected clock.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Tracks gas price over time and shows recent history." | `sample` reads the price (base fee + priority fee) on an interval and appends to a state file (last 500 kept); `history` and every `send` print a table of recent samples with min and max | [`state/gas.json`](state/gas.json) (the committed samples) · the table in [early.log](proof/early.log) |
| 2 | "Accepts a transaction with a deadline and holds it until gas is favorable or the deadline is reached." | `send --to --value --deadline <s>` + a target; `holdUntilFavourable` samples every `--interval` seconds and returns "gas at or below target" or "deadline reached" (printed as "send-by time reached (deadline − lead)" when a lead is set, since the lead, not the deadline, ended the hold) | held run: [deadline.log](proof/deadline.log) (8 samples, 40 s, target 0.5 gwei below the 1 gwei floor) · early run: [early.log](proof/early.log) |
| 3 | "Reports the actual gas paid compared with the price at request time." | After the receipt: `price at request` (first sample), `price paid` (the receipt's effective gas price), gas paid in PHRS vs gas used × request price, saved or paid more | last line of each log, e.g. [deadline.log](proof/deadline.log): `price at request 1 gwei · price paid 1 gwei · gas paid 0.000021 PHRS vs 0.000021 PHRS` |
| 4 | "Never misses the deadline. It submits at the deadline even if gas is high." | The send takes a few seconds (nonce, estimate, broadcast, block), so the hold ends `--lead` seconds (default 8) before the deadline and the run prints when it broadcast and when the block landed, against the deadline. The loop checks the clock before and after every read and sleeps at most until the decide-by time; a read that hangs is cut at the deadline; failing reads count as errors and do not stop the clock. Tests with an injected clock: gas stays high → returns at exactly the deadline; interval not dividing the deadline; every read failing; a read that never answers | [`test/gas.test.ts`](../../test/gas.test.ts) · live: [deadline-lead.log](proof/deadline-lead.log): `broadcast 7.7s before the deadline` · `mined in block 31579493 at 15:10:33Z, 7s before the deadline (15:10:40Z, whole seconds)` · [deadline.json](proof/deadline.json) is the earlier run without a lead (block 31564672 was stamped 06:20:14Z, 1 s after its 06:20:13Z deadline) |

## Beyond the requirements: a percentile target

`--target-percentile 25 --window 20` means "send when gas is in the cheapest quarter of the last 20 samples", so you do not have to
guess a price. It needs 5 samples of history first (one sample is always its own p25, so it would fire at once) and keeps sampling until then.
Live ([percentile.log](proof/percentile.log)): history from the earlier runs was enough, the price equalled p25, and it sent on the first read.

## Proof (live runs on Atlantic, chain 688689)

| Run | Result | Files |
|---|---|---|
| Sent early: target 1.5 gwei, deadline 60 s | price 1 gwei ≤ target on the first read, sent after 0.1 s: [tx `0xae3e7d66…00cb`](https://atlantic.pharosscan.xyz/tx/0xae3e7d6675fa84659c1b581d2593a3c39a1d63ef78d2a57e8e632366bf2000cb) | [`early.json`](proof/early.json) · [log](proof/early.log) |
| Held to the deadline: target 0.5 gwei (below the observed 1 gwei floor), deadline 40 s | 8 samples over 40 s, all above target; decided at the deadline (no lead), and its block was stamped 1 s after it: [tx `0xfa4027a8…479e`](https://atlantic.pharosscan.xyz/tx/0xfa4027a81684e0560604f8e9687d7a8d253b9d110c58036fba0705dfb436479e) | [`deadline.json`](proof/deadline.json) · [log](proof/deadline.log) |
| Held to the deadline with the 8 s lead: target 0.5 gwei, deadline 40 s | 7 samples, all above target; broadcast 7.7 s and mined 7 s (whole seconds) before the deadline: [tx `0x1484ea86…4957`](https://atlantic.pharosscan.xyz/tx/0x1484ea862952624332058fd61d66ae3cb658dad94e99a6219c7af249d5ee4957) | [`deadline-lead.json`](proof/deadline-lead.json) · [log](proof/deadline-lead.log) |
| Percentile target p25 | sent on the first read: [tx `0x215e68aa…b144`](https://atlantic.pharosscan.xyz/tx/0x215e68aa5a5481dfbd678c32ae80f5907f354a3e2d982820b422f17c5d6ab144) | [`percentile.json`](proof/percentile.json) · [log](proof/percentile.log) |

Each run sends 0.0001 PHRS from our test wallet to a fresh address. Every proof was produced by the commit it records (`dirty: false`).

```text
$ npm run gas-fee-optimizer -- send --to 0xDf34d07C3782ba050381e212B3609124Ed7DBA08 --value 0.0001 --deadline 40 --target-gwei 0.5 --interval 5 --execute --proof deadline-lead
request: send 0.0001 PHRS to 0xDf34d07C3782ba050381e212B3609124Ed7DBA08 · target 0.5 gwei · deadline 15:10:40Z (40s) · send decided by 15:10:32Z (8s lead)
  15:10:01 price 1 gwei · target 0.5 · 32s to deadline
  15:10:06 price 1 gwei · target 0.5 · 27s to deadline
  15:10:11 price 1 gwei · target 0.5 · 22s to deadline
  15:10:16 price 1 gwei · target 0.5 · 16s to deadline
  15:10:21 price 1 gwei · target 0.5 · 11s to deadline
  15:10:26 price 1 gwei · target 0.5 · 6s to deadline
  15:10:31 price 1 gwei · target 0.5 · 1s to deadline
decision: send now — send-by time reached (deadline − lead) after 32.0s (7 samples)
last 6 of 29 samples:
  time (UTC)   block      base fee      priority      price (gwei)
  15:10:06     31579469   1             0             1
  15:10:11     31579475   1             0             1
  15:10:16     31579479   1             0             1
  15:10:21     31579480   1             0             1
  15:10:26     31579485   1             0             1
  15:10:31     31579491   1             0             1
  min 1 · max 1 gwei over all 29
broadcast 7.7s before the deadline (15:10:33.302Z)
mined in block 31579493 at 15:10:33Z, 7s before the deadline (15:10:40Z, whole seconds)
SENT: https://atlantic.pharosscan.xyz/tx/0x1484ea862952624332058fd61d66ae3cb658dad94e99a6219c7af249d5ee4957 (block 31579493, gas used 21000)
price at request 1 gwei · price paid 1 gwei · gas paid 0.000021 PHRS vs 0.000021 PHRS at the request price (saved 0 PHRS, 0.00%)
proof: tasks/gas-fee-optimizer/proof/deadline-lead.json
```

## Limits (honest)

- Atlantic's flat gas means no live saving to show; a moving chain would.  The tool is Atlantic only.
- The price is the latest block's base fee plus the node's priority fee. The actual price paid comes from the receipt.
- The send itself (nonce, estimate, broadcast, block) takes a few seconds, which is why the decision is made `--lead` seconds (default 8) before the deadline. The earlier `deadline.json` run had no lead: its block was stamped one second after the deadline. The lead is a margin, not a guarantee: a slow node can still push a block past the deadline, and the run says so (`AFTER the deadline`) when it does.
- One earlier attempt of the "early" run recorded `dirty: true` because the run's own samples counted as a change; it was discarded and the metadata is now captured before the run writes state. Its transaction `0x0b941ef0…8385` is a test transaction not used as evidence.
- Block times are whole seconds, so the gap to the deadline is counted on whole seconds (the deadline floored); a block in the same second as the deadline is reported as "in the same second as", not as before or after. A `--deadline` of 8 s or less gets a default lead of half the deadline.
- 19 tests in `test/gas.test.ts` (16) and `test/gas-cli.test.ts` (3).
