# Audit-Log Agent — Medium

**Task:** [Audit-Log Agent](https://pharos-agent-arena.vercel.app/tasks/audit-log-agent) (Compliance / Security · Medium · 100 pts):
a plain-language activity report for a wallet over a period, the kind a compliance officer or accountant could read.
**Run:** `npm run audit-log-agent -- --wallet 0x28ed4a97a21c2264ca352ebbcc6cafff60e89901 --from 2026-10-23 --to 2026-10-23` (keyless, Pharos mainnet, read-only;
about 5 minutes for a day: 192 `get_logs` windows for the day, about as many again for the previous-period read that the first-time check needs (`--baseline none` skips it), then the transactions; the client paces itself to 100 calls a minute and the hosted Chain MCP allows 120 per IP). `--from-block N --to-block M` pins blocks instead of dates;
`--network atlantic` reads the testnet; `--format md|csv|both --out dir` writes files; `--compact` prints a 62-column view; `--baseline none` skips the
previous-period read; `--proof label` writes `proof/<label>.json`.
**Uses:** Chain MCP ✅ (`get_chain_info`, `get_block_number`, `get_block`, `get_logs`, `get_transaction`, `get_transaction_receipt`, `get_code`, `eth_call`,
`get_transaction_count`) · SkillEngine: not used · Docs MCP: not used. It never sends a transaction. The same engine (`src/activity/`) is reused by the
Weekly Digest Agent, which lives on the next branch of the stack.

## Try it (about 2 minutes, keyless, read-only)

```text
npm ci
npm run audit-log-agent -- --wallet 0x28ed4a97a21c2264ca352ebbcc6cafff60e89901 --from-block 21042000 --to-block 21082000 --baseline none --compact
```

It ends with `sent txs: 11 of 11 matched by the chain's nonce`. The date form (about 5 minutes for a day): `--from 2026-10-23 --to 2026-10-23`, which prints the full Markdown report.

## How it finds a wallet's activity

The Chain MCP has no "transactions of this address" call, so the engine builds it from what the node can answer:

1. **Date → block.** `--from/--to` are UTC dates (`--to` inclusive). An interpolation search over `get_block` timestamps finds the first block of each
   day in a few calls (a plain bisection over 21 million blocks takes 25; `test/activity.test.ts` asserts under 16 on a chain with uneven block times).
2. **Logs.** `get_logs` with the wallet as the 1st or the 2nd indexed topic, paged by the server's 1,000-block cap: that catches ERC-20/721 `Transfer`
   (from / to), `Approval` (owner) and `Swap` events. `get_transaction` + `get_transaction_receipt` give the sender, the call, the status and the fee.
3. **What leaves no log** (a plain PROS transfer, a call that emits nothing) is found through the **nonce**: the wallet's nonce rises by one for every
   transaction it sends, so the engine reads `get_transaction_count` at the two ends of the range, and when it is higher than the sends it already
   saw, it **bisects the nonce** to the exact blocks where the rest were sent (about one nonce read per halving of the range; the Atlantic proof below spent 55 reads for 7 sends) and opens only those blocks. In plain words: it cross-checks the number of transactions the wallet sent against the chain's own counter for that wallet.
   The report says how many sent transactions it found against how many the nonce counts ("Outgoing transactions found: 21 of 21 …"; `--compact`: "sent txs: 11 of 11 matched by the chain's nonce"), so a gap is visible instead of hidden.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Accepts a wallet address and a date range." | `--wallet` (a malformed address is refused; the address is printed checksummed) and `--from`/`--to` UTC dates, or `--from-block`/`--to-block`; the range is pinned to blocks at the start of the run | [`index.ts`](index.ts) `main`, proof `range` in [`third-party-mainnet.json`](proof/third-party-mainnet.json) (2026-10-23 → blocks 20974946–21070507), tests `refuses bad input` |
| 2 | "Groups activity into categories: transfers in and out, swaps, approvals, contract interactions." | Five categories, one section each: transfers in, transfers out, swaps (a Swap event, or the wallet giving one token and getting another in one tx), approvals (an ERC-20 / NFT `approve`; an allowance merely spent inside a transfer is not counted), contract interactions (a call the wallet sent that is none of the above, incl. reverted ones and payable calls such as a wrap, where the PHRS sent shows next to the call) | Live: third-party wallet = out 8 · swaps 10 · approvals 3 ([`third-party-mainnet.json`](proof/third-party-mainnet.json) `byCategory`); our Atlantic wallet = in 113 ([`atlantic-received.json`](proof/atlantic-received.json)); out 119 + 2 contract calls ([`atlantic-sent.json`](proof/atlantic-sent.json)) |
| 3 | "Includes totals per category and notable transactions with links." | A totals table (count per category and the token amounts of transfers and swaps), a fees-paid line, the number of failed transactions in the summary sentence when any reverted, and a `Notable transactions` list of up to five (reverted calls first, then one line per spender with an unlimited approval, the two transfers with the biggest share of their token's outflow, then up to two swaps); every row is linked to the explorer | the report excerpt below; [`reports/`](proof/reports/) |
| 4 | "Exports the report as Markdown, PDF or CSV." | Markdown and CSV (`--format md|csv|both --out dir`); the CSV has one row per item with the explorer link, an `unlimited` allowance written as such, and a `notable` column marking the rows the Markdown lists. No PDF | [`audit-0x28ed4a-2026-10-23_2026-10-23.md`](proof/reports/audit-0x28ed4a-2026-10-23_2026-10-23.md) and [`.csv`](proof/reports/audit-0x28ed4a-2026-10-23_2026-10-23.csv) (22 lines = header + 21 items) |

## Beyond the requirements: highlights and the nonce check

- **Highlights** sit at the top of the report: **first-time counterparties** (anyone the wallet dealt with that it did not in the previous period of the
  same length, which the agent reads by default), the **largest outflow** of each of the three most-sent tokens, and every **unlimited approval**. The third-party wallet's day
  shows 3 first-time counterparties and 3 unlimited approvals to one spender.
- **The nonce check** ("21 of 21" sent transactions found) is a completeness check for what the wallet sent; on our Atlantic wallet the logs alone found 3 of
  10 sent transactions (the recorded video cast, range 31804700–31806500, prints that line) and the nonce search found the other 7: 55 nonce reads and 7 blocks opened over the 10,001-block proof range, instead of walking every block.

## Proof

| Run | Result | File |
|---|---|---|
| A third party's wallet on Pharos mainnet, 2026-10-23 (a wallet we do not control, found among the day's active externally owned accounts; no selection log was kept) | 21 transactions: 8 transfers out, 10 swaps, 3 approvals (all unlimited); 21 of 21 sent transactions matched by the nonce; 192 `get_logs` windows; previous day read for the first-time check | [`proof/third-party-mainnet.json`](proof/third-party-mainnet.json) + [`reports/`](proof/reports/) |
| Our Atlantic wallet 2, blocks 31760575–31807814 | 113 transfers in (111 USDC, 2 WPHRS), all 113 from our wallet 1; 0 sent, 0 expected | [`proof/atlantic-received.json`](proof/atlantic-received.json) |
| Our Atlantic wallet 1, blocks 31798000–31808000 | 119 transfers out (111 USDC, 2 WPHRS, 6 PHRS sends: 4 with empty calldata, 2 with a short data field), 2 contract interactions (a `deposit` that wrapped 0.01 PHRS, and a reverted `withdraw`); 10 of 10 sent transactions, 7 of them found by the nonce search (55 nonce reads, 7 blocks opened) | [`proof/atlantic-sent.json`](proof/atlantic-sent.json) |

The three proofs record `dirty: false` (commits 595bfba, e5df2dd and 7c99e6a, all on the final code). The Atlantic wallets are ours, so "received" and "sent" there are our own
test traffic, and the README says so rather than calling it organic activity (the 111 USDC transfers use the selector `0xe3ee160e`, EIP-3009 `transferWithAuthorization`, which is how the x402 tasks settle). The mainnet wallet is the independent evidence.

```text
$ npm run audit-log-agent -- --wallet 0x28ed4a97a21c2264ca352ebbcc6cafff60e89901 --from 2026-10-23 --to 2026-10-23 --format both --out tasks/audit-log-agent/proof/reports --proof third-party-mainnet
(report head, from proof/reports/audit-0x28ed4a-2026-10-23_2026-10-23.md)
# Wallet activity report: `0x28Ed4A97a21C2264CA352EbBcc6CaffF60e89901`

Pharos mainnet · 2026-10-23 to 2026-10-23 UTC (both days included) · blocks 20974946–21070507 · generated 2026-10-24T07:56:34Z · read-only through the Pharos Chain MCP

## In plain words

21 transactions touched this wallet; it received tokens by plain transfer 0 times and sent them 8 times; made 10 swaps; granted 3 approvals (3 unlimited); and made 0 other contract calls. Fees it paid for the transactions it sent: 0.033894 PROS.

## Highlights

- **first time counterparty:** First time dealing with `0x3fa4FBe561f6d5996Ca69B4fb82e61A01D3ae558` (not seen in the previous period): sent it 12,546.7648 pCARR. [0xca9caacb…](https://www.pharosscan.xyz/tx/0xca9caacb3e5a28978df65cdb26cfbf9094e0da4270e57bffdbfc4c4fcba538b8)
- **first time counterparty:** First time dealing with `0xAf2b77d76C6256826c2B650aa6D0BbF297A0E7B8` (not seen in the previous period): sent it 6,623.661 pTACO. [0x0879e5c0…](https://www.pharosscan.xyz/tx/0x0879e5c090ea8701eaa2b52b80edf33612234284e75d6ec4fe1bbab9c189bf56)
- **first time counterparty:** First time dealing with `0x961534f2Ed120e75C75a3aC8B68b70CA23Cc01E2` (not seen in the previous period): sent it 27,565.6223 pTier. [0x7bee9c1b…](https://www.pharosscan.xyz/tx/0x7bee9c1b7e0223320d6dfe85b2afe409d465a8f3cda1e952b0728fcda0c9d9c3)
- **largest outflow:** Largest pTACO sent out: 11,688.7 pTACO to `0xAf2b77d76C6256826c2B650aa6D0BbF297A0E7B8`. [0xe925a190…](https://www.pharosscan.xyz/tx/0xe925a19082a7adf400559be315381e3a1da43b900ecea180495d96d6cd4814f4)
- **largest outflow:** Largest pCARR sent out: 19,738.4299 pCARR to `0x3fa4FBe561f6d5996Ca69B4fb82e61A01D3ae558`. [0xc2579c59…](https://www.pharosscan.xyz/tx/0xc2579c59db8054e100475bfcab10dc447c7e01e4c0bd5cdbaffc764e08f17312)
- **largest outflow:** Largest pDOG sent out: 354,170.6627 pDOG to `0x0A438d3ecEbb6c4221dD54905C7329975E88584F`. [0x150280d7…](https://www.pharosscan.xyz/tx/0x150280d71f7b72fb127f4d2a6dd6917f7db22a22f782e13b20b63d8356bf4842)
- **unlimited approval:** Unlimited approval: `0xBF105f4ffBD3825f5433d074008B9A76237d849c` can move pCARR without a cap. [0x1c63d96f…](https://www.pharosscan.xyz/tx/0x1c63d96fc84cf515a8131c58c24a86e9703c63cf73891ac0d89762ebf562037c)
- **unlimited approval:** Unlimited approval: `0xBF105f4ffBD3825f5433d074008B9A76237d849c` can move pTACO without a cap. [0xa6f76225…](https://www.pharosscan.xyz/tx/0xa6f76225f166b77b480c6f74a022e480bed1f724dfdf2b31badcfd52adcb2339)
- **unlimited approval:** Unlimited approval: `0xBF105f4ffBD3825f5433d074008B9A76237d849c` can move pTier without a cap. [0x566b75a6…](https://www.pharosscan.xyz/tx/0x566b75a638a109f25fdfe413065c6b3ae828576f45ddb56c03994b5742764edf)

## Totals by category

| Category | Transactions | Amounts |
|---|---|---|
| Transfers in | 0 | none |
| Transfers out | 8 | 38,312.361 pTACO (4), 32,285.1948 pCARR (2), 354,170.6627 pDOG (1), 27,565.6223 pTier (1) |
| Swaps | 10 | gave 596 PROS (10); got 38,312.361 pTACO (4), 32,285.1948 pCARR (3), 27,565.6223 pTier (2), 354,170.6627 pDOG (1) |
| Approvals | 3 | 3 unlimited |
| Contract interactions | 0 | — |

Fees paid: 0.033894 PROS across the transactions this wallet sent. Counts are items found; one transaction can hold several.
[...]
## What this report can and cannot see

- Events: 21 matching logs over 192 `get_logs` windows (the wallet as the first or second indexed argument of Transfer / Approval / Swap-style events).
- Block scan for plain PROS transfers and calls that emit no event: off (use `--scan-blocks N`).
- Outgoing transactions found: 21 of 21 the chain's nonce counts for this range.
- Swaps are recognised from Swap events or from the wallet giving one token and getting another in one transaction; native-token movement inside contract calls (internal transfers) is not visible to the Chain MCP.
- No prices: amounts are in token units, never converted to money.
```

## Video

The video (`audit-log-agent.mp4`, kept with the submission and posted on X, not in this repo) is three real terminal recordings, not the proof runs: the `--compact` view on a third party's mainnet wallet over
blocks 21042000–21082000 (11 of 11 sent transactions matched), our Atlantic wallet over blocks 31804700–31806500 (the logs show 3 of 10 sent transactions, the nonce
search finds the other 7), and the CSV export. Their output is in [`proof/video-casts.log`](proof/video-casts.log). Waits are trimmed on screen and labelled.

## Limits (honest)

- Amounts are in token units. There are no prices, so nothing is converted to money.
- Internal transfers (PROS moved by a contract inside a call) are not visible to the Chain MCP; a plain transfer the wallet *sends* is found through the nonce, a
  plain transfer it *receives* leaves no log and no nonce change, so it is invisible (a received PROS transfer needs `--scan-blocks N`, which opens every block of the
  newest N and costs one call per block).
- A swap is recognised from a `Swap` event or from the wallet giving one token and getting another in one transaction; a router that does neither shows as a contract
  interaction.
- The transactions read from logs or a block scan are capped by `--max-txs` (default 400, and the report counts what it skipped); the nonce search that finds sends the logs missed is bounded by `--discover-calls` (default 300) and says when it stopped. 
- A range over 3,000,000 blocks (about a month on mainnet) is refused: run it in pieces. A week is about 600,000 to 670,000 blocks (601,888 and 611,437 for the two weeks in the Weekly Digest proofs): about 1,200 to 1,340 `get_logs` calls, about 14 minutes at the 100 calls a minute the client paces itself to, and about twice that with the default previous-period read.
- First-time counterparties compare with the one previous period only, not with the wallet's whole history.
- The zero address is shown as "mint or burn" and is never a first-time counterparty.
- No PDF export.
- 29 tests in `test/activity.test.ts` (classification, nonce discovery, date → block, report, CSV, highlights, mints) and 15 in `test/audit-log-agent.test.ts` (CLI, bad input, `--compact`, `--out`); 801 in the repo at this branch tip.
