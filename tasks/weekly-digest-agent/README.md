# Weekly Digest Agent — Medium

**Task:** [Weekly Digest Agent](https://pharos-agent-arena.vercel.app/tasks/weekly-digest-agent) (Support / Reporting · Medium · 100 pts):
a periodic summary of a wallet's activity (what changed, the key numbers, the notable events), delivered on a schedule.
**Run:** `npm run weekly-digest-agent -- --wallet 0xe7368221de15a7c5e0a50a95317b06e6d08c3861 --now 2026-10-19T01:00:00Z --baseline none --compact` (keyless, Pharos mainnet, read-only;
about 14 minutes for a week: the second proof below took 14 minutes from its start (10:06:15Z) to the Discord message (10:20:33Z), for 1,204 `get_logs` windows plus the transactions, at the 100 calls a minute the client paces itself to). `--cadence weekly|daily|monthly|Nd` (default `weekly`), `--now ISO` sets the clock (the
default is the real clock), `--state f` remembers the last period and its numbers, `--out dir` writes the Markdown, `--deliver discord|console|none`, `--force` builds a period again,
`--print-schedule` prints the cron line (daily, weekly, monthly; for `Nd` it says to run it daily), `--compact` prints a 62-column view, `--proof label` writes `proof/<label>.json`.
**Uses:** Chain MCP ✅ (the same engine as the Audit-Log Agent on the branch below this one, `tasks/audit-log-agent/README.md`, `src/activity/`: `get_chain_info`, `get_block_number`, `get_block`, `get_logs`, `get_transaction`, `get_transaction_receipt`, `get_code`,
`eth_call`, `get_transaction_count`) · SkillEngine: not used · Docs MCP: not used. Its only external write is one Discord message.

## Try it (a few minutes, keyless, read-only)

```text
npm ci
npm run weekly-digest-agent -- --wallet 0xe7368221de15a7c5e0a50a95317b06e6d08c3861 --cadence daily --now 2026-10-24T01:00:00Z --baseline none --compact
```

It prints the digest of 2026-10-23 and ends with the top three events (no previous period here: `--baseline none` and no state file; the proofs below use both). `--print-schedule` prints the cron line in a second. The weekly default takes about 14 minutes (see Proof).

## What a run does

1. **The period.** A digest describes the last *finished* UTC period of its cadence: a weekly digest run on any day of the week describes the Monday-to-Sunday week before it
   (monthly: the last calendar month; `Nd`: N-day periods on a fixed grid counted from 1970-01-01, so the same period is returned for N days). So running it twice in a week describes the same week.
2. **The numbers.** The wallet's activity over the period (the engine reads events and the nonce, see the Audit-Log README), reduced to counts, token flow, fees and counterparties.
3. **The previous period.** Read from the state file when the last run was the period before; otherwise read again (`--baseline none` skips it).
4. **The top three events.** Candidates are scored by importance class (unlimited approval 100, failed transaction 95, large outflow 80, new counterparty 70, swap 60, large inflow 50,
   mint 30) plus up to 9.9 points for the size of the event's leg as a share of all the wallet's legs of that token in the same direction (swap legs and approval amounts count; unlimited approvals and failures get no size points); one entry per transaction, at most two of one kind, ties to the earlier block.
5. **Delivery.** The Markdown file (`--out`) and a short message to a Discord channel through an incoming webhook (read at run time from `DISCORD_WEBHOOK_URL` or
   `~/.config/discord/webhook-alerts`, never printed). With `--state`, the file records the period and the message id, so a second run in the same period builds nothing and sends nothing; a period that was only written (a run with `--deliver none`, e.g. before the webhook secret exists) is delivered when a later run asks for delivery.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Runs on a schedule (weekly by default, configurable)." | `--cadence` defaults to `weekly`; `daily`, `monthly` and `Nd` are accepted. [`.github/workflows/weekly-digest.yml`](../../.github/workflows/weekly-digest.yml) runs it on `cron "0 1 * * 1"` (every Monday 01:00 UTC; `--print-schedule` prints the line for daily, weekly and monthly); with `--state`, a repeat trigger in the same period is a no-op | [`index.ts`](index.ts), [`proof/rerun-no-repeat.log`](proof/rerun-no-repeat.log) (a further run in the same week: "already delivered"; the code returns before any chain connection, `index.ts`, and a test asserts no chain call), `test/weekly-digest-agent.test.ts` (period maths for every cadence). The workflow itself has not run yet: it only exists on GitHub after the merge, and it needs the repository variable `DIGEST_WALLET` and the secret `DISCORD_WEBHOOK_URL` |
| 2 | "Covers key metrics with a comparison to the previous period." | A key-numbers table (transactions, transfers in / out, swaps, approvals, other contract calls, failures, fees, counterparties, new counterparties) with this period, the previous one, and the change in units and percent; plus a token-flow table | the table below; [`proof/week-2026-10-12.json`](proof/week-2026-10-12.json) (`metrics`, `previous`) |
| 3 | "Highlights the top 3 notable events of the period." | Up to three, each with the reason and an explorer link, ranked as described above (at most two of one kind, so a period whose notable transactions are all one kind lists two) | `Top 3 notable events` below |
| 4 | "Delivers to a real channel (email, Telegram, Discord) or as a published page." | A real Discord message (id `1563497420917047468`, 2026-10-24T10:20:33.524000+00:00); the Markdown digest is also written to a file and, in the workflow, to the job summary | `delivery` in [`proof/week-2026-10-12.json`](proof/week-2026-10-12.json) |

## Beyond the requirements: who is new

The digest also lists the counterparties that appear in this period but not the one before (13 of 17 this week) and how many dropped out, and the Discord message
carries the transaction change and the new-counterparty count. A mint (tokens sent from the zero address) is described as a mint and never counted as a counterparty.

## Proof (Pharos mainnet, a third party's wallet we do not control)

The wallet `0xe736…3861` is a third party's (we do not control it; no selection log was kept); it was picked because it was active in both weeks (its nonce rose by 16 and 44). The weeks are in the past, so the runs use an injected clock
(`--now`), stated here rather than hidden: the first run at `2026-10-12T01:00:00Z` (week 2026-10-05..11), the second at `2026-10-19T01:00:00Z` (week 2026-10-12..18).

| Run | Result | File |
|---|---|---|
| Week 2026-10-05..11, blocks 19397642–20009078, first run (no state, no earlier period) | 16 transactions: 4 in, 2 out, 7 swaps, 2 approvals, 1 contract call (the 4 "in" are transactions the wallet itself sent in which tokens arrived: all 16 were sent by it); 16 of 16 sent transactions matched by the nonce; not delivered | [`proof/week-2026-10-05.json`](proof/week-2026-10-05.json), [`digests/…2026-10-05.md`](proof/digests/digest-0xe73682-weekly-2026-10-05.md) |
| Week 2026-10-12..18, blocks 20009079–20610966, previous week from the state file | 48 transactions: 4 in, 9 out, 21 swaps, 8 approvals, 6 contract calls (the 4 "in" are 4 transactions sent by others: one transfer each of CRS, MUSE, DOGV and reTQQQ); 44 of 44 sent transactions matched; delivered to Discord | [`proof/week-2026-10-12.json`](proof/week-2026-10-12.json), [`digests/…2026-10-12.md`](proof/digests/digest-0xe73682-weekly-2026-10-12.md) |
| Same week again, same state | `already delivered`, nothing read, nothing sent | [`proof/rerun-no-repeat.log`](proof/rerun-no-repeat.log) |

Both JSON proofs record `dirty: false` (commits aa00814 for the first, 705862d for the second; both ran on the final digest code; the only later code changes are two comments and a one-line rule in the shared engine that cannot affect them: all 48 and 16 transactions are accounted for by categories that do not involve it). `proof/rerun-no-repeat.log` is the output of a further run in the same week (its first line is the command: the second run's with `--now 2026-10-21T13:00:00Z`, same `--state`). From the second digest (`proof/digests/digest-0xe73682-weekly-2026-10-12.md`):

## What changed

48 transactions this period, up from 16 the period before: 4 transfers in, 9 out, 21 swaps, 8 approvals, 6 other contract calls.

## Key numbers

| Metric | This period | Previous period | Change |
|---|---|---|---|
| Transactions | 48 | 16 | +32 (+200%) |
| Transfers in | 4 | 4 | 0 (0%) |
| Transfers out | 9 | 2 | +7 (+350%) |
| Swaps | 21 | 7 | +14 (+200%) |
| Approvals | 8 | 2 | +6 (+300%) |
| Other contract calls | 6 | 1 | +5 (+500%) |
| Failed transactions | 0 | 0 | 0 (0%) |
| Fees paid (PROS) | 0.105588 | 0.033257 | +217% |
| Counterparties | 17 | 9 | +8 (+89%) |
| New counterparties | 13 | — | — |

### Token flow (plain transfers; swaps are not counted here)

| Token | In | Out | In (previous) | Out (previous) |
|---|---|---|---|---|
| CRS | 10 CRS | 0 CRS | — | — |
| MUSE | 10 MUSE | 0 MUSE | — | — |
| DOGV | 5.012 DOGV | 0 DOGV | — | — |
| reTQQQ | 5 reTQQQ | 0 reTQQQ | — | — |
| USDC | 0 USDC | 764.3426 USDC | 0 USDC | 81.5 USDC |
| pDOG | 0 pDOG | 2,750,116.59 pDOG | — | — |
| pPeng | 0 pPeng | 91,587,384.024 pPeng | — | — |
| WPROS | — | — | 5.1269 WPROS | 0 WPROS |
| pTACO | — | — | 525.8018 pTACO | 0 pTACO |

## Top 3 notable events

1. **large outflow:** Sent 91,587,384.024 pPeng to 0xe492912F37C2A4eCa45D42DC67548F4C6Cd7ce2B. [0x07708ad7…](https://www.pharosscan.xyz/tx/0x07708ad71bad349544bcfa7ea499f143d9626fa07c7e2f72ba277ecd944bd578)
2. **large outflow:** Sent 2,750,116.59 pDOG to 0x63FfADf944583D8e4Fdc30144EFdfe3bdC2122f5. [0x310d17e2…](https://www.pharosscan.xyz/tx/0x310d17e296454f56ffefbb53c472aaf83143ae56582851f319324b38a9edaaa2)
3. **new counterparty:** First time dealing with 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0 (deposit (wrap)). [0x7978c4d1…](https://www.pharosscan.xyz/tx/0x7978c4d1a5ff054a7a1cf8316b34fd6b7367a1bfd8dd20feb94cb33b3169539e)

The message sent to Discord (from `discordText` in the proof, 772 characters):

```text
**weekly digest** · `0xe736…3861` · 2026-10-12 to 2026-10-18 UTC
Transactions: 48 (was 16, +200%) · in 4 · out 9 · swaps 21 · approvals 8 · fees 0.105588 PROS
New counterparties: 13
Top events:
1. large outflow: Sent 91,587,384.024 pPeng to 0xe492912F37C2A4eCa45D42DC67548F4C6Cd7ce2B <https://www.pharosscan.xyz/tx/0x07708ad71bad349544bcfa7ea499f143d9626fa07c7e2f72ba277ecd944bd578>
2. large outflow: Sent 2,750,116.59 pDOG to 0x63FfADf944583D8e4Fdc30144EFdfe3bdC2122f5 <https://www.pharosscan.xyz/tx/0x310d17e296454f56ffefbb53c472aaf83143ae56582851f319324b38a9edaaa2>
3. new counterparty: First time dealing with 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0 (deposit (wrap)) <https://www.pharosscan.xyz/tx/0x7978c4d1a5ff054a7a1cf8316b34fd6b7367a1bfd8dd20feb94cb33b3169539e>
```

## Video

The video (`weekly-digest-agent.mp4`, kept with the submission and posted on X, not in this repo) is three real terminal recordings, not the proof runs: `--print-schedule`, a daily digest of the same wallet for 2026-10-23
compared with the day before (from a state file, delivered to Discord, message id in [`proof/video-casts.log`](proof/video-casts.log)), and the same command again at 13:00Z ("already delivered"). The daily
cadence is used so a run takes minutes; the weekly proofs above are the default cadence.

## Limits (honest)

- Token amounts are units, never money, and there are no prices to compare tokens: "size" is a share of that token's own volume, so a one-off transfer of a low-value token can outrank a larger USDC amount. Internal transfers and, by default, a plain PROS transfer the wallet *receives* are invisible (see the Audit-Log README).
- The size points count approval amounts in a token's volume, so an unlimited approval makes every outflow of that token score close to zero size points.
- In the workflow the state file lives in the Actions cache, which GitHub evicts after 7 days without access; the next run is 7 days later, so persistence there is unproven.
- Only finished UTC periods are reported, and only against the one period before; there is no trend over more periods.
- A week costs about 14 minutes of reads at the 100 calls a minute the client paces itself to (measured), a month about an hour (estimated from the block rate, not run; the engine refuses ranges over 3,000,000 blocks).
- The Discord message is cut to 1,891 characters with an ellipsis when longer than 1,900 (Discord's own limit is 2,000) and shows the top events as links, not tables.
- The first run for a wallet has no previous period unless `--baseline auto` (the default) reads it, which doubles the time.
- The schedule is a GitHub Actions workflow; until it is merged and configured it has not run, and the digests in `proof/` were produced by manual runs with an injected clock.
- 23 tests in `test/weekly-digest-agent.test.ts` (periods, comparison, top events and their ranking, Discord text, the CLI with state, delivery and idempotence) on top of the 31 engine and report tests in `test/activity.test.ts`.
