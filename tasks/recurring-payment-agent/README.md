# Recurring Payment Agent — Medium

**Task:** [Recurring Payment Agent](https://pharos-agent-arena.vercel.app/tasks/recurring-payment-agent) (Payments · Medium · 100 pts): an agent that manages a repeating
on-chain payment on a schedule.
**Run** (Atlantic testnet only; one-time `npm run setup:mcp`, keys in `~/.config/pharos/testnet.env`):
`npm run recurring-payment-agent -- status --plan tasks/recurring-payment-agent/plans/rent.json --now 2026-11-08T09:00:00Z` (keyless: reads the ledger, prints history and the next payment) ·
`npm run recurring-payment-agent -- run --plan <plan.json> --now <ISO time> [--execute] [--discord]` (without `--execute` it only says what it would pay and writes nothing).
**Uses:** Chain MCP ✅ (`get_balance`, `eth_call` `balanceOf`, `get_transaction_count`, `estimate_gas`, `get_gas_price`, `send_raw_transaction`, `get_transaction_receipt`); viem signs locally.

## How it works

A **plan** ([`plans/rent.json`](plans/rent.json)) names the schedule (`weekly` or `monthly`), the amount, the token (`"PHRS"` or an ERC-20 `{address, symbol, decimals}`), the
recipient, the first due date (UTC) and an optional number of periods. A **ledger** ([`state/rent-demo.json`](state/rent-demo.json)) records what happened to each period.
A run pays every period that is due at the clock and not yet paid, oldest first:

1. **Funds first.** Not enough of the token (or of PHRS for the amount) → the period is `failed` with the reason, **nothing is prepared or sent**. Not enough PHRS for the gas → it is prepared (to estimate the gas) but never signed or sent.
2. **prepare → sign → record → broadcast.** The signed transaction (hash, nonce, raw bytes) is written to the ledger **before** it goes to the node.
3. **Confirm** with the receipt; `paid` only on status success. A revert is `failed` (it was mined, it cannot pay, so a later run may try again with a new transaction).

**Never twice for one period, within a ledger:** a period that has a recorded, unconfirmed transaction is never rebuilt. The next run asks the chain for that hash; if the node does not have it, it re-sends
the *same bytes* (same hash, so sending twice cannot pay twice). A paid period is skipped. A ledger written for a different plan (amount, token, recipient, schedule) is refused.
Monthly keeps the start's day of month and clamps in short months (31 Jan → 28 Feb → 31 Mar).

`--now` is an **injected clock**: it says what "today" is for the schedule. The demo plays two consecutive weekly periods (due 2026-11-01 and 2026-11-08) within minutes on the real Atlantic.
That is a demonstration clock, not real waiting: nothing in the proof claims a week passed. Without `--now` the real time is used.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Supports a schedule (weekly or monthly) with amount, token and recipient." | Plan file with `frequency` weekly\|monthly, `amount`, `token` (native PHRS or an ERC-20), `recipient`; bad plans are refused with a reason | [`plans/rent.json`](plans/rent.json), [`plans/insufficient.json`](plans/insufficient.json) (monthly) · `parsePlan`/`dueAt` in [`src/recurring/agent.ts`](../../src/recurring/agent.ts) · tests "weekly…", "monthly…" (31 Jan → 28 Feb), "rejects a bad plan" |
| 2 | "Prepares each payment on time and tracks paid, pending and failed status." | Each period due at the clock is prepared and sent; status per period is `paid`, `pending` (not processed yet, or signed and awaiting confirmation) or `failed` with the reason | Period 1: tx [`0xb48157…4b59`](https://atlantic.pharosscan.xyz/tx/0xb481579f3c3a996d99f05a47280e361f06a3ec8e761da3320b46819c85c74b59) block 31571296 · period 2: tx [`0x400359…ff2a`](https://atlantic.pharosscan.xyz/tx/0x400359aea589a88d6176e1e0c52db412eb33452cdb0c65abe06123817fa2ff2a) block 31571315 · [`proof/period-1-paid.json`](proof/period-1-paid.json), [`proof/period-2-paid.json`](proof/period-2-paid.json) |
| 3 | "Handles insufficient balance or a failed transaction without double-paying." | Insufficient balance: failed, no transaction. Node refusal: one retry on the same nonce, then failed. Crash or unclear send: the recorded hash is looked up and re-sent as the same bytes. Re-run: already-paid | Live: [`proof/insufficient-balance.json`](proof/insufficient-balance.json) (1,000,000 PHRS needed, 14.93 held, nothing sent) and [`proof/rerun-pays-nothing.json`](proof/rerun-pays-nothing.json) (both periods `already-paid`, no new tx). Tests for the crash, refusal, revert and retry paths are unit tests (below) |
| 4 | "Shows a payment history and the next scheduled payment." | `status` and the end of a normal `run` print the table of every period due so far and a `next payment: …` line (`next: …` with `--compact`; "plan is complete" once finished) | the output block below |

## The live run (Atlantic, injected clock, said plainly)

Payer: wallet 1 `0x317bca01Bb101C0F1E86C21576a4e14D92B02975`; recipient: our wallet 2 `0x8D34…D91B` (a distinct address, `PRIVATE_KEY_2`). 0.001 PHRS per period, weekly.

| Step | Clock (`--now`) | Result | Proof |
|---|---|---|---|
| 1 | 2026-11-01T09:00Z | period 1 **paid** | [`period-1-paid`](proof/period-1-paid.json) · Discord receipt 1561321078016577698 |
| 2 | 2026-11-08T09:00Z | period 1 already paid, period 2 **paid** | [`period-2-paid`](proof/period-2-paid.json) · Discord receipt 1561321172900122706 |
| 3 | 2026-11-08T09:00Z again | **nothing paid**: both periods `already-paid` | [`rerun-pays-nothing`](proof/rerun-pays-nothing.json) |
| 4 | other plan, 1,000,000 PHRS per month | period 1 **failed**: insufficient balance, nothing sent | [`insufficient-balance`](proof/insufficient-balance.json) |

Output of step 2 (pasted from the recorded run, [`proof/video-casts.log`](proof/video-casts.log)):

```text
clock: injected --now 2026-11-08T09:00:00.000Z (not the real time)
paying wallet 0x317bca01Bb101C0F1E86C21576a4e14D92B02975 (Atlantic)
  period 2 (due 2026-11-08): paid — block 31571315, gas used 21000

plan rent-demo: 0.001 PHRS weekly to 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B, from 2026-11-01, 4 periods
period  due         status   amount          tx / note
1       2026-11-01  paid     0.001 PHRS      0xb481579f…c74b59 block 31571296
2       2026-11-08  paid     0.001 PHRS      0x400359ae…a2ff2a block 31571315
next payment: period 3 on 2026-11-15 (09:00Z), 0.001 PHRS to 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
```

Step 4:

```text
  period 1 (due 2026-11-01): failed — insufficient PHRS balance: has 14.931994638999979, needs 1000000; nothing was sent
period  due         status   amount          tx / note
1       2026-11-01  failed   1000000 PHRS    insufficient PHRS balance: has 14.931994638999979, needs 1000000; nothing was sent
next payment: period 2 on 2026-12-01 (09:00Z), 1000000 PHRS to 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
```

### The video's own runs

The video shows three more real Atlantic runs, recorded while their proofs were written, in the narrow `--compact` layout (a terminal too narrow for the full table):
period 3 paid at clock 2026-11-15 (tx [`0x813b85…b55c`](https://atlantic.pharosscan.xyz/tx/0x813b85abbbdb66cff2e24966ed13b30ed96cbeb21b35482d30ad36881d85b55c), block 31571475,
[`video-period-3-paid`](proof/video-period-3-paid.json)), the same clock again with nothing paid ([`video-rerun`](proof/video-rerun.json)), and the unaffordable plan failing again ([`video-insufficient`](proof/video-insufficient.json)).
Their terminal text is in [`proof/video-casts.log`](proof/video-casts.log) (the first four blocks are the runs in the table above, the last three the video's).

## Beyond the requirements: a Discord receipt and one retry

- **Receipt per payment:** with `--discord` every confirmed payment (and a mined revert) posts one message with the period, amount, recipient and explorer link; a failure where nothing was sent (insufficient funds, node refusal) posts none, it is in the ledger and the run output, to the alert webhook (`~/.config/discord/webhook-alerts`).
  The message id is stored in the ledger, so a re-run sends no second receipt; if Discord is down the payment still stands and the ledger records the error.
- **One retry with backoff:** if the node refuses the send (and does not have the transaction), the agent waits and retries once on the **same nonce**, so at most one transaction can ever land.
  A second refusal marks the period `failed`. The retry is covered by unit tests only; the live run did not hit a refusal.

## Limits

- The ERC-20 path (token balance check, `transfer(recipient, amount)` call data) is covered by unit tests; **the live payments are native PHRS**, because the demo uses no ERC-20.
- The schedule is evaluated when you run it; running it on a timer (cron, a loop) is yours. A missed run pays the overdue periods in order at the next run (up to 120 per run).
- The crash-recovery and node-refusal paths are proven by tests with an injected fake node, not by killing a live run.
- Atlantic testnet only; the signer refuses any other chain. A recipient equal to the paying wallet is refused (no silent self-transfers).

## Tests

`npm test` — 19 tests in [`test/recurring.test.ts`](../../test/recurring.test.ts): schedule maths (weekly, monthly clamp, due/next), bad plans, two consecutive periods and a re-run, nothing due early,
insufficient balance (amount, and gas) then funded later, crash before and after the node took the transaction, one refusal retried and two refusals failed, a mined revert retried, the ERC-20 call data,
Discord receipts (one per payment, a failing webhook changes nothing), a ledger for another plan and a self payment refused, the history table, and the compact output.
