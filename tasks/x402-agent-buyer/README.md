# x402 Agent Buyer — Hard

**Task:** [x402 Agent Buyer](https://pharos-agent-arena.vercel.app/tasks/x402-agent-buyer) (Payments · Hard · 200 pts): an agent that pays x402-paywalled APIs on Pharos Atlantic for what it uses, inside a budget.
**Run** (Atlantic testnet only; keys in `~/.config/pharos/x402.env` and `testnet.env`, never printed):
`npm run x402-agent-buyer -- run finish|budget|cap|retry [--base URL] [--simulate-failure before|after] [--fresh] [--proof name]` · `npm run x402-agent-buyer -- log [--task finish]`.
It buys from the [x402 Paywalled API](../x402-paywalled-api/README.md) (default `https://pharos.edycu.dev`). Three of the four demo tasks use the quoted `whale-range` route, which is only on this branch, so start the same API locally first: `npm run x402-paywalled-api -- serve` and add `--base http://localhost:4021`.
**Uses:** x402 SDK 2.28 (`@x402/core` 402 header decoding, `@x402/evm` exact scheme, EIP-3009 signing), viem (the token's `authorizationState` and `AuthorizationUsed` log, the settle receipt).

## What the agent does

For each thing it wants (a *want*: a route, what the data is for, the most it is worth to the task) it:

1. **Asks** the route without paying. A 402 is free and states price, token and payee.
2. **Decides** ([`decide()`](agent.ts), pure, in this order): over the **per-call cap** → refuse · more than the answer is **worth** to the task → refuse · an answer it **already bought** still covers the question → refuse as redundant, counting the USDC saved · spend + unresolved payments + price over the **budget** → refuse. Also refuses a 402 for another token or network.
3. **Signs once.** The EIP-3009 authorization goes into the journal under the purchase's idempotency key (`<task>/<want>`) *before* it is sent.
4. **Sends**, retrying the *same* signature on a network failure; between tries it asks the token whether the authorization was already used.
5. **Checks the receipt** (status 1 and a USDC Transfer of exactly the price from the payer to the payee) before it accepts the data, then appends one row to the payment log: price, what it bought, tx hash, running total.

A required want refused for budget **stops** the task (the rest are not attempted); any other refusal moves on. The task is finished when every required want has data.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Calls at least 2 different x402 endpoints. They can be your own or another dev's." | `gas-snapshot` (0.001 USDC), `whale-brief` (0.01) and the quoted `whale-range` (0.005 per 1,000 blocks) of our own API, three routes at three prices. **No other developer's live x402 endpoint on Atlantic was found**: the Pharos docs give server code only (Docs MCP search), and our notes on other builders' sellers name no URL that answers (the one guessed project name returned `DEPLOYMENT_NOT_FOUND`); one of them is reported to settle in its own deployed token, which this agent refuses by design (`wrong-asset`). | [`proof/finish.json`](proof/finish.json) (two different routes paid) · [`proof/prod-gas.json`](proof/prod-gas.json) (the deployed API, pharos.edycu.dev) |
| 2 | "Enforces a spend budget and a per-call price cap, and refuses calls over either one." | `decide()` checks the cap first and the budget last; both refusals are printed and kept in the proofs. The budget counts signed-but-unsettled payments too. | cap: [`proof/cap.json`](proof/cap.json) (`over-cap: 0.015 USDC is over the per-call cap 0.012 USDC`) · budget: [`proof/budget.json`](proof/budget.json) (`over-budget: … 0.026 USDC, over the budget 0.02 USDC (0.009 USDC left)`) · tests under "decide" |
| 3 | "Logs every payment with the price, what it bought and the tx hash, plus a running total." | `PaymentRow` in a JSONL file, one row per purchase, never two for the same key; `npm run x402-agent-buyer -- log` prints it. | `proof/*.payments.jsonl` · tests "buys two answers … logs a running total" |
| 4 | "Handles payment failures with retries that are safe: the same payment never counts twice." | One idempotency key per purchase. The signed authorization is journaled before the send, and every retry re-sends it (never re-signs), so the token can settle it once (the EIP-3009 nonce). A failure *after* the API settled is reconciled from the chain (`authorizationState`, then the `AuthorizationUsed` log gives the tx): one log row, no second payment. An authorization that lapsed unsettled is replaced by a new one. | before the request leaves: [`proof/retry-before.json`](proof/retry-before.json) · after the API answered: [`proof/retry-after.json`](proof/retry-after.json) · 8 tests under "safe retries" |
| 5 | "Includes a demo task where the agent completes the job, and one where it stops because it hit the budget." | `finish` completes; `budget` stops with 0.009 USDC left because the next answer costs 0.015. | [`proof/finish.json`](proof/finish.json) · [`proof/budget.json`](proof/budget.json) |

## Proof

Seven runs against `serve` on this machine (`--base http://localhost:4021`) and one against the deployed API, each committed before the next so every file records `"dirty": false`. Each has its own payment log.

| Run | What it shows | Evidence |
|---|---|---|
| `run finish` | pays 2 answers (0.011 USDC of 0.05), refuses 2 as redundant (0.006 USDC saved) and 1 as not worth it, finishes | [`proof/finish.json`](proof/finish.json) · txs [0x6adce7aa…8a98](https://atlantic.pharosscan.xyz/tx/0x6adce7aa0e020ee2496605266621e942d1c12b66b5e8d10ff403a01672a18a98), [0x90d40f81…8971](https://atlantic.pharosscan.xyz/tx/0x90d40f81e0cbf1ee13510a7a4c58139243be914306248ba8beeeef4390418971) |
| `run budget` | pays 2 (0.011 of 0.02 USDC), refuses the 0.015 answer as over budget, stops, 1 want not attempted | [`proof/budget.json`](proof/budget.json) · txs [0xe16dce05…bb82](https://atlantic.pharosscan.xyz/tx/0xe16dce05a6eb67b810a3165bf0cbc629e3020d692258af1f5c5ef6029905bb82), [0x7f40e5f6…7b74](https://atlantic.pharosscan.xyz/tx/0x7f40e5f6dea65c42c937eb9681d5d0bd0aa9c6f1845ccf65e17b3788b5767b74) |
| `run cap` | cap 0.012 USDC: refuses the 0.015 answer, pays the other two, finishes | [`proof/cap.json`](proof/cap.json) · txs [0xfec26823…8d7e](https://atlantic.pharosscan.xyz/tx/0xfec26823203265b71785f3dff3c94f7f23d03d69efb5f0ea1b3a6a78c9ab8d7e), [0x6468969f…c256](https://atlantic.pharosscan.xyz/tx/0x6468969d0f7382d7e026309551db0ebc526679a347a1cd41a6e619b4060bc256) |
| `run retry --simulate-failure before` | the request never leaves; the retry re-sends the same signature; one payment | [`proof/retry-before.json`](proof/retry-before.json) · tx [0x7ea6d418…e5d3](https://atlantic.pharosscan.xyz/tx/0x7ea6d4188827d4ffc4565a2e090fccbe877765a7cdbb225edb8e666f4c9ae5d3) |
| `run retry --simulate-failure after` | the API settles, the response is lost; the agent finds the settlement on chain, logs it once, does not pay again, and says the answer was lost | [`proof/retry-after.json`](proof/retry-after.json) · tx [0x921217ec…faff](https://atlantic.pharosscan.xyz/tx/0x921217ec77107a89dd1bbf95591b16c34555f19d25977686ccf87588bea4faff) |
| `run retry --base https://pharos.edycu.dev` | one purchase from the deployed API | [`proof/prod-gas.json`](proof/prod-gas.json) · tx [0x13424cf3…893f](https://atlantic.pharosscan.xyz/tx/0x13424cf33126679acfa6b51d216d9526325a12ebcc68fc412b626967e7ed893f) |

Sample output of `run finish`, pasted from `proof/finish.json` (the explorer base URL is cut from the tx hashes):

```text
task finish: 5 wants · budget 0.05 USDC · per-call cap 0.02 USDC
  API http://localhost:4021 · payer 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  ask      gas          GET gas-snapshot → 402, price 0.001 USDC
  sign     gas          0.001 USDC · key finish/gas · nonce 0xa37ed29f…5a8692 (written to the journal before it is sent)
  send #1  gas          HTTP 200
  PAID     gas          0.001 USDC · tx 0x6adce7aa0e020ee2496605266621e942d1c12b66b5e8d10ff403a01672a18a98 · running total 0.001 USDC
  ask      whales       GET whale-brief → 402, price 0.01 USDC
  sign     whales       0.01 USDC · key finish/whales · nonce 0x73db837a…a21cac (written to the journal before it is sent)
  send #1  whales       HTTP 200
  PAID     whales       0.01 USDC · tx 0x90d40f81e0cbf1ee13510a7a4c58139243be914306248ba8beeeef4390418971 · running total 0.011 USDC
  ask      whales-1k    GET whale-range?blocks=1000 → 402, price 0.005 USDC
  REFUSED  whales-1k    redundant: already bought (finish/whales, whale-brief) and it still answers this: skipping saves 0.005 USDC
  ask      gas-again    GET gas-snapshot → 402, price 0.001 USDC
  REFUSED  gas-again    redundant: already bought (finish/gas, gas-snapshot) and it still answers this: skipping saves 0.001 USDC
  ask      deep-history GET whale-range?blocks=3000 → 402, price 0.015 USDC
  REFUSED  deep-history not-worth: 0.015 USDC is more than this answer is worth to the task (0.01 USDC)
FINISHED task finish: 2 payment(s), spent 0.011 USDC of 0.05 USDC (0.039 USDC left), refused 3, saved by not re-buying 0.006 USDC
payment log:
 1  0.001 USDC   total 0.001 USDC   Atlantic gas price now, to cost the transfer
    0x6adce7aa0e020ee2496605266621e942d1c12b66b5e8d10ff403a01672a18a98
 2  0.01 USDC    total 0.011 USDC   largest USDC transfers on Pharos mainnet, last ~1,000 blocks
    0x90d40f81e0cbf1ee13510a7a4c58139243be914306248ba8beeeef4390418971
```

`run retry --simulate-failure after`:

```text
task retry: 1 wants · budget 0.01 USDC · per-call cap 0.01 USDC
  API http://localhost:4021 · payer 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  ask      gas          GET gas-snapshot → 402, price 0.001 USDC
  sign     gas          0.001 USDC · key retry/gas · nonce 0x7b4b742f…67a2f2 (written to the journal before it is sent)
  send #1  gas          FAILED: simulated network failure: the API answered, the response was lost
  check    gas          authorization 0x7b4b742f… was used in 0x921217ec77…: it settled once
UNFINISHED task retry: 1 payment(s), spent 0.001 USDC of 0.01 USDC (0.009 USDC left), refused 0, saved by not re-buying 0 USDC
payment log:
 1  0.001 USDC   total 0.001 USDC   Atlantic gas price now
    0x921217ec77107a89dd1bbf95591b16c34555f19d25977686ccf87588bea4faff
    note: the response was lost after the API settled; counted once, not bought again
```

## Beyond the requirements

- **Value check before paying.** An answer already bought is reused when it still covers the question, and the buy is refused as redundant with the USDC it saved. It works across routes: `whale-brief` returned the largest USDC transfers of the latest 1,000 mainnet blocks, so asking `whale-range?blocks=1000` (0.005 USDC) is refused. In general a whale answer covers a window of N blocks when its range holds the last N blocks of its own head and at least `top` of its listed transfers lie inside that window (a transfer that is in the top list and in the window is also in the window's own top list, so nothing is guessed). `gas-snapshot` is reused for 60 s. A first-time question is never refused as redundant, and the check happens after the free 402, so the price saved is the real one.
- **Reconciliation from the chain.** After a lost response the agent does not guess: `authorizationState(payer, nonce)` on the token says whether the payment settled, and the token's `AuthorizationUsed` event gives the transaction.
- **Receipt before data.** A 200 with a `PAYMENT-RESPONSE` is not enough; no status-1 receipt with the matching USDC Transfer, no data accepted (the check from the paywalled API's buyer).
- **Keys.** The private key is read once from the environment or `~/.config/pharos/`, never printed or logged. The signed authorization (a bearer instrument for two minutes) lives only in the gitignored `state/` journal; logs and proofs carry the nonce, not the signature.

## Limits

- Our own API only: no other developer's live x402 endpoint was found (see requirement 1). The agent works with any x402 `exact` endpoint that asks for the registry test USDC on `eip155:688689`; it refuses anything else.
- After a failure *after* settlement the data is lost: the agent counts the payment once and reports "paid, answer lost" instead of buying again under the same key. A new purchase needs a new want.
- The retry-after run drops the response in the buyer's `fetch`; it simulates the network failure, it does not create a real one. The re-send of a settled signature being refused is the paywalled API's own proof (`x402-paywalled-api/proof/replay.json`); here the agent asks the token first, so it does not re-send.
- Whether an answer is "worth" its price is a number the task sets per want, not a model's judgment. The value check covers gas and whale questions only.
- The journal and the payment log are local files with no lock across two simultaneous agents on the same task.
- `whale-range` is on branch `task/x402-paywalled-api`, so three demo tasks need the local `serve` until that branch is deployed.

## Tests

`npm test` — 25 tests in [`test/x402-agent-buyer.test.ts`](../../test/x402-agent-buyer.test.ts), offline (a stand-in API that issues real 402 headers and settles each EIP-3009 nonce once, and a stand-in chain): the policy order (cap, worth, cache, budget, exact-budget boundary, wrong token), when a cached answer covers a question, the finish / budget / cap tasks, retries before and after settlement, a re-run of a finished task (no request, no payment), pending payments counting against the budget, a lapsed authorization re-signed once, a mismatched receipt rejected, and no key or signature in any log.
