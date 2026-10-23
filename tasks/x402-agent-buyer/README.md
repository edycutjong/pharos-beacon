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
| 2 | "Enforces a spend budget and a per-call price cap, and refuses calls over either one." | `decide()` checks the cap first and the budget last; both refusals are printed and kept in the proofs. The budget counts signed-but-unsettled payments too. | cap: [`proof/cap.json`](proof/cap.json) (`over-cap: 0.015 USDC is over the per-call cap 0.012 USDC`) · budget: [`proof/budget.json`](proof/budget.json) (`over-budget: 0.015 USDC would make the spend 0.026 USDC, over the 0.02 USDC budget (0.009 USDC left)`) · tests under "decide" |
| 3 | "Logs every payment with the price, what it bought and the tx hash, plus a running total." | `PaymentRow` in a JSONL file, one row per purchase, never two for the same key; `npm run x402-agent-buyer -- log` prints it. A payment whose settling tx is outside the 8,000-block lookback is still logged (without a tx, and the log says so). | `proof/*.payments.jsonl` · tests "buys three answers … logs a running total", "a settlement outside the lookback is still logged once" |
| 4 | "Handles payment failures with retries that are safe: the same payment never counts twice." | One idempotency key per purchase. The signed authorization is journaled before the send, and every retry re-sends it (never re-signs), so the token can settle it once (the EIP-3009 nonce). Before any new signature the token is asked whether the old one was used; one that was is logged once with the tx found from `AuthorizationUsed`; one that is unused and lapsed (plus 60 s) is replaced; one that is unused and still valid blocks a second payment. | before the request leaves: [`proof/retry-before.json`](proof/retry-before.json) · after the API answered: [`proof/retry-after.json`](proof/retry-after.json) · **a real 402 after settlement on the deployed API**: [`proof/prod-gas.json`](proof/prod-gas.json) · the tests under "safe retries" |
| 5 | "Includes a demo task where the agent completes the job, and one where it stops because it hit the budget." | `finish` completes; `budget` stops with 0.009 USDC left because the next answer costs 0.015 (it stops at the first required answer that does not fit, by design, so the cheaper last want is not attempted). | [`proof/finish.json`](proof/finish.json) · [`proof/budget.json`](proof/budget.json) |

## Proof

Each run was committed before the next, so every file records `"dirty": false`, and each has its own payment log and ledger (a ledger is one budget scope; `--proof` gives a run its own, `--ledger` names one). Runs 1–5 use `serve` on this machine, 6–8 the deployed API. All settle transactions have receipt status 1.

| # | Run | What it shows | Evidence |
|---|---|---|---|
| 1 | `run finish` | pays 3 answers from 3 routes (0.021 of 0.05 USDC), refuses 2 as redundant (0.006 USDC saved) and 1 as not worth it, finishes | [`proof/finish.json`](proof/finish.json) · txs [0xb2926a23…8e92](https://atlantic.pharosscan.xyz/tx/0xb2926a23794ac0d728b7dc63a0e85c90a7328a0dda9550031fc9bea5d6e08e92), [0x6ba0f455…3f65](https://atlantic.pharosscan.xyz/tx/0x6ba0f455cb3468538dfac178bfef78e97372e9e9469439e72fefbe269c7f3f65), [0x3f4b00b0…9d5e](https://atlantic.pharosscan.xyz/tx/0x3f4b00b0920e43b75570efed5942f9994d8bf35b40bcb572b559810a9ed19d5e) |
| 2 | `run budget` | pays 2 (0.011 of 0.02 USDC), refuses the 0.015 answer as over budget, stops, 1 want not attempted | [`proof/budget.json`](proof/budget.json) · txs [0x9dc67764…5b7a](https://atlantic.pharosscan.xyz/tx/0x9dc677649acbf456c7e8490204c952dbcfea2d169433a2442ee9882d36fc5b7a), [0x765a2649…ef59](https://atlantic.pharosscan.xyz/tx/0x765a2649fa389df90b3b9551bb7a1b79ede4f220076e80b860a87e99a4baef59) |
| 3 | `run cap` | cap 0.012 USDC: refuses the 0.015 answer, pays the other two, finishes | [`proof/cap.json`](proof/cap.json) · txs [0x71200844…3621](https://atlantic.pharosscan.xyz/tx/0x712008445ab670610571e5e6333c7a7b6ce8dfc4349ba575fe226bd44bca3621), [0xddec1af1…c38f](https://atlantic.pharosscan.xyz/tx/0xddec1af1dd2375f8e130dc91ad77fc054c615222bf7d48fc0d142c443c1cc38f) |
| 4 | `run retry --simulate-failure before` | the request never leaves; the retry re-sends the same signature; one payment | [`proof/retry-before.json`](proof/retry-before.json) · tx [0xaece1c36…7e6c](https://atlantic.pharosscan.xyz/tx/0xaece1c36efdf40bba747656968ddf75757a91404a50764faa741aff580da7e6c) |
| 5 | `run retry --simulate-failure after` | the API settles, the response is lost; the agent finds the settlement on chain, logs it once, does not pay again, and reports the answer as lost | [`proof/retry-after.json`](proof/retry-after.json) · tx [0xad7a55fa…2044](https://atlantic.pharosscan.xyz/tx/0xad7a55fa73a5e0bfae0acad6a939e3bfe421929beb307bb92f02d6d158d02044) |
| 6 | `run retry --base https://pharos.edycu.dev` (**uncontrolled**) | the deployed API answered the paid request with **402** although the payment had settled; the agent asked the token, found the authorization used, logged it once and did not sign again | [`proof/prod-gas.json`](proof/prod-gas.json) · tx [0x5ec452d5…c6d2](https://atlantic.pharosscan.xyz/tx/0x5ec452d5b760ab89c05eaba81c9a9e873542efe2827409bca133de5db5eec6d2) |
| 7 | the same command, the next attempt | a plain paid purchase from the deployed API | [`proof/prod-gas-ok.json`](proof/prod-gas-ok.json) · tx [0x5b099267…20f7](https://atlantic.pharosscan.xyz/tx/0x5b099267cd65645c01092c1032d84cdf446674709f96f6e95a1d299d871e20f7) |
| 8 | `run partner` | our gas route paid; another developer's two routes: 402 read, authorization signed, 502 ×3, authorization unused on chain, nothing charged, task ends unfinished | [`proof/partner-seller.json`](proof/partner-seller.json) · tx [0xcca04f65…e9b7](https://atlantic.pharosscan.xyz/tx/0xcca04f6581b341291d4593946a2577dd66f3cbbf78c23b7220aefa298617e9b7) (ours) |

Run 6 is not staged: the paywalled API's settle step can fail to read its receipt and return 402 after the transfer went through (the Atlantic RPC rate-limits bursts). It is the failure the reconcile step exists for. An agent that treated that 402 as "refused, nothing charged" would have signed a second payment.

Sample output of `run finish`, rendered from `proof/finish.json` (the explorer base URL is cut from the tx hashes):

```text
task finish: 6 wants · budget 0.05 USDC · per-call cap 0.02 USDC
  API http://localhost:4021 · payer 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  ask      gas          GET gas-snapshot → 402, price 0.001 USDC
  sign     gas          0.001 USDC · key finish/gas · nonce 0x034e4288…1bb184 · journaled first
  send #1  gas          HTTP 200
  PAID     gas          0.001 USDC · tx 0xb2926a23…e08e92 · running total 0.001 USDC
  ask      whales       GET whale-brief → 402, price 0.01 USDC
  sign     whales       0.01 USDC · key finish/whales · nonce 0x3650627c…04815a · journaled first
  send #1  whales       HTTP 200
  PAID     whales       0.01 USDC · tx 0x6ba0f455…7f3f65 · running total 0.011 USDC
  ask      whales-1k    GET whale-range?blocks=1000 → 402, price 0.005 USDC
  REFUSED  whales-1k    redundant: already bought (finish/whales) and it still answers this: skipping saves 0.005 USDC
  ask      gas-again    GET gas-snapshot → 402, price 0.001 USDC
  REFUSED  gas-again    redundant: already bought (finish/gas) and it still answers this: skipping saves 0.001 USDC
  ask      range        GET whale-range?blocks=2000 → 402, price 0.01 USDC
  sign     range        0.01 USDC · key finish/range · nonce 0x5e265fcf…9f3273 · journaled first
  send #1  range        HTTP 200
  PAID     range        0.01 USDC · tx 0x3f4b00b0…d19d5e · running total 0.021 USDC
  ask      deep-history GET whale-range?blocks=3000 → 402, price 0.015 USDC
  REFUSED  deep-history not-worth: 0.015 USDC is more than this is worth to the task (0.01 USDC)
FINISHED finish: 3 paid · spent 0.021 USDC of 0.05 USDC (0.029 USDC left) · 3 refused · saved 0.006 USDC
payment log:
 1  0.001 USDC   total 0.001 USDC   Atlantic gas price now, to cost the transfer
    0xb2926a23794ac0d728b7dc63a0e85c90a7328a0dda9550031fc9bea5d6e08e92
 2  0.01 USDC    total 0.011 USDC   largest USDC transfers on Pharos mainnet, last ~1,000 blocks
    0x6ba0f455cb3468538dfac178bfef78e97372e9e9469439e72fefbe269c7f3f65
 3  0.01 USDC    total 0.021 USDC   twice the history: the largest USDC transfers over 2,000 blocks
    0x3f4b00b0920e43b75570efed5942f9994d8bf35b40bcb572b559810a9ed19d5e
```

`run retry --simulate-failure after`:

```text
task retry: 1 wants · budget 0.01 USDC · per-call cap 0.01 USDC
  API http://localhost:4021 · payer 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  ask      gas          GET gas-snapshot → 402, price 0.001 USDC
  sign     gas          0.001 USDC · key retry/gas · nonce 0x32cf7513…3617b4 · journaled first
  send #1  gas          FAILED: simulated network failure: the API answered, the response was lost
  check    gas          authorization 0x32cf7513… was used in 0xad7a55fa73…: it settled once
UNFINISHED retry: 1 paid · spent 0.001 USDC of 0.01 USDC (0.009 USDC left) · 0 refused · saved 0 USDC
payment log:
 1  0.001 USDC   total 0.001 USDC   Atlantic gas price now
    0xad7a55fa73a5e0bfae0acad6a939e3bfe421929beb307bb92f02d6d158d02044
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
  sign     ours         0.001 USDC · key partner/ours · nonce 0x71dd6d1d…b801bd · journaled first
  send #1  ours         HTTP 200
  PAID     ours         0.001 USDC · tx 0xcca04f65…17e9b7 · running total 0.001 USDC
  ask      theirs-snapshot GET https://pharos-x402-paywalled-api.shoupeorg.workers.dev/paid/network-snapshot?block=31801770 → 402, price 0.001 USDC
  sign     theirs-snapshot 0.001 USDC · key partner/theirs-snapshot · nonce 0x52c828ce…b80d15 · journaled first
  send #1  theirs-snapshot HTTP 502
  FAILED   theirs-snapshot HTTP 502 on the paid request
  send #2  theirs-snapshot HTTP 502
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

- Paid endpoints: only our own API settled a payment. The other developer's seller (`pharos-x402-paywalled-api.shoupeorg.workers.dev`, found from their public README) only accepts payments from its own buyer wallet; the agent's authorization from our wallet is refused with 502 `Authorization parties or amount mismatch`. The agent works with any x402 `exact` endpoint that asks for the registry test USDC on `eip155:688689` and settles for a third party; it refuses any other token or network (`wrong-asset`).
- After a failure *after* settlement the data is lost: the agent counts the payment once and reports "paid, answer lost" instead of buying again under the same key. A new purchase needs a new want. Run 6 shows the real case, and run 7 the next attempt.
- The retry-after run drops the response in the buyer's `fetch`; it simulates the network failure, it does not create a real one. The re-send of a settled signature being refused is the paywalled API's own proof (`x402-paywalled-api/proof/replay.json`); here the agent asks the token first, so it does not re-send.
- Whether an answer is "worth" its price is a number the task sets per want, not a model's judgment. The value check covers gas and whale questions only. A cached whale answer measures "the last N blocks" from its own head, so after minutes it answers the question about a slightly older window; the 10-minute limit bounds that. Ties at the same amount can list a different transfer.
- The ledger (journal and payment log) is local files. One run per ledger at a time (lock file); purchases inside a process are serialized. Two processes calling `buy` directly instead of `run` are not coordinated.
- Authorizations that stay unsettled count against the budget until they lapse (the signed lifetime plus 60 s). A refused or lost payment can therefore block the budget for a few minutes.
- `whale-range` is on branch `task/x402-paywalled-api`, so three demo tasks need the local `serve` until that branch is deployed.

## Tests

`npm test` — 37 tests in [`test/x402-agent-buyer.test.ts`](../../test/x402-agent-buyer.test.ts), offline (a stand-in API that issues real 402 headers and settles each EIP-3009 nonce once, and a stand-in chain): the policy order (asset, cap, worth, cache, budget, the exact-budget boundary), when a cached answer covers a question, the finish / budget / cap tasks, retries before and after settlement, a 402 after settlement, exhausted retries, a settlement outside the lookback, a re-run of a finished task (no request, no payment), pending payments counting against the budget, a lapsed authorization re-signed once, a mismatched or reverted or unreadable receipt, an authorization that is too long-lived, the right offer picked from several, a key reused for another question, two purchases at once, a second run on the same ledger, a seller at another URL, and no key or signature in any log.
