# x402 Agent Buyer — Hard

**Task:** [x402 Agent Buyer](https://pharos-agent-arena.vercel.app/tasks/x402-agent-buyer) (Payments · Hard · 200 pts): an agent that pays x402-paywalled APIs on Pharos Atlantic for what it uses, inside a budget.
**What is different:** it decides before it pays. Each price comes from a free 402; a buy is refused over the cap, over what the answer is worth to the task, when an earlier answer already covers it (`whale-brief` covers `whale-range?blocks=1000`, saved 0.006 USDC), or over the budget, in that order. A real 402 after a mined settlement was paid once, not twice (`proof/prod-gas.json`).
**Run** (Atlantic testnet only; keys in `~/.config/pharos/x402.env` and `testnet.env`, never printed):
`npm run x402-agent-buyer -- run finish|budget|cap|retry|partner [--base URL | --local] [--partner URL] [--simulate-failure before|after] [--ledger name] [--compact] [--fresh] [--proof name]` (`--local` = `--base http://localhost:4021`; `--compact` prints one line of at most 62 characters per event, which is what the video shows) · `npm run x402-agent-buyer -- log [--task finish]`.
It buys from the [x402 Paywalled API](../x402-paywalled-api/README.md) (default `https://pharos.edycu.dev`), which serves all three priced routes, the quoted `whale-range` included. `npm run x402-paywalled-api -- serve` with `--base http://localhost:4021` (or `--local`) runs the same API on this machine.
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

Each run was committed before the next, so every file records `"dirty": false`, and each has its own payment log and ledger (a ledger is one budget scope; `--proof` gives a run its own, `--ledger` names one). Runs 1–5 use `serve` on this machine, 6–9 the deployed API. All settle transactions have receipt status 1. Run 6 was recorded by the build before the round-2 changes (commit `7b98786`): its log rows and `sign` event name the purchase `key`, later renamed `purchase`; runs 1–5 and 7–9 are from the final code. `finish` and `budget` are re-runs: earlier attempts hit intermittent failures of the facilitator's Atlantic RPC calls (`invalid_exact_evm_transaction_failed`, a failed `eth_call`), the refused authorizations stayed unused on chain and were charged nothing (the other wants in those attempts did settle), and those attempts stay in git history.

| # | Run | What it shows | Evidence |
|---|---|---|---|
| 1 | `run finish` | pays 3 answers from 3 routes (0.021 of 0.05 USDC), refuses 2 as redundant (0.006 USDC saved) and 1 as not worth it, finishes | [`proof/finish.json`](proof/finish.json) · txs [0x7f432c1c…c4da](https://atlantic.pharosscan.xyz/tx/0x7f432c1cc8decc09ee2e8f0754ebd9081fb94aba1620085a68952e97e4bbc4da), [0xebe08961…b4bf](https://atlantic.pharosscan.xyz/tx/0xebe0896194c46993fcf28d24b358041269d0242cb91a7c3fbf861913dff3b4bf), [0x368a9015…7c54](https://atlantic.pharosscan.xyz/tx/0x368a90157b818570e6e04e64d342a95ed1874ff697766a4a2f4dbabde7917c54) |
| 2 | `run budget` | pays 2 (0.011 of 0.02 USDC), refuses the 0.015 answer as over budget, stops, 1 want not attempted | [`proof/budget.json`](proof/budget.json) · txs [0xe6b5a6c2…c52c](https://atlantic.pharosscan.xyz/tx/0xe6b5a6c22f0414682cd0142a3788d526a5298d2d97c7486faad1e291299cc52c), [0xff17cb9a…f2c2](https://atlantic.pharosscan.xyz/tx/0xff17cb9a9af5829b0c14222b6aa178d5e904e86939e2fd91799c7c12e90cf2c2) |
| 3 | `run cap` | cap 0.012 USDC: refuses the 0.015 answer, pays the other two, finishes | [`proof/cap.json`](proof/cap.json) · txs [0xffddb48b…e205](https://atlantic.pharosscan.xyz/tx/0xffddb48be82fd1c2803163574720310cf75bb9d6962a207a49c2b85bec1ce205), [0xa3691639…ec8e](https://atlantic.pharosscan.xyz/tx/0xa3691639de5b55dcdf3b8bfb0c719c66251ca084b9cde8af5d0be2056322ec8e) |
| 4 | `run retry --simulate-failure before` | the request never leaves; the retry re-sends the same signature; one payment | [`proof/retry-before.json`](proof/retry-before.json) · tx [0x09b33dbf…e1d1](https://atlantic.pharosscan.xyz/tx/0x09b33dbf18471e12cf66377387ab740d96ff49cc47765816a7260205a197e1d1) |
| 5 | `run retry --simulate-failure after` | the API settles, the response is lost; the agent finds the settlement on chain, logs it once, does not pay again, and reports the answer as lost | [`proof/retry-after.json`](proof/retry-after.json) · tx [0x97e67f2c…c4fb](https://atlantic.pharosscan.xyz/tx/0x97e67f2c14ef62e50081f3c52d3b83adab1edcaa0cb08d6d4f30a83b0ab7c4fb) |
| 6 | `run retry --base https://pharos.edycu.dev` (**uncontrolled**) | the deployed API answered the paid request with **402** although the payment had settled; the agent asked the token, found the authorization used, logged it once and did not sign again | [`proof/prod-gas.json`](proof/prod-gas.json) · tx [0x5ec452d5…c6d2](https://atlantic.pharosscan.xyz/tx/0x5ec452d5b760ab89c05eaba81c9a9e873542efe2827409bca133de5db5eec6d2) |
| 7 | the same command, run again | a plain paid purchase from the deployed API | [`proof/prod-gas-ok.json`](proof/prod-gas-ok.json) · tx [0x557afe08…0ae2](https://atlantic.pharosscan.xyz/tx/0x557afe0805b8f22eac783142f5ca5d49c6ac28b9f1000afc3891af0ad3780ae2) |
| 8 | `run partner` | our gas route paid; another developer's two routes: 402 read, authorization signed, 502 ×3, authorization unused on chain, nothing charged, task ends unfinished | [`proof/partner-seller.json`](proof/partner-seller.json) · tx [0x104dca5e…98dd](https://atlantic.pharosscan.xyz/tx/0x104dca5edf05c1ecb424a152961b7eff1d906e238c253b38016ca922682398dd) (ours) |
| 9 | `run finish --base https://pharos.edycu.dev` | the same task as run 1 against the deployed API (2026-10-25): pays 3 answers from 3 routes (0.021 of 0.05 USDC), refuses 2 as redundant (0.006 USDC saved) and 1 as not worth it, finishes | [`proof/prod-finish.json`](proof/prod-finish.json) · txs [0xb0339572…31f1](https://atlantic.pharosscan.xyz/tx/0xb03395724c278293ec7b2e2548fc0c2be184ec2cc0b7ca7b29346934df2531f1), [0x7680d4ac…323f](https://atlantic.pharosscan.xyz/tx/0x7680d4ac0176eeebde0a5ab57d58055e62687a9550fbaf0311cdfaeac000323f), [0xbed7f76f…764a9b](https://atlantic.pharosscan.xyz/tx/0xbed7f76fd023c5049c0a63eea40b031d3fa350a2085b635e50d4d5e1bd764a9b) |

Run 6 is not staged. The deployed API answered the paid request with 402 after the transfer had gone through; the response body was not recorded in that run, so the cause is not proven (the API's settle step answers 402 `invalid_exact_evm_transaction_failed` when it cannot confirm the transaction, and the Atlantic RPC fails intermittently, as the re-runs of `finish` and `budget` show). It is the failure the reconcile step exists for: an agent that read that 402 as "refused, nothing charged" could have signed a second payment. Since then the agent records the response body of every failed attempt (the 502 bodies in run 8).

The demo video is made of recorded casts of `run … --local --compact`: separate runs of the same commands as the proofs. Their transactions are in [`proof/video-casts.log`](proof/video-casts.log).

Sample output of `run finish`, rendered from `proof/finish.json` (the explorer base URL is cut from the tx hashes):

```text
task finish: 6 wants · budget 0.05 USDC · per-call cap 0.02 USDC
  API http://localhost:4021 · payer 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  ask      gas          GET gas-snapshot → 402, price 0.001 USDC
  sign     gas          0.001 USDC · key finish/gas · nonce 0x95482953…e49aec · journaled first
  send #1  gas          HTTP 200
  PAID     gas          0.001 USDC · tx 0x7f432c1c…bbc4da · running total 0.001 USDC
  ask      whales       GET whale-brief → 402, price 0.01 USDC
  sign     whales       0.01 USDC · key finish/whales · nonce 0x3e2d5c21…161ca7 · journaled first
  send #1  whales       HTTP 200
  PAID     whales       0.01 USDC · tx 0xebe08961…f3b4bf · running total 0.011 USDC
  ask      whales-1k    GET whale-range?blocks=1000 → 402, price 0.005 USDC
  REFUSED  whales-1k    redundant: already bought (finish/whales) and it still answers this: skipping saves 0.005 USDC
  ask      gas-again    GET gas-snapshot → 402, price 0.001 USDC
  REFUSED  gas-again    redundant: already bought (finish/gas) and it still answers this: skipping saves 0.001 USDC
  ask      range        GET whale-range?blocks=2000 → 402, price 0.01 USDC
  sign     range        0.01 USDC · key finish/range · nonce 0x69f38673…bac495 · journaled first
  send #1  range        HTTP 200
  PAID     range        0.01 USDC · tx 0x368a9015…917c54 · running total 0.021 USDC
  ask      deep-history GET whale-range?blocks=3000 → 402, price 0.015 USDC
  REFUSED  deep-history not-worth: 0.015 USDC is more than this is worth to the task (0.01 USDC)
FINISHED finish: 3 paid · spent 0.021 USDC of 0.05 USDC (0.029 USDC left) · 3 refused · saved 0.006 USDC
payment log:
 1  0.001 USDC   total 0.001 USDC   Atlantic gas price now, to cost the transfer
    0x7f432c1cc8decc09ee2e8f0754ebd9081fb94aba1620085a68952e97e4bbc4da
 2  0.01 USDC    total 0.011 USDC   largest USDC transfers on Pharos mainnet, last ~1,000 blocks
    0xebe0896194c46993fcf28d24b358041269d0242cb91a7c3fbf861913dff3b4bf
 3  0.01 USDC    total 0.021 USDC   twice the history: the largest USDC transfers over 2,000 blocks
    0x368a90157b818570e6e04e64d342a95ed1874ff697766a4a2f4dbabde7917c54
```

`run retry --simulate-failure after`:

```text
task retry: 1 wants · budget 0.01 USDC · per-call cap 0.01 USDC
  API http://localhost:4021 · payer 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  ask      gas          GET gas-snapshot → 402, price 0.001 USDC
  sign     gas          0.001 USDC · key retry/gas · nonce 0x553d99e9…464a17 · journaled first
  send #1  gas          FAILED: simulated network failure: the API answered, the response was lost
  check    gas          authorization 0x553d99e9… was used in 0x97e67f2c14…: it settled once
UNFINISHED retry: 1 paid · spent 0.001 USDC of 0.01 USDC (0.009 USDC left) · 0 refused · saved 0 USDC
payment log:
 1  0.001 USDC   total 0.001 USDC   Atlantic gas price now
    0x97e67f2c14ef62e50081f3c52d3b83adab1edcaa0cb08d6d4f30a83b0ab7c4fb
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
  sign     ours         0.001 USDC · key partner/ours · nonce 0x4f206339…9abe83 · journaled first
  send #1  ours         HTTP 200
  PAID     ours         0.001 USDC · tx 0x104dca5e…2398dd · running total 0.001 USDC
  ask      theirs-snapshot GET https://pharos-x402-paywalled-api.shoupeorg.workers.dev/paid/network-snapshot?block=31804032 → 402, price 0.001 USDC
  sign     theirs-snapshot 0.001 USDC · key partner/theirs-snapshot · nonce 0x2286f9f6…f58149 · journaled first
  send #1  theirs-snapshot HTTP 502 {"error":"Authorization parties or amount mismatch","state":"PENDING_R
  FAILED   theirs-snapshot HTTP 502 on the paid request
  send #2  theirs-snapshot HTTP 502 {"error":"Authorization parties or amount mismatch","state":"PENDING_R
  FAILED   theirs-snapshot HTTP 502 on the paid request
  send #3  theirs-snapshot HTTP 502 {"error":"Authorization parties or amount mismatch","state":"PENDING_R
  FAILED   theirs-snapshot HTTP 502 on the paid request
  check    theirs-snapshot authorization 0x2286f9f6… not used yet and still valid
  FAILED   theirs-snapshot no confirmed outcome after 3 sends; the signed payment stays in the journal and counts against the budget until it settles or lapses
  …(the same for theirs-activity, price 0.002 USDC)…
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
- "Lapsed" is judged by the local clock (validBefore plus 60 s), not the chain's block time: a clock more than a minute fast could re-sign too early. The journal (with the signed authorizations) is written with mode 0600.
- Authorizations that stay unsettled count against the budget. Before each decision the agent checks the older ones against the token: a payment that settled is logged, one that lapsed unused (its `validBefore` plus 60 s) stops counting. A refused or lost payment can therefore hold part of the budget for a few minutes.
- The `finish`, `budget` and `cap` tasks were recorded on a local `serve` (runs 1–3); only `finish` was also run against the deployed API (run 9).

## Tests

`npx vitest run test/x402-agent-buyer.test.ts` — 46 tests in [`test/x402-agent-buyer.test.ts`](../../test/x402-agent-buyer.test.ts), offline (a stand-in API that issues real 402 headers and settles each EIP-3009 nonce once, and a stand-in chain): the policy order (asset, cap, worth, cache, budget, the exact-budget boundary), when a cached answer covers a question, the finish / budget / cap tasks, retries before and after settlement, a 402 after settlement, exhausted retries, a settlement outside the lookback, a re-run of a finished task (no request, no payment), pending payments counting against the budget, a lapsed authorization re-signed once, a mismatched or reverted or unreadable receipt, an authorization that is too long-lived, the right offer picked from several, a key reused for another question, two purchases at once, a second run on the same ledger, a refused purchase not re-signed while the token is unreadable, a response body cut after settlement, a seller at another URL, `--compact` lines within 62 characters, and no key or signature in any log.
