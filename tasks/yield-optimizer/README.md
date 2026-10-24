# Yield Optimizer — Hard

**Task:** [Yield Optimizer](https://pharos-agent-arena.vercel.app/tasks/yield-optimizer) (Hard · 200 pts): compare the yield of several vaults or pools, factor in the costs, and recommend (or prepare) a rebalance only when moving is actually worth it.

**What is real, and what is ours.** The comparison runs on **Pharos mainnet (chain 1672)** through the Pharos Chain MCP, on six live yield sources: the [RockawayX USDC vault](https://www.pharosscan.xyz/address/0x047cd0a91e9b92ed979189a6c8a120bf280f02e5), the JTRSY and HYB fund vaults (Centrifuge), and the supply side of three [Morpho Blue](https://www.pharosscan.xyz/address/0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb) USDC markets. The wallets are real holders found on chain (neither is ours), so the answers are not staged: at the default rules the optimizer **stays put** for both of them (the JTRSY holder cannot leave its position in one transaction; the RockawayX holder's best enterable alternative nets −$1.31), and says why from what the contracts report. With `--haircut 0` (jumpiness ignored) the RockawayX wallet gets a MOVE plan, shown below and labelled. **We found no yield vault on Pharos Atlantic, so the executed move runs between four small vaults we deployed ourselves** ([`contracts/src/YieldVault.sol`](contracts/src/YieldVault.sol), addresses and deploy transactions in [`deployments.json`](deployments.json)): their share price grows at a rate the owner sets, on a funded reserve. They are test contracts, not a protocol, and are named "Atlantic …" everywhere. The optimizer itself is the same code on both networks.

**Keys:** the optimizer holds none and cannot send anything (`src/yield/` and `index.ts` import no signer, read no secret; a test greps for it). A move comes out as **unsigned transactions** for the owner's wallet. [`wallet.ts`](wallet.ts) is the separate stand-in for that wallet on testnet, the only file here that reads a key, and it signs only after `--execute` and after decoding the calldata itself.

**Try it** (keyless, read-only, mainnet; `--block` pins the reads, so the rates, fees and balances reproduce the proof; the gas lines follow the head; a full run takes several minutes at the hosted server's rate limit):

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
| 2 | "Accounts for gas, entry/exit fees, and a minimum holding period before recommending a move." | Gas via `estimate_gas` × `get_gas_price` × native price; fees from `previewDeposit`/`convertToShares` and `previewRedeem`/`convertToAssets`; holding period = `--hold-days` (the costs must be earned back inside it; a longer lock-in extends it). On Atlantic, Atlantic Growth charges 0.1 % on entry and on exit and Atlantic Lockup charges 0.5 % on entry and locks deposits for 7 days, so fees and lock-in show in real decisions. | [`atlantic-recommend-move.txt`](proof/atlantic-recommend-move.txt): the Lockup vault's 11 % headline loses to its 0.5 % entry fee (net −$0.002062, break-even 34 d) · [`atlantic-stay-short-hold.txt`](proof/atlantic-stay-short-hold.txt): the same move with a 3-day holding period stays put (break-even 15 d > 3 d) · `src/yield/model.ts` `evaluateMove` · tests "nets gas, exit fee and entry fee…", "applies a destination lock-in" |
| 3 | "Outputs a clear recommendation with expected net gain, or 'stay put' with the reason." | `RECOMMENDATION: MOVE: … net gain $X at conservative rates ($Y at median rates) … earned back in N` or `STAY PUT: <why>` naming the blocker or the best alternative's net and break-even. | [`mainnet-rox-holder.txt`](proof/mainnet-rox-holder.txt) (STAY), [`mainnet-rox-holder-median.txt`](proof/mainnet-rox-holder-median.txt) (MOVE), [`atlantic-recommend-move.txt`](proof/atlantic-recommend-move.txt) (MOVE), [`atlantic-after-move.txt`](proof/atlantic-after-move.txt) (STAY) |
| 4 | "If executing: prepares transactions for user signature only. The agent never holds keys." | The optimizer's output is an unsigned plan (`signed: false`, `eth_sendTransaction` parameters). `src/yield/*` and `index.ts` import no signer, read no secret and cannot send (a test greps their code); the Chain MCP client it opens has no broadcast option. Signing happens in a separate file that stands in for the owner's wallet, behind `--execute`. | [`mainnet-rox-plan.json`](proof/mainnet-rox-plan.json) + [`mainnet-rox-plan-verify.txt`](proof/mainnet-rox-plan-verify.txt) · [`atlantic-move-plan.json`](proof/atlantic-move-plan.json) signed and sent by the wallet stand-in ([`atlantic-move-executed.txt`](proof/atlantic-move-executed.txt)) · [`atlantic-tampered-refused.txt`](proof/atlantic-tampered-refused.txt) · test "keyless by construction" |

## Beyond the requirements

- **Break-even and steadiness.** Every candidate shows the days until its extra yield has paid back the move, and a source whose 1 d / 7 d / 30 d rates disagree is ranked down (JTRSY's NAV moves in steps: 0.00 % over a day, 3.56 % over a week).
- **A wrong read cannot decide.** Neighbour-confirmed prices (above), `maxDeposit`/balance/IRM failures stated, not zeroed.
- **A hostile or corrupted plan is refused.** The wallet decodes each calldata and rejects a redeem that pays anyone but the owner, an approval to a contract the deposit does not go to, a different amount, a foreign sender or value; it recomputes the fingerprint too, but says plainly that a fingerprint alone proves nothing.
- **Dilution** of a Morpho market by your own deposit, and **both nets** (conservative and median) so the haircut is visible, not hidden.

## Proof

Each run JSON (all but the two plan files) records `meta.git.dirty: false` and the commit it ran at: `7cfae0d` for the mainnet runs, `a77f58a` for the first two Atlantic recommendations, `5064a39` for the executed move, `9168c0b` for the after-move recommendation. `src/yield/`, `index.ts` and `wallet.ts` are byte-identical at all four commits and at the branch tip; the `.txt` next to it is the same run as readable text. The Atlantic runs cannot be re-run to the same numbers: the vaults' rates were set at the times in [`deployments.json`](deployments.json), the windows are relative to the head, and the user wallet now holds Atlantic Growth.

| Run | Command | Result |
|---|---|---|
| **Mainnet, RockawayX holder** | `recommend --wallet 0x62A0…0673 --proof mainnet-rox-holder` | **STAY PUT**: the best enterable alternative (Morpho syzUSD/USDC) nets −$1.31 at conservative rates ($19.41 at median); the Centrifuge funds cannot be entered · [`txt`](proof/mainnet-rox-holder.txt) [`json`](proof/mainnet-rox-holder.json) |
| **Same wallet, jumpiness ignored** | `recommend --wallet 0x62A0…0673 --haircut 0 --plan proof/mainnet-rox-plan.json --proof mainnet-rox-holder-median` | **MOVE** to the Morpho APT/USDC market: net $40.54 over 30 d, break-even 5 min; three unsigned transactions (417,771 and 71,496 gas estimated by the node, 300,000 configured) · [`txt`](proof/mainnet-rox-holder-median.txt) [`plan`](proof/mainnet-rox-plan.json) [`verify`](proof/mainnet-rox-plan-verify.txt) |
| **Mainnet, JTRSY holder** | `recommend --wallet 0x0665…4bE3 --proof mainnet-jtrsy-holder` | **STAY PUT**: a JTRSY redeem is an asynchronous request, so the position cannot be exited in one transaction · [`txt`](proof/mainnet-jtrsy-holder.txt) |
| **Atlantic, recommend** | `recommend --wallet 0x8D34…D91B --network atlantic --windows 10m,40m,58m --hold-days 30 --min-net-usd 0.001 --plan proof/atlantic-move-plan.json --proof atlantic-recommend-move` | **MOVE** Atlantic Steady → Atlantic Growth: net $0.006331, break-even 15 d; Spike (30 % over the last 10 min) refused as JUMPY, Lockup refused on its fee · [`txt`](proof/atlantic-recommend-move.txt) [`plan`](proof/atlantic-move-plan.json) |
| **Atlantic, 3-day holding period** | same, `--hold-days 3 --proof atlantic-stay-short-hold` | **STAY PUT**: break-even 15 d does not fit a 3-day hold · [`txt`](proof/atlantic-stay-short-hold.txt) |
| **Atlantic, the wallet** | `yield-wallet sign proof/atlantic-move-plan.json` (dry run), then `--execute --proof atlantic-move-executed` | exit [`0xacc8…d97b`](https://atlantic.pharosscan.xyz/tx/0xacc8c395773a0a4bd0a111e6e57dad5dea52e9b43cefc34e0fef6c3d8a29d97b), approve [`0x3552…a9168`](https://atlantic.pharosscan.xyz/tx/0x35520591c82318ccbdea5d579724f27366f91fad9a9b4494607628e4a78a9168), deposit [`0xd5f4…efee7`](https://atlantic.pharosscan.xyz/tx/0xd5f486fafd7e7213280f533696f868ead0af7cd35615d3b39cbdf4437e4efee7): all success; Atlantic Steady shares 2999999714611899295 → 0, Atlantic Growth shares 0 → 2993983487982010052 (read back) · [`dry`](proof/atlantic-wallet-dry.txt) [`json`](proof/atlantic-move-executed.json) |
| **Atlantic, after the move** | `recommend … --proof atlantic-after-move` | **STAY PUT** in Atlantic Growth: moving back to Steady or to Lockup nets negative at both rates; Spike nets −$0.0109 at conservative rates (+$0.0122 at median rates) and is ranked down as JUMPY · [`txt`](proof/atlantic-after-move.txt) |
| **Atlantic, a tampered plan** | the plan with its redeem edited to pay `0x…00ee` and the fingerprint recomputed, `yield-wallet sign … --execute` | refused before anything is signed, exit code 2 · [`txt`](proof/atlantic-tampered-refused.txt) |
| The node's wrong read | transcript | [`node-flake.txt`](proof/node-flake.txt) |
| What "blocked" and "open" rest on | scratch script, transcript only (values at the head of 2026-10-25) | [`vault-reads.txt`](proof/vault-reads.txt) |

### Real output (Atlantic, the recommendation that was executed)

```text
Moving $3.00 out of Atlantic Steady (credited at its optimistic 4.00%; destinations at their conservative rate):
  → Atlantic Growth: 5.00% better · over 30 d: gross $0.0123 − costs $0.005998 (gas $0.002998 [470100 units: exit:estimated, approve:estimated, enter:configured], exit fee $0.000000, entry fee $0.003000) = net $0.006331 at conservative rates, $0.006331 at median rates · break-even 15 d · WORTH IT
  → Atlantic Lockup: 6.46% better · over 30 d: gross $0.0159 − costs $0.0180 (…, exit fee $0.000000, entry fee $0.0150) = net -$0.002062 at conservative rates, -$0.000737 at median rates · break-even 34 d · not worth it
  → Atlantic Spike: 0.06% better · over 30 d: gross $0.000139 − costs $0.002998 (…) = net -$0.002859 at conservative rates, $0.0219 at median rates · break-even 649 d · not worth it

RECOMMENDATION: MOVE: move to Atlantic Growth: net gain $0.006331 at conservative rates ($0.006331 at median rates) over 30 d, after $0.005998 of costs; the costs are earned back in 15 d (holding period 30 d)
Prepared for the wallet owner's signature (nothing signed, no key read), plan 0x89bd…9805:
  1. Redeem all shares of Atlantic Steady · to 0x43C6…C70F · gas 98634 (estimated)
  2. Approve Atlantic Growth to pull 2997012 USDC raw (the exit's previewed proceeds 3000013 less 10 bps) · to 0xcfC8…Fc8B · gas 71466 (estimated)
  3. Deposit 2997012 USDC raw into Atlantic Growth · to 0x17Bd…062A · gas 300000 (configured)
```

The rates in that run (10 min / 40 min / 58 min windows): Steady 4.00 / 4.00 / 4.00 %, Growth 9.00 / 9.00 / 9.00 %, Lockup 11.00 / 11.00 / 12.07 %, **Spike 30.00 / 14.09 / 9.92 %** (its rate was raised from 2 % to 30 % about 16 minutes earlier, tx in `deployments.json`), so Spike's latest rate is the highest but its conservative rate is 4.06 % and it is ranked down. The gas planned was 470,100 units (the deposit's 300,000 is a configured default); the three transactions used 66,560 + 55,437 + 132,148 = 254,145 units, so the configured figure over-states the cost, which only makes a MOVE harder to reach. The gas price read (10 gwei) was also ten times the effective price paid (1 gwei).

### Real output (mainnet, the Morpho and vault rows of the default run)

```text
Yield sources, measured as share-price growth over each window, annualised (APR, simple):
  source                                 1d       7d      30d   median  conservative  notes
  Morpho Blue syzUSD/USDC supply      7.10%    5.47%    5.28%    5.47%         4.56%  TVL 3,912,148.440506
  Morpho Blue APC3M/USDC supply       3.59%    5.33%    5.29%    5.29%         4.42%  TVL 1,209,566.754175
  Morpho Blue APT/USDC supply         9.40%    4.38%      n/a    6.89%         4.38%  JUMPY (spread 5.02%: ranked down) · TVL 1,000,634.097499
  RockawayX USDC vault                4.77%    4.23%    3.99%    4.23%         3.84%  HELD · TVL 11,123,205.672192
  Janus Henderson Treasury Fund       0.00%    3.56%    3.47%    3.47%         1.70%  JUMPY (spread 3.56%: ranked down) · TVL 1,765,778.147055
  NYLIM US High Yield Bond Fund       0.00%   -0.20%  -10.66%   -0.20%        -5.53%  JUMPY (spread 10.66%: ranked down) · TVL 98,398.088663
…
RECOMMENDATION: STAY PUT: the best alternative that could be entered, Morpho Blue syzUSD/USDC supply, would net -$1.31 at conservative rates ($19.41 at median rates) over 30 d after $0.005046 of costs …
```

(The full text is in [`mainnet-rox-holder.txt`](proof/mainnet-rox-holder.txt); the lines above are copied from it, with the middle cut out.)

## Limits, stated plainly

- **Yield, not risk.** The optimizer compares net yield. A Morpho market's collateral risk, a fund's NAV risk or a vault's strategy risk is not scored; the table names each source's kind and TVL, nothing more. Do not read a MOVE as safe.
- **Backward-looking.** A rate is what the share price did, annualised; it is not a forecast. A NAV drop (HYB's −10.66 % APR over 30 days) may be a distribution, which the share price cannot tell apart from a loss.
- **The mainnet MOVE is a plan, not a transaction.** No mainnet transaction was sent. The only executed move is on Atlantic, between our own vaults.
- **Entry is not simulated.** A `deposit` or `supply` can only be simulated after the approve is mined, so entry is judged by `maxDeposit`, the loan token and the preview functions ("no blocker found"); the exit is simulated.
- **Fees shrink the amount that earns**; that second-order effect (less than 0.01 % of the gain) is not modelled. A single deposit's price impact is modelled only for Morpho (dilution).
- **Gas for the deposit is a configured 300,000 units**; the node's `estimate_gas` is always asked at the head, even with `--block`.
- **Sources are a fixed list:** the three vault types above and the Morpho USDC markets found by the Liquidation Watchdog's scan (`MORPHO_MARKETS`); other protocols named around the Arena (Harbor, TermMax, Prosper) are not read.
- **Test vault:** anyone can deposit for another address and so reset that address's lock-in; it is a testnet contract with no value.
