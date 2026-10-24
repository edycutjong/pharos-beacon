# x402 Agent Buyer — Hard

**Task:** [x402 Agent Buyer](https://pharos-agent-arena.vercel.app/tasks/x402-agent-buyer) (Payments · Hard · 200 pts): an agent that pays x402-paywalled APIs on Pharos Atlantic for what it uses, inside a budget.
**Run** (Atlantic testnet only; keys in `~/.config/pharos/x402.env` and `testnet.env`, never printed):
`npm run x402-agent-buyer -- run finish|budget|cap|retry|partner [--base URL] [--partner URL] [--simulate-failure before|after] [--ledger name] [--fresh] [--proof name]` · `npm run x402-agent-buyer -- log [--task finish]`.
It buys from the [x402 Paywalled API](../x402-paywalled-api/README.md) (default `https://pharos.edycu.dev`). The `finish`, `budget` and `cap` tasks use the quoted `whale-range` route, which is on branch `task/x402-paywalled-api` (and on this branch, which is built on it) but not yet on the deployed API, so start the same API locally first: `npm run x402-paywalled-api -- serve` and add `--base http://localhost:4021`. `retry` and `partner` work against the deployed API.
**Uses:** x402 SDK 2.28 (`@x402/core` 402 header decoding, `@x402/evm` exact scheme, EIP-3009 signing), viem (the token's `authorizationState` and `AuthorizationUsed` log, the settle receipt).

## What the agent does

For each thing it wants (a *want*: a route or URL, what the data is for, the most it is worth to the task) it:

1. **Asks** the route without paying. A 402 is free and states price, token and payee.
2. **Decides** ([`decide()`](agent.ts), pure): a 402 for another token or network → refuse; then, in this order, over the **per-call cap** → refuse · more than the answer is **worth** to the task → refuse · an answer it **already bought** still covers the question → refuse as redundant, counting the USDC saved · spend + unresolved payments + price over the **budget** → refuse.
3. **Signs once**, and only what was quoted: the signed amount and payee must equal the quote it just checked against the cap and budget, and an authorization valid for more than 15 minutes is not signed. The authorization goes into the journal under the purchase's idempotency key (`<task>/<want>`) *before* it is sent.
4. **Sends**, retrying the *same* signature. After a network error, an unexplained 402 or when the retries run out, it asks the token (`authorizationState`) whether the authorization was used before it does anything else.
5. **Checks the receipt** (status 1 and a USDC Transfer of exactly the price from the payer to the payee) before it accepts the data, then appends one row to the payment log: price, what it bought, tx hash, running total.

A required want refused for budget **stops** the task (the rest are not attempted); any other refusal moves on. The task is finished when every required want has data. Purchases run one at a time, and a second run on the same ledger fails at once on a lock file.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Calls at least 2 different x402 endpoints. They can be your own or another dev's." | `finish` pays three different routes of our API: `gas-snapshot` (0.001 USDC), `whale-brief` (0.01) and the quoted `whale-range` (0.005 per 1,000 blocks, 0.01 for 2,000). The `partner` task also calls another developer's live seller on Atlantic (shoupeorg's Cloudflare Worker, official test USDC, 0.001 and 0.002 USDC): the agent reads its 402s and signs, but that seller only accepts payments from its own buyer wallet, so it answers 502 `Authorization parties or amount mismatch` and nothing is charged (see Limits). | [`proof/finish.json`](proof/finish.json) (three routes paid) · [`proof/partner-seller.json`](proof/partner-seller.json) (the other developer's 402s and 502s) · [`proof/prod-gas-ok.json`](proof/prod-gas-ok.json) (the deployed API) |
| 2 | "Enforces a spend budget and a per-call price cap, and refuses calls over either one." | `decide()` refuses another token or network first, then checks the cap, and the budget last; both refusals are printed and kept in the proofs. The budget counts signed-but-unsettled payments too. | cap: [`proof/cap.json`](proof/cap.json) (`over-cap: 0.015 USDC is over the per-call cap 0.012 USDC`) · budget: [`proof/budget.json`](proof/budget.json) (`over-budget: 0.015 USDC would make the spend 0.026 USDC, over the 0.02 USDC budget (0.009 USDC left)`) · tests under "decide" |
| 3 | "Logs every payment with the price, what it bought and the tx hash, plus a running total." | `PaymentRow` in a JSONL file, one row per purchase, never two for the same key; `npm run x402-agent-buyer -- log` prints it. A payment whose settling tx is outside the 8,000-block lookback is still logged (without a tx, and the log says so). | `proof/*.payments.jsonl` · tests "buys three answers … logs a running total", "a settlement outside the lookback is still logged once" |
| 4 | "Handles payment failures with retries that are safe: the same payment never counts twice." | One idempotency key per purchase. The signed authorization is journaled before the send, and every retry re-sends it (never re-signs), so the token can settle it once (the EIP-3009 nonce). Before any new signature the token is asked whether the old one was used; one that was is logged once with the tx found from `AuthorizationUsed`; one that is unused and lapsed (plus 60 s) is replaced; one that is unused and still valid blocks a second payment. A 200 is believed only if its receipt matches the price **and** the token shows our authorization as used. | before the request leaves: [`proof/retry-before.json`](proof/retry-before.json) · after the API answered: [`proof/retry-after.json`](proof/retry-after.json) · **a real 402 after settlement on the deployed API**: [`proof/prod-gas.json`](proof/prod-gas.json) · the tests under "safe retries" |
| 5 | "Includes a demo task where the agent completes the job, and one where it stops because it hit the budget." | `finish` completes; `budget` stops with 0.009 USDC left because the next answer costs 0.015 (it stops at the first required answer that does not fit, by design, so the cheaper last want is not attempted). | [`proof/finish.json`](proof/finish.json) · [`proof/budget.json`](proof/budget.json) |

## Proof

Each run was committed before the next, so every file records `"dirty": false`, and each has its own payment log and ledger (a ledger is one budget scope; `--proof` gives a run its own, `--ledger` names one). Runs 1–5 use `serve` on this machine, 6–8 the deployed API. All settle transactions have receipt status 1. Run 6 was recorded by the first build of the agent (its log rows name the purchase `key`, later renamed `purchase`); runs 1–5, 7 and 8 are from the final code. `finish` and `budget` are re-runs: earlier attempts hit intermittent failures of the facilitator's Atlantic RPC calls (`invalid_exact_evm_transaction_failed`, a failed `eth_call`), the agent kept those authorizations pending and charged nothing, and those attempts stay in git history.

| # | Run | What it shows | Evidence |
|---|---|---|---|
| 1 | `run finish` | pays 3 answers from 3 routes (0.021 of 0.05 USDC), refuses 2 as redundant (0.006 USDC saved) and 1 as not worth it, finishes | [`proof/finish.json`](proof/finish.json) · txs [0x3b036007…e07d](https://atlantic.pharosscan.xyz/tx/0x3b036007a964b5b0233150a4a099d3edda13fff22d9c602cf1db2471cdc0e07d), [0x3dc08133…4d4e](https://atlantic.pharosscan.xyz/tx/0x3dc0813330f52a9416a36e290869b17b4a499d79e5541109cc8c69bc11ca4d4e), [0x3861353a…e3a8](https://atlantic.pharosscan.xyz/tx/0x3861353a386fcf578dc646c287682cc763ad3e7ff28124761efcfff28624e3a8) |
| 2 | `run budget` | pays 2 (0.011 of 0.02 USDC), refuses the 0.015 answer as over budget, stops, 1 want not attempted | [`proof/budget.json`](proof/budget.json) · txs [0x65d212b8…d1ce](https://atlantic.pharosscan.xyz/tx/0x65d212b8d7dff93101fa767cb5e0b9a915f9040caeb1a3a15970712dcec5d1ce), [0x629b5c91…c636](https://atlantic.pharosscan.xyz/tx/0x629b5c91daf96a36d9b5221c05588d2f52566301307e3ae4fe5b82f34cdfc636) |
| 3 | `run cap` | cap 0.012 USDC: refuses the 0.015 answer, pays the other two, finishes | [`proof/cap.json`](proof/cap.json) · txs [0xa0a5be0e…b9a0](https://atlantic.pharosscan.xyz/tx/0xa0a5be0e5b5a74799921667701737e8d941aab1e12e9210315c13ea5bfd7b9a0), [0xe3396c3f…6fd1](https://atlantic.pharosscan.xyz/tx/0xe3396c3f2d8647e337b5b2ad511f19c15e2251dc09537c5652a52f47caf06fd1) |
| 4 | `run retry --simulate-failure before` | the request never leaves; the retry re-sends the same signature; one payment | [`proof/retry-before.json`](proof/retry-before.json) · tx [0x27059b2f…5951](https://atlantic.pharosscan.xyz/tx/0x27059b2f52e855337c1701d68583100bb45dafba2137ec702468e48f97c15951) |
| 5 | `run retry --simulate-failure after` | the API settles, the response is lost; the agent finds the settlement on chain, logs it once, does not pay again, and reports the answer as lost | [`proof/retry-after.json`](proof/retry-after.json) · tx [0xcd7f2eea…66bf](https://atlantic.pharosscan.xyz/tx/0xcd7f2eea7864038678254e9bf854e1c0009e6f3b588198b0cafa0f9fd3f966bf) |
| 6 | `run retry --base https://pharos.edycu.dev` (**uncontrolled**) | the deployed API answered the paid request with **402** although the payment had settled; the agent asked the token, found the authorization used, logged it once and did not sign again | [`proof/prod-gas.json`](proof/prod-gas.json) · tx [0x5ec452d5…c6d2](https://atlantic.pharosscan.xyz/tx/0x5ec452d5b760ab89c05eaba81c9a9e873542efe2827409bca133de5db5eec6d2) |
| 7 | the same command, run again | a plain paid purchase from the deployed API | [`proof/prod-gas-ok.json`](proof/prod-gas-ok.json) · tx [0x0f6d881f…f764](https://atlantic.pharosscan.xyz/tx/0x0f6d881f989c154aa889df3a0f267a30cfdce0bdf7a6a8dca74a2e4133bbf764) |
| 8 | `run partner` | our gas route paid; another developer's two routes: 402 read, authorization signed, 502 ×3, authorization unused on chain, nothing charged, task ends unfinished | [`proof/partner-seller.json`](proof/partner-seller.json) · tx [0x34154efa…7c3a](https://atlantic.pharosscan.xyz/tx/0x34154efac971003f7b220a174753bc19dbf1ce2a2b3b6348d704ac35c7b57c3a) (ours) |

Run 6 is not staged. The deployed API answered the paid request with 402 after the transfer had gone through; the response body was not recorded in that run, so the cause is not proven (the API's settle step answers 402 `invalid_exact_evm_transaction_failed` when it cannot confirm the transaction, and the Atlantic RPC fails intermittently, as the re-runs of `finish` and `budget` show). It is the failure the reconcile step exists for: an agent that read that 402 as "refused, nothing charged" could have signed a second payment. Since then the agent records the response body of every failed attempt (the 502 bodies in run 8).

Sample output of `run finish`, rendered from `proof/finish.json` (the explorer base URL is cut from the tx hashes):

```text
task finish: 6 wants · budget 0.05 USDC · per-call cap 0.02 USDC
  API http://localhost:4021 · payer 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  ask      gas          GET gas-snapshot → 402, price 0.001 USDC
  sign     gas          0.001 USDC · key finish/gas · nonce 0x05c7af2e…53562c · journaled first
  send #1  gas          HTTP 200
  PAID     gas          0.001 USDC · tx 0x3b036007…c0e07d · running total 0.001 USDC
  ask      whales       GET whale-brief → 402, price 0.01 USDC
  sign     whales       0.01 USDC · key finish/whales · nonce 0xe40d9401…3b008d · journaled first
  send #1  whales       HTTP 200
  PAID     whales       0.01 USDC · tx 0x3dc08133…ca4d4e · running total 0.011 USDC
  ask      whales-1k    GET whale-range?blocks=1000 → 402, price 0.005 USDC
  REFUSED  whales-1k    redundant: already bought (finish/whales) and it still answers this: skipping saves 0.005 USDC
  ask      gas-again    GET gas-snapshot → 402, price 0.001 USDC
  REFUSED  gas-again    redundant: already bought (finish/gas) and it still answers this: skipping saves 0.001 USDC
  ask      range        GET whale-range?blocks=2000 → 402, price 0.01 USDC
  sign     range        0.01 USDC · key finish/range · nonce 0xb0a98eda…ea0dff · journaled first
  send #1  range        HTTP 200
  PAID     range        0.01 USDC · tx 0x3861353a…24e3a8 · running total 0.021 USDC
  ask      deep-history GET whale-range?blocks=3000 → 402, price 0.015 USDC
  REFUSED  deep-history not-worth: 0.015 USDC is more than this is worth to the task (0.01 USDC)
FINISHED finish: 3 paid · spent 0.021 USDC of 0.05 USDC (0.029 USDC left) · 3 refused · saved 0.006 USDC
payment log:
 1  0.001 USDC   total 0.001 USDC   Atlantic gas price now, to cost the transfer
    0x3b036007a964b5b0233150a4a099d3edda13fff22d9c602cf1db2471cdc0e07d
 2  0.01 USDC    total 0.011 USDC   largest USDC transfers on Pharos mainnet, last ~1,000 blocks
    0x3dc0813330f52a9416a36e290869b17b4a499d79e5541109cc8c69bc11ca4d4e
 3  0.01 USDC    total 0.021 USDC   twice the history: the largest USDC transfers over 2,000 blocks
    0x3861353a386fcf578dc646c287682cc763ad3e7ff28124761efcfff28624e3a8
```

`run retry --simulate-failure after`:

```text
task retry: 1 wants · budget 0.01 USDC · per-call cap 0.01 USDC
  API http://localhost:4021 · payer 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  ask      gas          GET gas-snapshot → 402, price 0.001 USDC
  sign     gas          0.001 USDC · key retry/gas · nonce 0x7fdfcc7a…08d445 · journaled first
  send #1  gas          FAILED: simulated network failure: the API answered, the response was lost
  check    gas          authorization 0x7fdfcc7a… was used in 0xcd7f2eea78…: it settled once
UNFINISHED retry: 1 paid · spent 0.001 USDC of 0.01 USDC (0.009 USDC left) · 0 refused · saved 0 USDC
payment log:
 1  0.001 USDC   total 0.001 USDC   Atlantic gas price now
    0xcd7f2eea7864038678254e9bf854e1c0009e6f3b588198b0cafa0f9fd3f966bf
    note: the response was lost after the API settled; counted once, not bought again
```

Run 6, the deployed API's 402 after settlement:

```text
task retry: 1 wants · budget 0.01 USDC · per-call cap 0.01 USDC
  API https://pharos.edycu.dev · payer 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  ask      gas          GET gas-snapshot → 402, price 0.001 USDC
  sign     gas          0.001 USDC · key retry/gas · nonce 0xef841ae1…1317f5 · journaled first
  send #1  gas          HTTP 402
  check    gas          authorization 0xef841ae1… was used in 0x5ec452d5b7…: it settled once
UNFINISHED retry: 1 paid · spent 0.001 USDC of 0.01 USDC (0.009 USDC left) · 0 refused · saved 0 USDC
payment log:
 1  0.001 USDC   total 0.001 USDC   Atlantic gas price now
    0x5ec452d5b760ab89c05eaba81c9a9e873542efe2827409bca133de5db5eec6d2
    note: the response was lost after the API settled; counted once, not bought again
```

`run partner`, abridged (the other developer's seller):

```text
task partner: 3 wants · budget 0.01 USDC · per-call cap 0.005 USDC
  API https://pharos.edycu.dev · payer 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  ask      ours         GET gas-snapshot → 402, price 0.001 USDC
  sign     ours         0.001 USDC · key partner/ours · nonce 0xf213d632…9890e3 · journaled first
  send #1  ours         HTTP 200
  PAID     ours         0.001 USDC · tx 0x34154efa…b57c3a · running total 0.001 USDC
  ask      theirs-snapshot GET https://pharos-x402-paywalled-api.shoupeorg.workers.dev/paid/network-snapshot?block=31802200 → 402, price 0.001 USDC
  sign     theirs-snapshot 0.001 USDC · key partner/theirs-snapshot · nonce 0xbf43a9eb…32c7e6 · journaled first
  send #1  theirs-snapshot HTTP 502 {"error":"Authorization parties or amount mismatch","state":"PENDING_R
  FAILED   theirs-snapshot HTTP 502 on the paid request
  send #2  theirs-snapshot HTTP 502 {"error":"Authorization parties or amount mismatch","state":"PENDING_R
  FAILED   theirs-snapshot HTTP 502 on the paid request
  send #3  theirs-snapshot HTTP 502 {"error":"Authorization parties or amount mismatch","state":"PENDING_R
  FAILED   theirs-snapshot HTTP 502 on the paid request
  …(the same for theirs-activity)…
UNFINISHED partner: 1 paid · spent 0.001 USDC of 0.01 USDC (0.009 USDC left) · 0 refused · saved 0 USDC
```

## Beyond the requirements

- **Value check before paying.** An answer already bought is reused when it still covers the question, and the buy is refused as redundant with the USDC it saved. It works across routes: `whale-brief` returned the largest USDC transfers of the latest 1,000 mainnet blocks, so asking `whale-range?blocks=1000` (0.005 USDC) is refused (run 1). In general a whale answer covers a window of N blocks when its range holds the last N blocks of its own head and at least `top` of its listed transfers lie inside that window (a transfer that is in the top list and in the window is also in the window's own top list). `gas-snapshot` is reused for 60 s, whale answers for 10 minutes. The check happens after the free 402, so the price saved is the real one.
- **Reconciliation from the chain.** After a lost response, a 402 or exhausted retries the agent does not guess: `authorizationState(payer, nonce)` on the token says whether the payment settled, and the token's `AuthorizationUsed` event gives the transaction.
- **Receipt before data.** A 200 with a `PAYMENT-RESPONSE` is not enough: no status-1 receipt with the matching USDC Transfer, no data accepted. A mined payment that does not match is counted as spent, not forgotten.
- **Keys.** The private key is read once from the environment or `~/.config/pharos/`, never printed or logged. The signed authorization (a bearer instrument until it lapses) lives only in the gitignored `state/` journal; logs and proofs carry the nonce, not the signature.

## Limits

- Paid endpoints: only our own API settled a payment. The other developer's seller (`pharos-x402-paywalled-api.shoupeorg.workers.dev`, found from their public README) only accepts payments from its own buyer wallet (its source, `src/seller.js` line 28, throws unless the authorization is from its configured buyer); our authorization is refused with 502 `Authorization parties or amount mismatch` (recorded in `proof/partner-seller.json`). The two authorizations we signed for it (0.001 and 0.002 USDC) stayed valid for up to 5 minutes (its `maxTimeoutSeconds`) and were never used on chain; the agent counted them against the budget. That the agent pays a third-party seller that accepts strangers is therefore untested here: it is built to (any x402 `exact` endpoint that asks for the registry test USDC on `eip155:688689`), and refuses any other token or network (`wrong-asset`).
- After a failure *after* settlement the data is lost: the agent counts the payment once and reports "paid, answer lost" instead of buying again under the same key. A new purchase needs a new want. Run 6 shows the real case, and run 7 the next attempt.
- The retry-after run drops the response in the buyer's `fetch`; it simulates the network failure, it does not create a real one. The re-send of a settled signature being refused is the paywalled API's own proof (`x402-paywalled-api/proof/replay.json`); here the agent asks the token first, so it does not re-send.
- Whether an answer is "worth" its price is a number the task sets per want, not a model's judgment. The value check covers gas and whale questions only. A cached whale answer measures "the last N blocks" from its own head, so after minutes it answers the question about a slightly older window; the 10-minute limit bounds that. Ties at the same amount can list a different transfer.
- The ledger (journal and payment log) is local files. One run per ledger at a time (lock file); purchases inside a process are serialized. Two processes calling `buy` directly instead of `run` are not coordinated.
- Authorizations that stay unsettled count against the budget. Before each decision the agent checks the older ones against the token: a payment that settled is logged, one that lapsed unused (its `validBefore` plus 60 s) stops counting. A refused or lost payment can therefore hold part of the budget for a few minutes.
- `whale-range` is on branch `task/x402-paywalled-api`, so three demo tasks need the local `serve` until that branch is deployed.

## Tests

`npx vitest run test/x402-agent-buyer.test.ts` — 42 tests in [`test/x402-agent-buyer.test.ts`](../../test/x402-agent-buyer.test.ts), offline (a stand-in API that issues real 402 headers and settles each EIP-3009 nonce once, and a stand-in chain): the policy order (asset, cap, worth, cache, budget, the exact-budget boundary), when a cached answer covers a question, the finish / budget / cap tasks, retries before and after settlement, a 402 after settlement, exhausted retries, a settlement outside the lookback, a re-run of a finished task (no request, no payment), pending payments counting against the budget, a lapsed authorization re-signed once, a mismatched or reverted or unreadable receipt, an authorization that is too long-lived, the right offer picked from several, a key reused for another question, two purchases at once, a second run on the same ledger, a seller at another URL, and no key or signature in any log.
