# Wallet Risk Checker — Medium

**Task:** [Wallet Risk Checker](https://pharos-agent-arena.vercel.app/tasks/wallet-risk-checker) (Compliance / Security · Medium · 100 pts):
flags a wallet/contract's suspicious history before you transact with it.
**Run:** `npm run wallet-risk-checker -- check 0x… [--network pharos|atlantic] [--block N] [--lookback 30000] [--config f] [--proof label]`
(`pharos` is mainnet, read through the hosted Chain MCP: keyless. `atlantic` is the testnet, read through the sponsor's Chain MCP server run locally: it needs the
one-time `npm run setup:mcp`, no key). `-- gate --to 0x… --amount 0.0001 [--execute]` puts the check in front of a Policy Gatekeeper send (Atlantic, so also
`setup:mcp`; the testnet key is needed only for `--execute`).
**Uses:** Chain MCP ✅ (`get_block_number`, `get_code`, `get_transaction_count`, `get_balance`, `get_block`, `get_logs`; `send_raw_transaction` only for a gated send) ·
SkillEngine: only the token registry (`src/lib/networks.ts`) · Docs MCP: not used.

## The six signals

| Signal | What is read | Level |
|---|---|---|
| wallet or contract | `get_code` | info (a contract is a reminder to read its source; the Chain MCP cannot say whether it is verified) |
| age | first block with code (contract) or with a sent transaction (wallet), found by a binary search of archive reads (`get_code` / `get_transaction_count` at a block) and `get_block` timestamps | medium if younger than `youngDays` (7), or if the address has no history at all |
| nonce and balance | `get_transaction_count`, `get_balance` | medium if it holds funds but has never sent anything (freshly funded) |
| flagged addresses | Transfer logs of the registry tokens (+ `extraTokens`) with the address as sender or recipient, compared with [`risk-config.json`](risk-config.json) `flagged` | **high** |
| approvals | Approval logs by the address; the latest allowance per token and spender | medium for an open approval to a spender that is not in `trustedSpenders` or the token registry (stated as "unlimited" at 2^255 or more); **high** if the spender is flagged |
| activity | the same logs, counted | info |

**Verdict:** HIGH if any signal is high or three are medium, MEDIUM if one or two are medium, otherwise LOW. Every medium and high signal is printed again
as a numbered plain-language reason.

**Where the flagged list comes from (read this):** it is **our own file**, [`risk-config.json`](risk-config.json), and each entry carries its `reason` and `source`.
It is not a feed from a security vendor or a government list, and the one entry in it is an address we made up for the risky example. Add your own
entries; the checker is only as good as the list. Transfers of the native coin leave no log, so they are not covered, and the token history is read for
the last `--lookback` blocks (30,000 by default), not for all time.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Checks at least 4 signals" | 6 signals (table above): wallet-or-contract, age, freshly funded, flagged-address interaction, unusual approvals, activity | the six `[…]` lines in each sample below · `signals` in each check and gate proof |
| 2 | "Outputs a risk level (low, medium or high) with the specific reasons." | `RISK: LOW|MEDIUM|HIGH` plus a numbered list of reasons, each in plain words, naming the block, address or transaction it comes from where there is one | last lines of each sample · `report.verdict` and `report.reasons` in the proofs |
| 3 | "Explains each flag in plain language." | Each signal has a `detail` sentence ("It gave 0x5Be1…0aa0 an unlimited allowance … lets it take the token's whole balance later"); no codes to look up | the indented lines under each signal |
| 4 | "Demonstrated on at least 1 clean and 1 risky example." | **Clean:** a mainnet wallet, [`0x1F35…c85C`](https://www.pharosscan.xyz/address/0x1F3546a29EeC2102c8d52E21a45114124014c85C): first transaction 39 days earlier, 44,628 sent transactions, nothing flagged → LOW. **Risky:** a wallet **we created and staged** on Atlantic (below) → HIGH. | [`proof/clean-wallet.json`](proof/clean-wallet.json) · [`proof/risky-wallet.json`](proof/risky-wallet.json) |

## The risky example is staged, and we say so

`npm run make-risky-wallet -- --execute` ([`scripts/make-risky-wallet.ts`](../../scripts/make-risky-wallet.ts)) generated a **new Atlantic wallet**
`0xD6936bEcCA1A13c6A426309a694560292e9b579E` (its key stays in `~/.config/pharos/`, outside the repo), funded it with 0.01 PHRS and had it do three things:

| Step | Transaction (all `status 1`) |
|---|---|
| fund the new wallet with 0.01 PHRS | [`0xc3f97bc2…b2bf`](https://atlantic.pharosscan.xyz/tx/0xc3f97bc275eabbd9557a67462fcb7958233db8205b6eaf1e3a7b43360281b2bf) |
| wrap 0.0005 PHRS → WPHRS | [`0x5ede102a…24fa`](https://atlantic.pharosscan.xyz/tx/0x5ede102a0eadc174a0649e6ea8538e1ac442713f3261ec162d9e7b73276524fa) |
| send 0.0001 WPHRS to `0xf1a9…0001`, a made-up address with no known owner that **we put on our own flagged list** | [`0x43c4a2e8…b4da`](https://atlantic.pharosscan.xyz/tx/0x43c4a2e8aef5d32272cf8911551da1ac05fcb15a0cee84be72afa74df4f3b4da) |
| approve an unlimited WPHRS allowance to `0x5Be1…0aa0`, a made-up address that is not on our trusted list | [`0x935bcbb6…8527`](https://atlantic.pharosscan.xyz/tx/0x935bcbb67938fe5b9c983db6c9a2c8d96fc526463d073b65552d9642d7e28527) |

Nothing here is a real attacker: it shows that the signals fire on the pattern. The setup record is [`proof/risky-wallet-setup.json`](proof/risky-wallet-setup.json).

## Beyond the requirements: a risk gate in front of the Policy Gatekeeper

`gate --to 0x… --amount 0.0001` checks the recipient first. At HIGH (or MEDIUM with `--block-on medium`) it refuses, writes the refusal to the Gatekeeper's
hash-chained audit log as rule `wallet_risk`, and **never asks the policy or sends**. Otherwise the request goes to the
[Policy Gatekeeper](../policy-gatekeeper/README.md) with [`gate-policy.json`](gate-policy.json) (0.001 PHRS per transaction, 0.003 per hour), which allows or denies it as usual.
Live: the staged risky wallet was refused ([`proof/gate-denied.json`](proof/gate-denied.json), no transaction), then the clean Atlantic wallet `0x8D34…D91B`
(128 days old, LOW) was paid 0.0001 PHRS from our main test wallet ([`proof/gate-allowed.json`](proof/gate-allowed.json), tx
[`0x45cc6f34…9f51`](https://atlantic.pharosscan.xyz/tx/0x45cc6f3496866707c8d59599cc7ff45fcb6b2f311a14551c505fd8ec4d049f51), status 1). The audit log is committed:
[`audit/gate-audit.jsonl`](audit/gate-audit.jsonl) (3 entries, chain intact).

## Reproduce a report later

A check reads the chain as of its head, and the token history only reaches back `--lookback` blocks, so the staged wallet's verdict would drift as the
chain moves on. Pin it: `npm run wallet-risk-checker -- check 0xD6936bEcCA1A13c6A426309a694560292e9b579E --network atlantic --block 31566858` prints the
same six signals as [`proof/risky-wallet.json`](proof/risky-wallet.json) (every signal sentence of the proof appears in the saved re-run
[`proof/reproduce-risky-wallet.txt`](proof/reproduce-risky-wallet.txt)), and `-- check 0x1F3546a29EeC2102c8d52E21a45114124014c85C --block 20548019` does the same for the
clean wallet ([`proof/reproduce-clean-wallet.txt`](proof/reproduce-clean-wallet.txt)).

## Sample output (from the proof runs)

Risky (Atlantic, `proof/risky-wallet.json`):

```text
$ npm run wallet-risk-checker -- check 0xD6936bEcCA1A13c6A426309a694560292e9b579E --network atlantic --proof risky-wallet
risk check of 0xD6936bEcCA1A13c6A426309a694560292e9b579E on atlantic at block 31566858
  [info  ] wallet or contract (get_code)
           It is a plain wallet (no code).
  [MEDIUM] wallet age (first block with a sent transaction)
           It first sent a transaction in block 31566816, 2 minutes before block 31566858. That is under 7 days: a new address has no track record.
  [ok    ] nonce and balance (freshly funded?)
           It has sent 3 transactions (nonce 3) and holds 9355648000000000 wei, so it has been used.
  [HIGH  ] interaction with a flagged address
           It moved tokens with 0xf1a9…0001, which is on our flagged list (demo flagged address; source: our own list: we made this address up for the risky example and put it here ourselves). Transaction: 0x43c4a2e8aef5d32272cf8911551da1ac05fcb15a0cee84be72afa74df4f3b4da.
  [MEDIUM] approvals to unknown spenders
           It gave 0x5Be1…0aa0 an unlimited allowance (2^255 or more) on token 0x8388…9471 (tx 0x935bcbb67938fe5b9c983db6c9a2c8d96fc526463d073b65552d9642d7e28527). We do not recognise that spender, and an unlimited approval lets it take the token's whole balance later.
  [info  ] token activity in the lookback range
           1 token transfer with 1 counterpart in blocks 31536858–31566858 (30000 blocks).
RISK: HIGH — 3 red flags
  1. It first sent a transaction in block 31566816, 2 minutes before block 31566858. That is under 7 days: a new address has no track record.
  2. It moved tokens with 0xf1a9…0001, which is on our flagged list (demo flagged address; source: our own list: we made this address up for the risky example and put it here ourselves). Transaction: 0x43c4a2e8aef5d32272cf8911551da1ac05fcb15a0cee84be72afa74df4f3b4da.
  3. It gave 0x5Be1…0aa0 an unlimited allowance (2^255 or more) on token 0x8388…9471 (tx 0x935bcbb67938fe5b9c983db6c9a2c8d96fc526463d073b65552d9642d7e28527). We do not recognise that spender, and an unlimited approval lets it take the token's whole balance later.
```

Clean (Pharos mainnet, `proof/clean-wallet.json`):

```text
$ npm run wallet-risk-checker -- check 0x1F3546a29EeC2102c8d52E21a45114124014c85C --proof clean-wallet
risk check of 0x1F3546a29EeC2102c8d52E21a45114124014c85C on pharos at block 20548019
  [info  ] wallet or contract (get_code)
           It is a plain wallet (no code).
  [ok    ] wallet age (first block with a sent transaction)
           It first sent a transaction in block 17159978, 39 days before block 20548019. It has been around a while.
  [ok    ] nonce and balance (freshly funded?)
           It has sent 44628 transactions (nonce 44628) and holds 52893234045000000000 wei, so it has been used.
  [ok    ] interaction with flagged addresses
           None of its 1 token counterpart in blocks 20518019–20548019 is on our flagged list (1 address). Native-coin transfers leave no log and are not covered.
  [ok    ] approvals to unknown spenders
           0 open token approvals in blocks 20518019–20548019, none to a spender we do not recognise.
  [info  ] token activity in the lookback range
           1152 token transfers with 1 counterpart in blocks 20518019–20548019 (30000 blocks).
RISK: LOW — no red flags
```

Gate, refused ([`proof/gate-denied.json`](proof/gate-denied.json); the check above it is the risky report):

```text
$ npm run wallet-risk-checker -- gate --to 0xD6936bEcCA1A13c6A426309a694560292e9b579E --amount 0.0001 --proof gate-denied
[…]
GATE: DENY by wallet_risk (audit #1). 0.0001 PHRS → 0xD6936bEcCA1A13c6A426309a694560292e9b579E was NOT sent, and the policy was not asked.
audit log: 1 entries, hash chain intact (gate-audit.jsonl)
```

Gate, allowed and sent ([`proof/gate-allowed.json`](proof/gate-allowed.json)):

```text
$ npm run wallet-risk-checker -- gate --to 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B --amount 0.0001 --execute --proof gate-allowed
[…]
GATE: recipient risk is LOW, below HIGH: passing the request to the Policy Gatekeeper (risk-gate-demo).
#1 gate 0x8D34…D91B: 0.0001 PHRS → 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
  PASS time_window: 07:43 UTC is inside 00:00–23:59 UTC
  PASS spend_limit_per_tx: 0.0001 PHRS ≤ 0.001 PHRS per transaction
  PASS spend_limit_per_window: 0.0001 PHRS ≤ 0.003 PHRS over 3600 s
  => ALLOW by all_rules_passed (audit #2)
  tx executed: https://atlantic.pharosscan.xyz/tx/0x45cc6f3496866707c8d59599cc7ff45fcb6b2f311a14551c505fd8ec4d049f51
audit log: 3 entries, hash chain intact (gate-audit.jsonl)
```

## Limits (honest)

- The flagged list is ours and holds one made-up entry; real use needs real entries.
- Token history only: native-coin transfers leave no log, and the lookback is a window, not all time.
- Age of a wallet is the time of its first *sent* transaction; a wallet that only ever received funds has no measurable age (signal 3 flags it instead).
- A contract's source cannot be checked through the Chain MCP, so "verified code" is not one of the six signals; the report says to read the source.
- "Unknown spender" means "not in `trustedSpenders` or the token registry", not "malicious".
- 18 tests in `test/risk.test.ts` (each signal, the verdict rule, pinning with `--block`, config validation, the CLI and the gate refusing / passing).
