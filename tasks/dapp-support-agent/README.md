# dApp Support Agent — Easy

**Task:** [dApp Support Agent](https://pharos-agent-arena.vercel.app/tasks/dapp-support-agent) (Support / Reporting · Easy · 50 pts):
explains why a transaction failed, on request.
**Run:** `npm run dapp-support-agent -- 0x<txHash> [--network atlantic|pharos] [--json] [--proof label]` (Atlantic needs the one-time `npm run setup:mcp`, keyless; `--network pharos` uses the hosted Chain MCP)
**Uses:** Chain MCP ✅ (`get_transaction`, `get_transaction_receipt`, `eth_call`, `estimate_gas`) · Docs MCP: not used · SkillEngine: not used

Try it (keyless, no setup) on a real failed **mainnet** transaction we did not create, sent by someone else's wallet to someone else's contract:
`npm run dapp-support-agent -- 0x360551d640f569c208de26a7380230fac002cdc7fc7378501decc6a6bc64227c --network pharos`
or on one of our own failed Atlantic transactions below (needs `npm run setup:mcp` once), for example the out-of-gas one:
`npm run dapp-support-agent -- 0x4e6cc4339009576aada882d2d843d1ee0e33f0bce2ddeddfdc8d41cc41414ab5`

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | Accepts a tx hash and fetches the transaction and receipt via Chain MCP | the one positional argument is the hash (checked: `0x` + 64 hex); `diagnose` calls `get_transaction` then `get_transaction_receipt` | `tasks/dapp-support-agent/diagnose.ts` `diagnose` · every [proof](proof/balance.json) records the endpoint and tools |
| 2 | Identifies the failure cause: revert reason, out of gas, insufficient balance or allowance, etc. | replays the exact call with `eth_call` at the block before and decodes the revert bytes (`Error(string)`, `Panic`, OpenZeppelin token errors, ownership, pause); out of gas = replay fails with an out-of-gas error, or gas used equals the gas limit | [balance](proof/balance.log) · [allowance](proof/allowance.log) · [out of gas](proof/out-of-gas.log) · [empty revert](proof/empty-revert.log) |
| 3 | Explains it without jargon and suggests a fix | every report has *What happened*, *Why*, *What you can do* in plain words; amounts carry the token's symbol and decimals; the raw evidence is last, under its own heading | the output block below · `formatDiagnosis` |
| 4 | Demonstrated on at least 3 different failure types | 4 real failed transactions on Atlantic from our own wallet, one per type, plus a successful one; and two failed Pharos **mainnet** transactions from wallets we do not control (rows 6 and 7 below): a contract revert reason, and a failure the replay cannot reproduce | table below · [`proof/failed-txs.json`](proof/failed-txs.json) |

## What it does

Given a transaction hash it reads the transaction and its receipt. A successful receipt is answered with "This transaction did not
fail." A failed one is replayed with `eth_call` at the block before it (same sender, value, data and gas limit), which is the state the
transaction started from. A revert comes back as JSON-RPC code 3 with the reason bytes; those are decoded and, for token errors, the token's
`symbol()` and `decimals()` are read so amounts have units. An out-of-gas failure gets a suggested gas limit from `estimate_gas`
(estimated now, with a 25% margin). If the contract reverts without any message, the agent only names a cause when the numbers prove it for
a `transfer`, `transferFrom` or `withdraw` call (balance or allowance too small) and says in the report that the cause is inferred; otherwise
it says the contract gave no reason. No language model is involved: the same hash and chain state give the same report (only the suggested gas limit is read live).

## Chain MCP tools

| Tool | Used for |
|---|---|
| `get_chain_info` | chain check at connect (every run) |
| `get_transaction` | sender, target, input, value, gas limit |
| `get_transaction_receipt` | status, gas used, block |
| `eth_call` | replay at the block before; `symbol()`, `decimals()`, `balanceOf`, `allowance` for amounts and the inference |
| `estimate_gas` | suggested gas limit after an out-of-gas failure |

## Proof (live runs on Atlantic, chain 688689, and on Pharos mainnet, chain 1672)

The failed transactions were sent by `npm run make-failed-txs -- --execute --proof` ([`scripts/make-failed-txs.ts`](../../scripts/make-failed-txs.ts)):
each is signed with an explicit gas limit and mined with status 0x0. Their receipts are in [`proof/failed-txs.json`](proof/failed-txs.json).
(Two earlier attempts of the same script, before the out-of-gas limit was lowered to fit, left six other test transactions on the chain: four failed and two that succeeded. They are not used here.)

| # | Type | Transaction | What the agent found | Files |
|---|---|---|---|---|
| 1 | insufficient balance (token) | [`0x9db3…5f11`](https://atlantic.pharosscan.xyz/tx/0x9db3e679e2d7a9f8a6a21052800be283a45862722418f94ae7bb11fa79285f11) | `ERC20InsufficientBalance` read from the replay | [`proof/balance.json`](proof/balance.json) · [log](proof/balance.log) |
| 2 | insufficient allowance (token) | [`0x8b9b…bf93`](https://atlantic.pharosscan.xyz/tx/0x8b9b9353b9df376bf05067d5cc3fc921730ddc7a78cbbdac0c071e5d2970bf93) | `ERC20InsufficientAllowance` read from the replay | [`proof/allowance.json`](proof/allowance.json) · [log](proof/allowance.log) |
| 3 | out of gas | [`0x4e6c…4ab5`](https://atlantic.pharosscan.xyz/tx/0x4e6cc4339009576aada882d2d843d1ee0e33f0bce2ddeddfdc8d41cc41414ab5) | gas used 24000 = gas limit 24000; replay says out of gas | [`proof/out-of-gas.json`](proof/out-of-gas.json) · [log](proof/out-of-gas.log) |
| 4 | revert with no message | [`0xf05c…2515`](https://atlantic.pharosscan.xyz/tx/0xf05ce6e6b1394e833196fc88b27bbea37a96300cc0683c7a26fbd7aa15db2515) | empty revert data; cause inferred from the balance and labelled as inferred | [`proof/empty-revert.json`](proof/empty-revert.json) · [log](proof/empty-revert.log) |
| 5 | a successful tx (control) | [`0xee5e…5e0b`](https://atlantic.pharosscan.xyz/tx/0xee5ef39c357f34e39a4c8902dd59b51bcc0a116d6a686bbffa9501c0dd525e0b) | "This transaction did not fail." | [`proof/success.json`](proof/success.json) · [log](proof/success.log) |
| 6 | mainnet, not ours: revert with a reason string | [`0x3605…227c`](https://www.pharosscan.xyz/tx/0x360551d640f569c208de26a7380230fac002cdc7fc7378501decc6a6bc64227c) (block 20567567, from `0x7ac6…936c` to `0x69dc…0da4`; found by scanning receipts for status 0x0) | the contract's own message `"BC"`, read from the replay and quoted; the report does not guess what the code means | [`proof/mainnet-third-party-revert.json`](proof/mainnet-third-party-revert.json) |
| 7 | mainnet, not ours: failure the replay cannot reproduce | [`0xa449…6951`](https://www.pharosscan.xyz/tx/0xa449024e34e2249da119183eb5b877f4b2294d70daf8d5b1c0929fe99b136951) (block 20567558, from `0xc5f6…0f45`) | the replay one block earlier succeeds (gas 166007 < limit 540000), so the agent says the cause cannot be read from here and does not invent one | [`proof/mainnet-third-party-not-reproduced.json`](proof/mainnet-third-party-not-reproduced.json) |

Rows 6 and 7 replay with `eth_call` at an old mainnet block, so they need the hosted node to still serve that block's state; if it stops, the committed proofs remain.

The mainnet run of row 6 (output of the proof run, keyless):

```text
$ npm run dapp-support-agent -- 0x360551d640f569c208de26a7380230fac002cdc7fc7378501decc6a6bc64227c --network pharos
Transaction  0x360551d640f569c208de26a7380230fac002cdc7fc7378501decc6a6bc64227c
Network      pharos (chain 1672) via https://mcp.pharos.xyz/mcp
Explorer     https://www.pharosscan.xyz/tx/0x360551d640f569c208de26a7380230fac002cdc7fc7378501decc6a6bc64227c

Result       FAILED
Cause        revert-reason

What happened
  The contract refused the transaction and gave this reason: "BC".

Why
  The contract checked a condition, it was not met, and the contract stopped the transaction with the message "BC". Nothing was changed; you only paid the network fee.

What you can do
  - Change the input that the message points at (an amount, an address or a deadline) and send again.
  - If you did not expect this, ask the dApp's support, quoting the message and the transaction link.

Evidence (for the curious)
  · receipt status 0x0 in block 20567567
  · replayed with eth_call at block 20567566 (the state the transaction started from), same sender, value, data and gas limit
  · revert reason string: "BC"
```

```text
$ npm run dapp-support-agent -- 0x4e6cc4339009576aada882d2d843d1ee0e33f0bce2ddeddfdc8d41cc41414ab5
Transaction  0x4e6cc4339009576aada882d2d843d1ee0e33f0bce2ddeddfdc8d41cc41414ab5
Network      atlantic (chain 688689) via local stdio PharosNetwork/pharos-mcp@9a3750c
Explorer     https://atlantic.pharosscan.xyz/tx/0x4e6cc4339009576aada882d2d843d1ee0e33f0bce2ddeddfdc8d41cc41414ab5

Result       FAILED
Cause        out-of-gas

What happened
  The transaction ran out of gas: it was given 24,000 units and used all of them before it finished.

Why
  Gas is the fee budget a sender sets for a transaction. This one was given 24,000 units, the work needed more, so the network stopped it half-way and kept the fee for the work already done (24,000 of 24,000 used).

What you can do
  - Send it again with a higher gas limit: the call needs about 37,096 units now, so set at least 46,370 (a 25% margin).
  - In a wallet, use the automatic gas estimate instead of typing a limit.

Evidence (for the curious)
  · receipt status 0x0 in block 31560421
  · replayed with eth_call at block 31560420 (the state the transaction started from), same sender, value, data and gas limit
  · gasUsed 24000 = gas limit 24000
  · replaying the call with the same gas limit at the block before fails with an out-of-gas error
  · estimate_gas now: 37096
proof: tasks/dapp-support-agent/proof/out-of-gas.json
```

What the agent says first, for each type (copied from the proof logs):

| Type | What happened |
|---|---|
| insufficient balance | Your wallet does not hold enough USDC: it has 0 USDC and the transaction needed 1,000,000,000 USDC. |
| insufficient allowance | Your wallet is not approved to move that much USDC: it is allowed 0 USDC and the transaction needed 0.000001 USDC. |
| out of gas | The transaction ran out of gas: it was given 24,000 units and used all of them before it finished. |
| revert with no message | Your wallet does not hold enough WPHRS: it has 0.0022 WPHRS and the transaction tried to withdraw 1,000,000 WPHRS. |

## Tests

`npm test` runs 21 tests for this task (`test/dapp-support-agent.test.ts`): each cause (balance, allowance, reason string, panic, access and pause errors, unknown
error selector, out of gas with and without a second problem, empty revert with and without an inference, a failure that cannot be reproduced), the success,
not-found and pending answers, the replay block, the report layout and the CLI (hash validation, `--json`).

## Limits

- The replay starts from the block before the failing one, so transactions earlier in the same block are not replayed; if one of them caused the failure the agent says it could not reproduce it.
- The error list is the common library errors (OpenZeppelin tokens, ownership, pause, access control) plus `Error(string)` and `Panic`. A custom error outside it is reported with its selector, not guessed.
- An empty revert is only explained for `transfer`, `transferFrom` and `withdraw(uint256)` calls, and the report says the cause is inferred.
- Insufficient native balance cannot be shown on chain (standard EVM behaviour): the network refuses to mine such a transaction, so there is no failed transaction to explain.
- The suggested gas limit is estimated at the current state, not at the failing block.
