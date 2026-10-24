# Multi-Protocol Aggregator — Hard

**Task:** [Multi-Protocol Aggregator](https://pharos-agent-arena.vercel.app/tasks/multi-protocol-aggregator) (Hard · 200 pts): a Harbor-style agent extended across more than one protocol or vault: one interface to query and act across several protocols, picking the best venue for each request.

**What is real.** Everything runs on **Pharos mainnet (chain 1672)** through the Pharos Chain MCP, on three protocols behind one interface: the [RockawayX USDC vault](https://www.pharosscan.xyz/address/0x047cd0a91e9b92ed979189a6c8a120bf280f02e5) (ERC-4626), three [Morpho Blue](https://www.pharosscan.xyz/address/0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb) USDC markets, and the JTRSY and HYB fund vaults (Centrifuge, ERC-7540). The wallets in the proofs are real third-party holders found on chain (none is ours). Nothing is mocked and nothing is signed or sent: an action comes out as **unsigned transactions** for the owner's wallet. We did not use Harbor/PharosPort (it is browser-only); the "Harbor-style" part is the interface: one request, many protocols, a chosen venue and a stated reason.

**Keys:** none. `src/aggregator/` and `index.ts` import no signer, read no secret and cannot send (a test greps for it). Before a plan is shown, the aggregator decodes its own calldata the way a wallet would and refuses a plan that pays anyone but the owner.

**Try it** (keyless, read-only, mainnet; `--block` pins the reads so the rates, fees and balances reproduce the proofs; the gas lines follow the head; a run takes a few minutes at the hosted server's rate limit):

```text
npm ci
npm run multi-protocol-aggregator -- deposit  --wallet 0x0665FDe254598e307b63f3aAe3cCd881a62d4bE3 --amount 250 --block 21146194
npm run multi-protocol-aggregator -- withdraw --wallet 0x62A0e4b7fD967fab5be1a733c09b22eBC4510673 --amount all --down morpho --block 21146194
```

**Run:** `npm run multi-protocol-aggregator -- positions|rates|deposit|withdraw --wallet 0x… [--amount 250|all] [--hold-days 30] [--windows 1d,7d,30d] [--haircut 0.5] [--down morpho|rockawayx|centrifuge|<venue id>,…] [--timeout-ms 120000] [--assume-funded] [--block N] [--native-usd N] [--plan file.json] [--proof name]`
- `positions`: what the wallet holds in each venue. `rates`: every venue's rate, fees and limits. `deposit` / `withdraw`: route the request, explain the choice, prepare the unsigned transactions (`--plan file.json` writes them).
- `--down`: an **outage drill** (protocol or one venue id such as `morpho-c79579`): that part is not contacted and every line about it says SIMULATED. A real failure (RPC error, revert, no answer within `--timeout-ms`) is handled the same way without the flag.
- A deposit is refused if the wallet does not hold the USDC (`--assume-funded` prepares the plan anyway and says so).

**Uses:** Pharos Chain MCP `eth_call`, `get_block`, `get_block_number`, `get_gas_price`, `estimate_gas` (hosted `https://mcp.pharos.xyz/mcp`). Architecture write-up: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## How a request is routed

Each protocol is an `Adapter` (read a position, read the market, prepare a deposit, prepare a withdrawal); the router sees only venues and their readings. Full picture in [`ARCHITECTURE.md`](ARCHITECTURE.md).

- **Rates** are share-price growth over 1d/7d/30d, annualised (simple); a venue's *conservative* rate is the median minus `haircut × spread`, so a jumpy rate is ranked down (the same readers as the [Yield Optimizer](../yield-optimizer/), including its previous-block confirmation of every share price).
- **Deposit:** the venue with the best `yield − entry fee − gas` over `--hold-days`, with Morpho's rate diluted by our own deposit. A venue that cannot take it (asynchronous deposit, `maxDeposit` 0, unreadable rate or fee) is listed with the reason, never silently dropped. If the best venue's limit is below the amount, the rest goes to the next best.
- **Withdraw:** the venue where leaving costs least goes first: `exit fee + gas + the yield given up`, so the best-paying positions are touched last. What can leave is limited by the position and, on Morpho, by the market's idle liquidity; vault exits are simulated with `eth_call` from the wallet.
- **Explanation:** the chosen venue with its numbers, the runner-up and the gap, every ineligible venue with its reason, every unavailable venue.

## Sample output

A deposit of 250 USDC by a wallet that holds 305.7 USDC ([`mainnet-deposit-250.txt`](proof/mainnet-deposit-250.txt), block 21146194):

```text
Protocols behind the one interface:
  RockawayX      UP · 1 of 1 venue answered
  Centrifuge     UP · 2 of 2 venues answered
  Morpho Blue    UP · 3 of 3 venues answered

ROUTE (deposit):
  Chose Morpho Blue syzUSD/USDC supply (Morpho Blue): over 30 d it nets $0.9341 = yield $0.9364 at its conservative 4.56% − entry fee $0.000000 − gas $0.002306.
  Next best: Morpho Blue APC3M/USDC supply nets $0.9058 (conservative 4.42%); Morpho Blue syzUSD/USDC supply is $0.0283 ahead.
  Not eligible: RockawayX USDC vault (RockawayX): maxDeposit(wallet) = 0 USDC raw, below the 1000000 probe deposit (the vault is full, paused or restricted).
  Not eligible: Janus Henderson Treasury Fund (Centrifuge): maxDeposit(wallet) = 0 USDC raw, below the 1000000 probe deposit (the vault takes deposits only as asynchronous requests from approved investors); deposit is an asynchronous request (previewDeposit reverts), so it cannot be one transaction in a one-shot move.
  Not eligible: NYLIM US High Yield Bond Fund (Centrifuge): maxDeposit(wallet) = 0 USDC raw, below the 1000000 probe deposit (the vault takes deposits only as asynchronous requests from approved investors); deposit is an asynchronous request (previewDeposit reverts), so it cannot be one transaction in a one-shot move.
  → $250.00 to Morpho Blue syzUSD/USDC supply
Funding: the wallet holds 305.708431 USDC, enough for the deposit.

Prepared for the wallet owner's signature (nothing signed, no key read), plan 0x1665…5868, wallet-side calldata check passed:
  1. Approve Morpho Blue to pull 250000000 USDC raw · to 0xC879…1815 · gas 71481 (estimated)
  2. Supply 250000000 USDC raw to Morpho Blue syzUSD/USDC supply · to 0x1857…4Efb · gas 300000 (configured)
```

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Integrates at least 2 protocols or vaults behind one interface." | Three protocols, six venues, one `Adapter` interface (`src/aggregator/adapters.ts`) and one report: RockawayX (1 venue), Morpho Blue (3 USDC markets), Centrifuge (2 funds). Every venue is read at the same block by the same code path. | [`mainnet-rates.txt`](proof/mainnet-rates.txt) ("Protocols behind the one interface": 3 lines UP), [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| 2 | "Supports both queries (positions, rates) and actions (deposit or withdraw prepared for signature)." | Queries: `positions`, `rates`. Actions: `deposit` (approve + deposit/supply) and `withdraw` (redeem/withdraw), as unsigned transactions that pass the wallet-side calldata check. | Queries: [`mainnet-rates.txt`](proof/mainnet-rates.txt), the "Positions of the wallet" block of every proof. Deposit: [`mainnet-deposit-250.json`](proof/mainnet-deposit-250.json) (`plan`, `signed: false`). Withdraw: [`mainnet-withdraw-5000.json`](proof/mainnet-withdraw-5000.json) (RockawayX redeem), [`mainnet-withdraw-morpho-supplier.json`](proof/mainnet-withdraw-morpho-supplier.json) (Morpho withdraw) |
| 3 | "Routes each request to the best venue and explains why it chose it." | The `ROUTE` block: chosen venue with yield/fee/gas or exit-cost numbers, the runner-up and the gap, each ineligible venue with its reason. The 250 USDC deposit goes to Morpho syzUSD/USDC (nets $0.9341 against $0.9058 for APC3M/USDC); RockawayX and both Centrifuge funds are listed as not eligible (`maxDeposit(wallet) = 0`, asynchronous deposit). The 5,000 USDC withdrawal comes from RockawayX and the 1,000 USDC one from Morpho, each with the cost breakdown. | [`mainnet-deposit-250.txt`](proof/mainnet-deposit-250.txt), [`mainnet-withdraw-5000.txt`](proof/mainnet-withdraw-5000.txt), [`mainnet-withdraw-morpho-supplier.txt`](proof/mainnet-withdraw-morpho-supplier.txt) |
| 4 | "Handles one protocol being unavailable without breaking the others." | Each venue is read inside its own guard (error, revert or no answer within the timeout makes only that venue `down`, with the reason). The others are read, compared and routed; the output shows `DOWN` / `PARTLY UP`, and for a withdrawal says the wallet's position in the unavailable protocol is UNKNOWN rather than zero. Live drills: with all of Morpho Blue down, the RockawayX withdrawal is still prepared; with the best Morpho market down, the deposit goes to the next best market. Real failures (RPC error, a hang past the timeout) are covered by tests; nothing answering at all fails loudly. | [`mainnet-withdraw-all-morpho-down.txt`](proof/mainnet-withdraw-all-morpho-down.txt), [`mainnet-deposit-250-best-market-down.txt`](proof/mainnet-deposit-250-best-market-down.txt), [`mainnet-deposit-250-morpho-down.txt`](proof/mainnet-deposit-250-morpho-down.txt) (no other venue can take a deposit: said so, no plan), `test/multi-protocol-aggregator.test.ts` ("RPC error", "hangs", "nothing answers") |
| 5 | "Includes an architecture write-up and a demo video." | [`ARCHITECTURE.md`](ARCHITECTURE.md): the layers, the interface, the routing rules, the outage handling, the plan check, what it does not do. Demo video: posted on X and linked in the submission (see the form). | [`ARCHITECTURE.md`](ARCHITECTURE.md) |

## Proof

All mainnet, all read-only, all pinned at block 21146194, each proof file records the commit that produced it with `dirty: false`.

| Run | What it shows | File |
|---|---|---|
| `rates` | six venues of three protocols in one table | [`mainnet-rates.txt`](proof/mainnet-rates.txt) / [`.json`](proof/mainnet-rates.json) |
| `deposit --amount 250` | routed to Morpho syzUSD/USDC, runner-up and three ineligible venues explained, approve + supply prepared | [`mainnet-deposit-250.txt`](proof/mainnet-deposit-250.txt) / [`.json`](proof/mainnet-deposit-250.json) |
| `deposit --amount 250 --down morpho-c79579` | the best market down: the deposit moves to the next best market | [`mainnet-deposit-250-best-market-down.txt`](proof/mainnet-deposit-250-best-market-down.txt) / [`.json`](proof/mainnet-deposit-250-best-market-down.json) |
| `deposit --amount 250 --down morpho` | all of Morpho down: no other protocol can take a deposit today, and it says so | [`mainnet-deposit-250-morpho-down.txt`](proof/mainnet-deposit-250-morpho-down.txt) / [`.json`](proof/mainnet-deposit-250-morpho-down.json) |
| `withdraw --amount 5000` | a RockawayX redeem of the shares worth 5,000 USDC | [`mainnet-withdraw-5000.txt`](proof/mainnet-withdraw-5000.txt) / [`.json`](proof/mainnet-withdraw-5000.json) |
| `withdraw --amount all --down morpho` | Morpho down: the RockawayX position is still withdrawn | [`mainnet-withdraw-all-morpho-down.txt`](proof/mainnet-withdraw-all-morpho-down.txt) / [`.json`](proof/mainnet-withdraw-all-morpho-down.json) |
| `withdraw --amount 1000` (a Morpho supplier) | a Morpho Blue withdraw of 1,000 USDC | [`mainnet-withdraw-morpho-supplier.txt`](proof/mainnet-withdraw-morpho-supplier.txt) / [`.json`](proof/mainnet-withdraw-morpho-supplier.json) |

**Tests:** 37 in [`test/multi-protocol-aggregator.test.ts`](../../test/multi-protocol-aggregator.test.ts): the router (net yield, fees, dilution, limits and splits, ineligible venues, empty wallet), a fake chain with an ERC-4626 vault, an asynchronous fund vault and a Morpho market (positions, rates, deposit/withdraw plans, drills, an RPC error, a hang, nothing answering, an unfunded wallet), the wallet-side check against edited plans (sender, value, chain id, target, amount, a deposit or approval for someone else, a withdrawal paying someone else), the CLI's input errors, and the no-signer grep.

## Limits, stated plainly

- **Nothing is executed.** Every action is a prepared plan; no transaction was sent for this task, and we did not look for a wallet to sign with. The wallet-side check is our own decoder, not a hardware wallet's.
- **Routing is yield and cost, not risk.** A Morpho market's collateral risk, a fund's NAV risk or a vault's strategy risk is not scored. Rates are backward-looking share-price growth, not forecasts.
- **RockawayX is not chosen for a deposit today:** its `maxDeposit(wallet)` is 0 for both wallets in the deposit and rates proofs (the entry lines of [`mainnet-rates.txt`](proof/mainnet-rates.txt) and [`mainnet-deposit-250.txt`](proof/mainnet-deposit-250.txt)), so the output lists it as not eligible with that reason. We cannot simulate a deposit before an approve, so the vault may accept deposits its `maxDeposit` does not report: its `maxRedeem` is 0 too, yet a simulated redeem of all shares succeeds ([`mainnet-withdraw-5000.json`](proof/mainnet-withdraw-5000.json), the `simulated redeem` evidence). We report the reason instead of calling the vault closed.
- **Centrifuge funds are read, compared and shown among the positions, but never routed to:** deposits and redeems are asynchronous requests (ERC-7540) settled in a later epoch for approved investors, so no one-transaction plan exists. A withdrawal request for a wallet that holds only those says so.
- **No wallet we found holds two protocols**, so a cross-protocol *split* is covered by tests on a fake chain, and shown live only as a choice between venues of one protocol (deposit) and as single-protocol withdrawals. The live outage drills are drills (`--down`); the failure paths of a real outage are tested.
- **Gas for a deposit is a configured 300,000 units** (it cannot be estimated before the approve is mined; the plan labels it "configured"); the rest is `estimate_gas` from the owner's address. The node's gas price follows the head even with `--block`.
- **Sources are a fixed list:** RockawayX, the JTRSY and HYB funds, and the Morpho USDC markets found by the Liquidation Watchdog's scan (three that lend USDC and hold at least 1,000 USDC; the report lists the others as left out).
- **Harbor / PharosPort** is not integrated (browser-only).
