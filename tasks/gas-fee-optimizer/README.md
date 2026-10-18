# Gas Fee Optimizer — Medium

**Task:** [Gas Fee Optimizer](https://pharos-agent-arena.vercel.app/tasks/gas-fee-optimizer) (Trading / Monitoring · Medium · 100 pts):
monitors network gas price and times transaction submission for lowest cost.
**Run:** `npm run gas-fee-optimizer -- sample [--count 6] [--interval 5]` · `-- history [--last 10]` ·
`-- send --to 0x… --value 0.0001 --deadline 60 (--target-gwei 1.5 | --target-percentile 25 [--window 20]) [--interval 5] [--execute] [--proof name]`
(Atlantic needs the one-time `npm run setup:mcp`.) Without `--execute` it holds and decides but never sends.
**Uses:** Chain MCP ✅ (`get_block`, `get_gas_price`, and for `--execute` nonce, estimate, broadcast, receipt) · SkillEngine ✅
[`skills/gas-fee-optimizer/`](../../skills/gas-fee-optimizer/SKILL.md) · Docs MCP: not used

**Install as a skill:** `npx skills add https://github.com/edycutjong/pharos-beacon --skill gas-fee-optimizer`.

> **Atlantic gas is flat.** Every sample in [`state/gas.json`](state/gas.json) reads 1 gwei (base fee 1, priority 0). So the live
> runs below show the *mechanics* (sent early, held to the deadline) but no real saving: the report says `saved 0 PHRS, 0.00%`.
> The logic that would save money on a moving price is covered by tests with an injected clock.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Tracks gas price over time and shows recent history." | `sample` reads the price (base fee + priority fee) on an interval and appends to a state file (last 500 kept); `history` and every `send` print a table of recent samples with min and max | [`state/gas.json`](state/gas.json) (the committed samples) · the table in [early.log](proof/early.log) |
| 2 | "Accepts a transaction with a deadline and holds it until gas is favorable or the deadline is reached." | `send --to --value --deadline <s>` + a target; `holdUntilFavourable` samples every `--interval` seconds and returns "gas at or below target" or "deadline reached" | held run: [deadline.log](proof/deadline.log) (8 samples, 40 s, target 0.5 gwei below the 1 gwei floor) · early run: [early.log](proof/early.log) |
| 3 | "Reports the actual gas paid compared with the price at request time." | After the receipt: `price at request` (first sample), `price paid` (the receipt's effective gas price), gas paid in PHRS vs gas used × request price, saved or paid more | last line of each log, e.g. [deadline.log](proof/deadline.log): `price at request 1 gwei · price paid 1 gwei · gas paid 0.000021 PHRS vs 0.000021 PHRS` |
| 4 | "Never misses the deadline. It submits at the deadline even if gas is high." | The loop checks the clock before and after every read and sleeps at most until the deadline; a read that hangs is cut at the deadline; failing reads count as errors and do not stop the clock. Tests with an injected clock: gas stays high → returns at exactly the deadline; interval not dividing the deadline; every read failing; a read that never answers | [`test/gas.test.ts`](../../test/gas.test.ts) · live: [deadline.json](proof/deadline.json) `decision.reason: "deadline reached"` and the sent tx |

## Beyond the requirements: a percentile target

`--target-percentile 25 --window 20` means "send when gas is in the cheapest quarter of the last 20 samples", so you do not have to
guess a price. It needs 5 samples of history first (one sample is always its own p25, so it would fire at once) and keeps sampling until then.
Live ([percentile.log](proof/percentile.log)): history from the earlier runs was enough, the price equalled p25, and it sent on the first read.

## Proof (live runs on Atlantic, chain 688689)

| Run | Result | Files |
|---|---|---|
| Sent early: target 1.5 gwei, deadline 60 s | price 1 gwei ≤ target on the first read, sent after 0.1 s: [tx `0xae3e7d66…00cb`](https://atlantic.pharosscan.xyz/tx/0xae3e7d6675fa84659c1b581d2593a3c39a1d63ef78d2a57e8e632366bf2000cb) | [`early.json`](proof/early.json) · [log](proof/early.log) |
| Held to the deadline: target 0.5 gwei (below the observed 1 gwei floor), deadline 40 s | 8 samples over 40 s, all above target; sent at the deadline: [tx `0xfa4027a8…479e`](https://atlantic.pharosscan.xyz/tx/0xfa4027a81684e0560604f8e9687d7a8d253b9d110c58036fba0705dfb436479e) | [`deadline.json`](proof/deadline.json) · [log](proof/deadline.log) |
| Percentile target p25 | sent on the first read: [tx `0x215e68aa…b144`](https://atlantic.pharosscan.xyz/tx/0x215e68aa5a5481dfbd678c32ae80f5907f354a3e2d982820b422f17c5d6ab144) | [`percentile.json`](proof/percentile.json) · [log](proof/percentile.log) |

Each run sends 0.0001 PHRS from our test wallet to a fresh address. Every proof was produced by the commit it records (`dirty: false`).
(One earlier attempt of the "early" run recorded `dirty: true` because the run's own samples counted as a change; it was discarded and
the metadata is now captured before the run writes state. Its transaction `0x0b941ef0…8385` is a test transaction not used as evidence.)

```text
$ npm run gas-fee-optimizer -- send --to 0xDf34d07C3782ba050381e212B3609124Ed7DBA08 --value 0.0001 --deadline 40 --target-gwei 0.5 --interval 5 --execute --proof deadline
request: send 0.0001 PHRS to 0xDf34d07C3782ba050381e212B3609124Ed7DBA08 · target 0.5 gwei · deadline 06:20:13Z (40s)
  06:19:33 price 1 gwei · target 0.5 · 40s to deadline
  …
  06:20:09 price 1 gwei · target 0.5 · 4s to deadline
decision: send now — deadline reached after 40.0s (8 samples)
SENT: https://atlantic.pharosscan.xyz/tx/0xfa4027a81684e0560604f8e9687d7a8d253b9d110c58036fba0705dfb436479e (block 31564672, gas used 21000)
price at request 1 gwei · price paid 1 gwei · gas paid 0.000021 PHRS vs 0.000021 PHRS at the request price (saved 0 PHRS, 0.00%)
```

## Limits (honest)

- Atlantic's flat gas means no live saving to show; a moving chain would.  The tool is Atlantic only.
- The price is the latest block's base fee plus the node's priority fee. The actual price paid comes from the receipt.
- The send itself (nonce, estimate, broadcast, receipt) can take a few seconds after the deadline; the *decision* to send is made at the deadline.
- 13 tests in `test/gas.test.ts`.
