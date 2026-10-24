# Yield Optimizer — Hard

**Task:** [Yield Optimizer](https://pharos-agent-arena.vercel.app/tasks/yield-optimizer) (Hard · 200 pts): compare the yield of several vaults or pools, factor in the costs, and recommend (or prepare) a rebalance only when moving is actually worth it.

**What is real, and what is ours.** The comparison runs on **Pharos mainnet (chain 1672)** through the Pharos Chain MCP, on six live yield sources: the [RockawayX USDC vault](https://www.pharosscan.xyz/address/0x047cd0a91e9b92ed979189a6c8a120bf280f02e5), the JTRSY and HYB fund vaults (Centrifuge), and the supply side of three [Morpho Blue](https://www.pharosscan.xyz/address/0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb) USDC markets. The wallets are real third-party holders (we have no relation to them), so the answers are not staged: on mainnet the optimizer **stays put** for both of them, and says why from what the contracts report. **Pharos Atlantic has no yield vault, so the executed move runs between four small vaults we deployed ourselves** ([`contracts/src/YieldVault.sol`](contracts/src/YieldVault.sol), addresses and deploy transactions in [`deployments.json`](deployments.json)): their share price grows at a rate the owner sets, on a funded reserve. They are test contracts, not a protocol, and are named "Atlantic …" everywhere. The optimizer itself is the same code on both networks.

**Keys:** the optimizer holds none and cannot send anything (`src/yield/` and `index.ts` import no signer, read no secret; a test greps for it). A move comes out as **unsigned transactions** for the owner's wallet. [`wallet.ts`](wallet.ts) is the separate stand-in for that wallet on testnet, the only file here that reads a key, and it signs only after `--execute` and after decoding the calldata itself.

**Try it** (keyless, read-only, mainnet; `--block` pins every read so it reproduces the proof text; a full run makes a few hundred read calls and takes 3 to 5 minutes at the hosted server's rate limit):

```text
npm ci
npm run yield-optimizer -- recommend --wallet 0x62A0e4b7fD967fab5be1a733c09b22eBC4510673 --block 21146194
```

**Run:** `npm run yield-optimizer -- recommend --wallet 0x… [--network pharos|atlantic] [--windows 1d,7d,30d] [--hold-days 30] [--min-net-usd 1] [--slippage-bps 10] [--haircut 0.5] [--block N] [--native-usd N] [--plan file.json] [--proof name]`
- `--wallet`: the owner; the largest position it holds in the sources is what gets optimised. `--windows`: the look-back windows (mainnet default `1d,7d,30d`; Atlantic `10m,30m,1h`, because the test vaults are hours old).
- `--hold-days`: how long the money must stay after a move (the minimum holding period). `--min-net-usd`: the smallest net gain worth the trouble.
- `--haircut` (0 to 1, default 0.5): how much of a source's window-to-window spread is taken off a destination's rate and added to the held position's. `0` judges everything by its median rate.
- `--plan file.json` writes the unsigned transactions when the answer is MOVE. `--proof name` writes `proof/name.json` and the same run as readable text.
- Signing, testnet only: `npm run yield-wallet -- sign plan.json` (dry run), `… --execute` to sign and send.

**Uses:** Pharos Chain MCP `eth_call`, `get_block`, `get_block_number`, `get_gas_price`, `estimate_gas`, `get_code` (hosted `https://mcp.pharos.xyz/mcp` for mainnet, the local pharos-mcp for Atlantic), plus `send_raw_transaction` in `wallet.ts` only; viem for ABI encoding and, in `wallet.ts` only, signing.

## How a recommendation is built

1. **Rates are measured, not quoted.** For every source the share price is read at the head and at 1 day, 7 days and 30 days ago, and the growth is annualised by simple extrapolation (APR, no compounding). The vaults are asked for the value of 10^(share decimals + 6) shares, so the price keeps 12 digits and a 0.05 % move over a week is not lost to USDC's 6. A Morpho market's price is `(supply + 1) / (supply shares + 1e6)` after accruing the interest the IRM's `borrowRateView` says is owed.
2. **Prices must be confirmed by the previous block.** The hosted node once served a wrong share price at one height, twice in a row, 7.8 % above the truth ([`proof/node-flake.txt`](proof/node-flake.txt)), which made a vault look as if it lost 2,600 % a year. A price is trusted only when the price one block earlier agrees to 0.001 %; otherwise the anchor moves two blocks and it is tried again, four times, then the window is reported unreadable. Every figure in a run is pinned to blocks and carries its contract, call and block in the proof JSON (`evidence`).
3. **Steadiness.** The windows' median is the source's reference rate; their spread (highest minus lowest) says how jumpy it is. A source is flagged **JUMPY** when the spread is at least 1 percentage point and at least half the reference rate. A destination is credited its reference rate **minus** `haircut × spread`, the position we already hold its reference rate **plus** `haircut × spread`: a move has to win even when the odds go against it. Both nets are printed, conservative and at median rates.
4. **Costs, all read from the chain.**
   - *Gas:* exit + approve + deposit. The exit and the approve are priced by `estimate_gas` from the owner's address; the deposit cannot be estimated before the approve is mined, so its 300,000 units are a configured default, labelled "configured" wherever shown. Gas price from `get_gas_price`; the native token is valued by the WPROS/USDC pool's `slot0` (mainnet) or, for Atlantic's PHRS which has no market, by that same mainnet price as a stated stand-in.
   - *Exit fee:* `1 − previewRedeem(shares) / convertToAssets(shares)`. *Entry fee:* `1 − previewDeposit(a) / convertToShares(a)`. Morpho Blue charges neither.
   - *Dilution:* a Morpho market pays suppliers the borrowers' interest, so your deposit shrinks its rate to `supply / (supply + deposit)` of what it pays today; that factor is applied to the destination.
   - *Lock-in:* a destination's lock (read from the contract) longer than your holding period extends the horizon to the lock.
5. **The holding period decides.** Net = (destination rate − current rate) × amount × horizon / 365 − costs. The answer is MOVE only if net ≥ `--min-net-usd`, the costs are earned back within `--hold-days` (the **break-even**), and nothing blocks the exit or the entry.
6. **Blockers come from the contracts, and the exit is run, not assumed.** The exit is a `redeem` of all shares simulated with `eth_call` from the owner's address: the RockawayX vault reports `maxRedeem = 0` at all three blocks we asked (the head, 100,000 and 1,000,000 blocks back), yet a simulated redeem of the whole position succeeds ([`vault-reads.txt`](proof/vault-reads.txt)), so a simulation is the only honest test. An asynchronous (ERC-7540) Centrifuge vault answers `previewDeposit`/`previewRedeem` with a revert and `maxDeposit = 0` for this wallet: it cannot be entered or left in one transaction, so it is shown (rate, TVL) and never chosen. An unreadable balance, `maxDeposit`, price or interest-rate model is a stated blocker or "NOT CONSIDERED", never a zero.
7. **The plan.** For a MOVE the optimizer prepares three unsigned transactions, `redeem` (or Morpho `withdraw`) → `approve` → `deposit` (or Morpho `supply`), as `eth_sendTransaction` parameters, with a fingerprint. It deposits the previewed proceeds less `--slippage-bps`. Nothing is signed; the owner's wallet decodes the calldata and checks that funds can only come back to the owner before it signs ([`verifyPlan`](../../src/yield/plan.ts)).

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Compares at least 3 yield sources using live on-chain data." | Six sources on mainnet read live at one block: RockawayX (ERC-4626), JTRSY and HYB (Centrifuge), three Morpho Blue USDC markets (of the six markets the Liquidation Watchdog found, two lend WPROS and one holds under 1,000 USDC; the report lists them as left out). Four on Atlantic. Each rate is share-price growth over 3 windows, with the contract, call and block of every price in the proof JSON. | [`mainnet-rox-holder.txt`](proof/mainnet-rox-holder.txt) rows "Yield sources" · `src/yield/sources.ts` `readSource` |
| 2 | "Accounts for gas, entry/exit fees, and a minimum holding period before recommending a move." | Gas via `estimate_gas` × `get_gas_price` × native price; fees from `previewDeposit`/`convertToShares` and `previewRedeem`/`convertToAssets`; holding period = `--hold-days` (the costs must be earned back inside it; a longer lock-in extends it). The Atlantic vaults have a 0.1 % entry and exit fee and a 7-day lock-in, so all three show in a real decision. | ATLANTIC-TBD · `src/yield/model.ts` `evaluateMove` · tests "nets gas, exit fee and entry fee…", "applies a destination lock-in" |
| 3 | "Outputs a clear recommendation with expected net gain, or 'stay put' with the reason." | `RECOMMENDATION: MOVE: … net gain $X at conservative rates ($Y at median rates) … earned back in N` or `STAY PUT: <why>` naming the blocker or the best alternative's net and break-even. | [`mainnet-rox-holder.txt`](proof/mainnet-rox-holder.txt) (STAY), [`mainnet-rox-holder-median.txt`](proof/mainnet-rox-holder-median.txt) (MOVE), ATLANTIC-TBD |
| 4 | "If executing: prepares transactions for user signature only. The agent never holds keys." | The optimizer's output is an unsigned plan (`signed: false`, `eth_sendTransaction` parameters). `src/yield/*` and `index.ts` import no signer, read no secret and cannot send (a test greps their code); the Chain MCP client it opens has no broadcast option. Signing happens in a separate file that stands in for the owner's wallet, behind `--execute`. | [`mainnet-rox-plan.json`](proof/mainnet-rox-plan.json) + [`mainnet-rox-plan-verify.txt`](proof/mainnet-rox-plan-verify.txt) · test "keyless by construction" · ATLANTIC-TBD |

## Beyond the requirements

- **Break-even and steadiness.** Every candidate shows the days until its extra yield has paid back the move, and a source whose 1 d / 7 d / 30 d rates disagree is ranked down (JTRSY's NAV moves in steps: 0.00 % over a day, 3.55 % over a week).
- **A wrong read cannot decide.** Neighbour-confirmed prices (above), `maxDeposit`/balance/IRM failures stated, not zeroed.
- **A hostile or corrupted plan is refused.** The wallet decodes each calldata and rejects a redeem that pays anyone but the owner, an approval to a contract the deposit does not go to, a different amount, a foreign sender or value; it recomputes the fingerprint too, but says plainly that a fingerprint alone proves nothing.
- **Dilution** of a Morpho market by your own deposit, and **both nets** (conservative and median) so the haircut is visible, not hidden.

## Proof

Each proof JSON records `git.dirty: false` and the commit it ran at (`7cfae0d` for the mainnet runs); the `.txt` next to it is the same run as readable text.

| Run | Command | Result |
|---|---|---|
| **Mainnet, RockawayX holder** | `recommend --wallet 0x62A0…0673 --proof mainnet-rox-holder` | **STAY PUT**: the best enterable alternative (Morpho syzUSD/USDC) nets −$1.19 at conservative rates ($19.39 at median); the Centrifuge funds cannot be entered · [`txt`](proof/mainnet-rox-holder.txt) [`json`](proof/mainnet-rox-holder.json) |
| **Same wallet, jumpiness ignored** | `recommend --wallet 0x62A0…0673 --haircut 0 --plan proof/mainnet-rox-plan.json --proof mainnet-rox-holder-median` | **MOVE** to the Morpho APT/USDC market: net $40.54 over 30 d, break-even 5 min; three unsigned transactions (417,771 + 71,496 estimated, 300,000 configured gas) · [`txt`](proof/mainnet-rox-holder-median.txt) [`plan`](proof/mainnet-rox-plan.json) [`verify`](proof/mainnet-rox-plan-verify.txt) |
| **Mainnet, JTRSY holder** | `recommend --wallet 0x0665…4bE3 --proof mainnet-jtrsy-holder` | **STAY PUT**: a JTRSY redeem is an asynchronous request, so the position cannot be exited in one transaction · [`txt`](proof/mainnet-jtrsy-holder.txt) |
| **Atlantic** | ATLANTIC-TBD | ATLANTIC-TBD |
| The node's wrong read | transcript | [`node-flake.txt`](proof/node-flake.txt) |
| What "blocked" and "open" rest on | scratch script, transcript only (values at the head of 2026-10-25) | [`vault-reads.txt`](proof/vault-reads.txt) |

ATLANTIC-OUTPUT-TBD

## Limits, stated plainly

- **Yield, not risk.** The optimizer compares net yield. A Morpho market's collateral risk, a fund's NAV risk or a vault's strategy risk is not scored; the table names each source's kind and TVL, nothing more. Do not read a MOVE as safe.
- **Backward-looking.** A rate is what the share price did, annualised; it is not a forecast. A NAV drop (HYB's −10.65 % APR over 30 days) may be a distribution, which the share price cannot tell apart from a loss.
- **The mainnet MOVE is a plan, not a transaction.** No mainnet transaction was sent. The only executed move is on Atlantic, between our own vaults.
- **Entry is not simulated.** A `deposit` or `supply` can only be simulated after the approve is mined, so entry is judged by `maxDeposit`, the loan token and the preview functions ("no blocker found"); the exit is simulated.
- **Fees shrink the amount that earns**; that second-order effect (less than 0.01 % of the gain) is not modelled. A single deposit's price impact is modelled only for Morpho (dilution).
- **Gas for the deposit is a configured 300,000 units**; the node's `estimate_gas` is always asked at the head, even with `--block`.
- **Sources are a fixed list:** the three vault types above and the Morpho USDC markets found by the Liquidation Watchdog's scan (`MORPHO_MARKETS`); other protocols (Harbor, TermMax, Prosper) were not located on chain and are not read.
- **Test vault:** anyone can deposit for another address and so reset that address's lock-in; it is a testnet contract with no value.
