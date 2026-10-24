# Architecture — Multi-Protocol Aggregator

One interface over several Pharos mainnet protocols. A request (a query or an action) goes in; the aggregator reads every protocol, picks the venue, explains the pick in numbers, and for an action hands back **unsigned** transactions. It holds no key.

```text
                         npm run multi-protocol-aggregator -- positions | rates | deposit | withdraw
                                              │
                                  tasks/multi-protocol-aggregator/index.ts   (flags, proof file)
                                              │
                                      src/aggregator/run.ts   aggregate()
          ┌───────────────────────────────────┼─────────────────────────────────────┐
          │ 1. one block, one set of windows  │ 2. per venue, GUARDED               │ 3. request
          │    get_block_number / get_block   │    holding()  read()                │    route.ts  (pure)
          │                                   │    error / hang → Down{reason}     │    adapters.prepare*()
          └───────────────────────────────────┴─────────────────────────────────────┘    verifyActionPlan()
                                              │
                          src/aggregator/adapters.ts   ── Adapter per protocol ──
                          ┌──────────────┬──────────────────┬───────────────────┐
                          │  rockawayx   │  morpho          │  centrifuge       │
                          │  ERC-4626    │  Blue, USDC      │  ERC-7540 (async) │
                          │  deposit /   │  supply /        │  read + compare   │
                          │  redeem      │  withdraw        │  only             │
                          └──────┬───────┴────────┬─────────┴─────────┬─────────┘
                                 └────────────────┴───────────────────┘
                                   src/yield/sources.ts (readers, shared with the Yield Optimizer)
                                              │
                                    Pharos Chain MCP (hosted, mainnet)
                          eth_call · get_block · get_block_number · get_gas_price · estimate_gas
```

## The interface

`Adapter` (src/aggregator/adapters.ts) is the whole contract a protocol must meet:

| Method | What it returns |
|---|---|
| `holding(call, venue, wallet, block, ts)` | the wallet's position (shares and USDC value) or `null` |
| `read(venue, ctx)` | the venue's rate per window, TVL, entry fee and limit, exit fee and depth, and the blockers for each |
| `prepareDeposit(input)` | the unsigned transactions for a deposit (`approve` + `deposit`/`supply`) |
| `prepareWithdraw(input)` | the unsigned transaction for a withdrawal (`redeem` / `withdraw`) |

The router sees only `Venue`s and their `Reading`s (plus an adapter's `actionBlocker`). A new protocol is one new adapter; `route.ts` does not change.

## Routing (route.ts, pure functions, no I/O)

- **Deposit:** `net = amount × conservative rate × dilution × horizon/365 − entry fee − gas`. The conservative rate is the median of the windows minus `haircut × spread`, so a jumpy rate is ranked down. Morpho's rate is diluted by our own deposit (`supply / (supply + deposit)`). A venue with a blocker (async deposit, `maxDeposit` 0, unreadable rate or fee) is not eligible and is listed with its reason. If the best venue's `maxDeposit` is below the amount, the rest goes to the next best.
- **Withdraw:** the venue where leaving costs least goes first: `exit fee + gas + yield given up (optimistic rate)`, so the best-paying positions are the last touched. A position is limited by what can leave in one transaction (a Morpho market's idle liquidity; a simulated `redeem` from the wallet for vaults).
- **Explanation:** the chosen venue with its numbers, the runner-up and the difference, every ineligible venue with its reason, every unavailable protocol.

## One protocol down (requirement 4)

Each venue is read inside its own `try` with a timeout. An error (RPC error, revert, bad data) or a hang makes **that venue** `down` with the reason; every other venue is still read, compared and routed. The report names the protocol as `DOWN` or `PARTLY UP`, lists what was left out, and for a withdrawal says the wallet's position there is **unknown** (it is never guessed as zero). `--down <protocol or venue id>` is a drill: it skips contacting that protocol or venue and labels every line that names it `SIMULATED` (the summary lines `PARTLY UP` and `positions … UNKNOWN` do not carry the word). If nothing answers at all the run fails and says so.

## Actions (requirement 2)

An action is a plan of unsigned transactions (`from` = the owner, `value` 0, chain id). Before a plan is shown, `verifyActionPlan` decodes the calldata itself, as a wallet would: each leg has exactly one approve and one deposit (or one withdrawal); an approval goes to the venue and equals the leg; a deposit is made for the owner for the leg's amount; a Morpho transaction names the market hash of its leg; a withdrawal pays the owner and redeems the leg's shares (or withdraws the leg's assets); every transaction belongs to a leg of the plan. A plan that fails its own check is not shown. `src/aggregator/` and the CLI import no signer, ask for no key, and have no way to send (a test greps for it).

## What it does not do

No execution (nothing is signed or sent); Centrifuge funds are read and compared but never routed to (the adapter carries an `actionBlocker`, so the router cannot allocate to them) (asynchronous requests settled in a later epoch for approved investors); RockawayX reports `maxDeposit` 0 for the wallets in the proofs, so no deposit was routed there and the output says why; no wallet we found holds positions in two protocols, so cross-protocol withdrawal splits are tested on a fake chain, not shown live.
