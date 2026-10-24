# Arbitrage Scanner — Hard

**Task:** [Arbitrage Scanner](https://pharos-agent-arena.vercel.app/tasks/arbitrage-scanner) (SkillEngine · Hard · 200 pts): compare a price across two sources, net out fees and gas, and act only when the opportunity is still profitable after costs.

**Read this first: two different markets.** The **price sources are real**: on Pharos mainnet (chain 1672) a Uniswap-V3-style WPROS/USDC pool ([`0x912c9ade…f647`](https://www.pharosscan.xyz/address/0x912c9ade24d44d8922f0866d8dcb079f1363f647)) against a FaroSwap (DODO-style) WPROS/USDC pool ([`0xac998dD7…7196`](https://www.pharosscan.xyz/address/0xac998dD78829aDe9f654e0BE7a4D7F60D8B37196)), read read-only through the Pharos Chain MCP. Mainnet is never signed: a decision to act there produces a plan. The **executed trade is on our own contracts**: Atlantic has no DEX, so we deployed two small test pools ([`contracts/src/ArbPool.sol`](contracts/src/ArbPool.sol), Foundry, not audited): fixed rate, 30 bps fee, owner-settable rate, at [`0x4c614696…a271`](https://atlantic.pharosscan.xyz/address/0x4c614696467128e14ba15e82dce543335184a271) (pool A, 1 WPHRS = 0.65 USDC) and [`0xe9091a1d…b4cd`](https://atlantic.pharosscan.xyz/address/0xe9091a1d8c41b9b995d77e1fe939df97e169b4cd) (pool B, rate moved to 0.665 by the owner in the demo). They move the real Atlantic test USDC and WPHRS. Deploy txs and every setup tx are in [`deployments.json`](deployments.json). So: real data shows a real spread being **skipped**, and our own market shows a spread being **taken**.

**Keys:** none for mainnet scans and the backtest. Atlantic needs `PRIVATE_KEY` in `~/.config/pharos/testnet.env` (only `--execute` and `move-rate` sign). **Try it with no key:** `npm ci && npm run arbitrage-scanner -- scan` (mainnet, read-only). For the Atlantic scans add `npm run setup:mcp` first and `--network atlantic`.

**Run:** `npm run arbitrage-scanner -- scan|backtest|move-rate [--network pharos|atlantic] [--min-profit 0.001] [--sizes 0.01,0.05,0.1] [--slippage-bps 10] [--gas-units 350000] [--execute] [--log file] [--proof name]`.
`scan` reads both sources, prints every candidate and the decision, appends one JSON line to the scan log (`state/scans.jsonl`, git-ignored; `--log` or `ARB_LOG` changes it) and sends nothing unless `--network atlantic --execute`. `backtest [--hours 24 --every-min 60]` replays the same two sources and rule at pinned past blocks. `move-rate --network atlantic --pool A|B --rate 0.665` is the owner switch for our test pool.
**Uses:** Pharos Chain MCP for every read and the Atlantic broadcast (hosted `https://mcp.pharos.xyz/mcp` for mainnet, local stdio server for Atlantic), viem for ABI encoding and local signing, a SkillEngine-format [`SKILL.md`](../../skills/arbitrage-scanner/SKILL.md).

## What one scan does

1. **Read two sources at the same block**: the V3-style pool's `slot0`, `liquidity`, `tickSpacing`, `fee` (the price and the exact-input quote are computed locally with the V3 formulas, inside the current tick range) and the FaroSwap pool's `getMidPrice`, fee rate and `querySellBase` / `querySellQuote` (real pool quotes). On Atlantic, the two ArbPools' `quote()` and balances.
2. **Price every round trip**: buy the base token (WPROS) on one source and sell it on the other, in both directions, at each size in `--sizes`.
3. **Net the costs** off the gross spread (mid-price spread × amount): nominal swap fees of both legs, **price impact** (what the pool curves took beyond the fees), a **slippage allowance** (`--slippage-bps` of the amount) and **gas** (`--gas-units` × gas price, priced in USDC at the sell pool's mid). The four cost columns plus the gross reproduce the result: `net = USDC back − USDC in − slippage buffer − gas`, from the pools' own quotes.
4. **Decide**: ACT only when the best candidate's net is positive, its gross spread is positive and net ≥ `--min-profit`; otherwise SKIP with the sentence that says which cost ate the spread.
5. **Log** the scan: sources and mids, every candidate with gross bps, gross, fees, impact, slippage buffer, gas, net, and the decision with its reason.

On a decision to act: mainnet → an unsigned **plan** (two legs, the minimum each must pay out, pool-level calldata); Atlantic without `--execute` → the same plan; Atlantic with `--execute` → leg 1, a **fresh read of leg 2** with what leg 1 really paid out, and leg 2 only if the round trip still clears the threshold (otherwise it stops and says it holds the token).

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Reads prices from at least 2 sources in the same scan." | Every scan reads two pools of different kinds in one pass at one block number: V3-style pool + FaroSwap pool on mainnet, pool A + pool B on Atlantic. Both sources and their mid prices are printed and logged in each scan record (`sources`). | [`scan.sources`](proof/mainnet-skip.json) · readers [`venues.ts:95`](../../src/arb/venues.ts), [`:116`](../../src/arb/venues.ts), [`:174`](../../src/arb/venues.ts) · [`proof/mainnet-skip.txt`](proof/mainnet-skip.txt) lines 2-3 |
| 2 | "Calculates net profit after swap fees, slippage estimate, and gas." | Per candidate: `fees` (both legs' swap fees), `impact`, `slippageBuffer` (`--slippage-bps`), `gas`, and `net`; gross − fees − impact equals the quoted USDC back − USDC in (a test asserts the identity). Gas = `--gas-units` × the node's gas price in USDC at the sell mid. | [`scan.ts:70`](../../src/arb/scan.ts) (`priceRoute`), [`:65`](../../src/arb/scan.ts) (`gasCost`) · columns in every table, e.g. [`proof/atlantic-execute.txt`](proof/atlantic-execute.txt) |
| 3 | "Acts (or prepares the transaction) only above a configurable profit threshold; otherwise logs why it skipped." | `--min-profit` (default 0.001 USDC). The same Atlantic spread **acts at 0.001 and skips at 0.05** with the reason `net 0.029566 USDC < the 0.050000 USDC threshold: the spread survives its costs, but the profit is under the threshold`. Other skip reasons: spread not positive, spread does not survive costs, no route could be quoted. An ACT prepares the unsigned plan (mainnet and Atlantic) and, on Atlantic with `--execute`, sends it. | [`scan.ts:95`](../../src/arb/scan.ts) (`decide`), [`execute.ts:49`](../../src/arb/execute.ts) · [`atlantic-threshold-skip.json`](proof/atlantic-threshold-skip.json) · [`atlantic-plan.json`](proof/atlantic-plan.json) (`plan`, `signed: false`) · [`atlantic-execute.json`](proof/atlantic-execute.json) |
| 4 | "Logs every scan with gross spread, costs, net result and decision." | Every `scan` and every backtest step appends one JSON line: sources, config, all candidates (gross bps, gross, fees, impact, slippage buffer, gas, net) and `decision` + `reason`. The proof folders keep the lines as `*.jsonl`; the 25 backtest scans are in one file. | [`logLine` `scan.ts:120`](../../src/arb/scan.ts) · [`proof/mainnet-backtest-24h.jsonl`](proof/mainnet-backtest-24h.jsonl) (25 lines) · [`proof/atlantic-execute.jsonl`](proof/atlantic-execute.jsonl) |
| 5 | "Works safely on testnet or with simulated execution; no requirement to risk real funds." | Mainnet is read-only and cannot sign (the only signer in the repo refuses any chain but Atlantic). The executed trade is Atlantic test tokens on our own pools, with `minOut` on both legs, a re-read before leg 2, and `--execute` required. | [`signer.ts:139`](../../src/lib/signer.ts) · [`execute.ts:77`](../../src/arb/execute.ts) · tx links below |

## Proof

Each proof JSON records `git.dirty: false` and the commit it ran at (the engine changed afterwards only in the ways listed under "Commits").

| Run | Command | Result |
|---|---|---|
| **Real mainnet spread, skipped** | `scan --proof mainnet-skip` | The two pools differ by **+149.7 bps** (gross 0.000150 USDC on 0.01 USDC) at block 21128786, but costs are 0.002382 USDC (gas 0.002319 alone) → **net −0.002232 USDC, SKIP** · [`mainnet-skip.json`](proof/mainnet-skip.json) |
| **Backtest on real history** | `backtest --hours 24 --every-min 60 --proof mainnet-backtest-24h` | 25 scans at pinned blocks 21033562…21128218 (24 h): gross spread positive in **25 of 25** (median best gross 222.5 bps), **acted 0**, best net −0.001028 USDC · [`mainnet-backtest-24h.json`](proof/mainnet-backtest-24h.json) |
| Atlantic, spread too small | `scan --network atlantic --proof atlantic-skip` | Pool B at 0.653 vs pool A 0.65: gross +46.2 bps, fees alone 60 bps → net −0.002888 USDC, SKIP · [`atlantic-skip.json`](proof/atlantic-skip.json) |
| Rate moved | `move-rate --network atlantic --pool B --rate 0.665` | pool B rate 0.665 · [`0x039f1709…681f`](https://atlantic.pharosscan.xyz/tx/0x039f17092a30c6bf5860c5c4050c8e9a9aa376719aa6814f99b7d62383b7681f) · [`atlantic-move-rate.txt`](proof/atlantic-move-rate.txt) |
| Same spread, higher threshold | `scan --network atlantic --min-profit 0.05 --proof atlantic-threshold-skip` | gross +230.8 bps, net 0.029566 USDC < 0.05 threshold → SKIP with the reason · [`atlantic-threshold-skip.json`](proof/atlantic-threshold-skip.json) |
| Plan only | `scan --network atlantic --proof atlantic-plan` | ACT: two legs prepared (min out 3.06462461 WPHRS, then 2.031860 USDC), nothing sent · [`atlantic-plan.json`](proof/atlantic-plan.json) |
| **Executed** | `scan --network atlantic --execute --proof atlantic-execute` | COMPLETED: USDC 12.421000 → 12.454894, WPHRS unchanged at 0.50581000 · approve [`0x6e8533b7…0187`](https://atlantic.pharosscan.xyz/tx/0x6e8533b723d58641f2b4c3efdb357640dbe51819c9e115f27168ada7e6ab0187) · swap on A [`0x26731723…4e76`](https://atlantic.pharosscan.xyz/tx/0x26731723dac690cc45a9f69de39055d173b95edbe04b12030e91f2205edc4e76) · approve [`0x6aa2f4b3…601e`](https://atlantic.pharosscan.xyz/tx/0x6aa2f4b3b5e17f035479cbd52a033b64ab9f62f1d8fc83d6f71b545ee349601e) · swap on B [`0xe1626329…6974`](https://atlantic.pharosscan.xyz/tx/0xe16263292eda2cb442f65f70b37e5dee9457e4e36374b06869663b43f4296974) · [`atlantic-execute.json`](proof/atlantic-execute.json) |

**Predicted vs realised (executed run):** predicted net 0.031566 USDC (the scan's 0.029566 plus its 0.002 slippage buffer, with gas estimated at 350,000 units and the node's quoted gas price), realised net after the gas actually paid **0.033703 USDC**. The four transactions used 286,590 gas against the 350,000 configured, and the node's reported gas price is above what they paid, so the estimate was conservative.

### Real output: the mainnet scan (from `proof/mainnet-skip.txt`)

```text
scan at block 21128786 (pharos) — WPROS/USDC
  source uniswap-v3-style 0x912c…f647       mid 0.652567 USDC per WPROS · fee 1.00 bps
  source dodo-v2-pmm 0xac99…7196            mid 0.662334 USDC per WPROS · fee 24.00 bps
  route             in  gross bps      gross       fees     impact       slip        gas         NET
  A→B         0.010000      149.7   0.000150   0.000031   0.000022   0.000010   0.002319   -0.002232
  A→B         0.050000      149.7   0.000748   0.000156   0.000514   0.000050   0.002319   -0.002291
  A→B         0.100000      149.7   0.001497   0.000308   0.002037   0.000100   0.002319   -0.003267
  A→B         0.250000      149.7   0.003742   0.000749   0.012358   0.000250   0.002319   -0.011934
  A→B         0.500000      149.7   0.007484   0.001431   0.047138   0.000500   0.002319   -0.043904
  B→A         0.010000     -147.5  -0.000147   0.000031   0.000020   0.000010   0.002284   -0.002492
  ...
  (route A→B = buy WPROS on source A, sell on B)
SKIP: best round trip uniswap-v3-style 0x912c…f647 → dodo-v2-pmm 0xac99…7196 starting with 0.010000 USDC: gross +149.7 bps (0.000150 USDC), costs 0.002382 USDC (fees 0.000031 USDC + impact 0.000022 USDC + slippage buffer 0.000010 USDC + gas 0.002319 USDC) → net -0.002232 USDC < the 0.001000 USDC threshold: the spread does not survive its costs
```

### Real output: the executed trade (from `proof/atlantic-execute.txt`)

```text
ACT: best round trip arb-pool 0x4c61…a271 → arb-pool 0xe909…b4cd starting with 2.000000 USDC: gross +230.8 bps (0.046154 USDC), costs 0.016588 USDC (fees 0.012120 USDC + impact 0.000140 USDC + slippage buffer 0.002000 USDC + gas 0.002328 USDC) → net 0.029566 USDC ≥ the 0.001000 USDC threshold
leg 1: 2.000000 USDC → WPHRS on arb-pool 0x4c61…a271 (min out 3.06462461)
  bought 3.06769230 WPHRS
re-read leg 2: arb-pool 0xe909…b4cd pays 2.033894 USDC for 3.06769230 WPHRS; projected net 0.030631 (gas so far + the rest, slippage buffer included)
leg 2: 3.06769230 WPHRS → USDC on arb-pool 0xe909…b4cd (min out 2.031860)
completed: USDC 12.421000 → 12.454894 · WPHRS 0.50581000 → 0.50581000 · predicted net 0.031566 · realised net after gas 0.033703
```

## Beyond the requirements: a backtest on real history

`backtest` runs the **same two sources and the same decision rule** at past blocks (an `eth_call` with a block, the gas price of that block), one scan per hour over 24 h, and reports how often a spread survived fees + gas. The answer on this pair is sobering and is the point: the gross spread is there in every scan (positive in 25 of 25, median best gross 222.5 bps), but **it never survives its costs** (0 of 25): the best size in every scan is 0.01–0.10 USDC, gas alone (about 0.002 USDC at the pinned blocks' base fees) is larger than the spread earns at that size, and larger sizes pay more price impact than the spread yields. The scanner's job is to say that, scan after scan, rather than to find a profitable trade that is not there. Counts and every scan: [`proof/mainnet-backtest-24h.json`](proof/mainnet-backtest-24h.json).
This pair differs from the DODO-vs-FaroSwap pairs other builders scan: it is a V3-style pool against FaroSwap.

## Limits (stated honestly)

- **No profitable mainnet trade exists in our data.** The mainnet proof is a skipped spread and a 24 h backtest with 0 of 25 acting; the executed trade is on our own Atlantic test pools, whose price gap we created (the owner moved pool B's rate). It shows the act path end to end, not a market inefficiency.
- **Gas is an estimate on mainnet**: `--gas-units 350000` for the whole two-leg round trip, not measured there (no mainnet transaction is ever sent). On Atlantic it is measured from receipts and the run reports both.
- **The V3-style quote is exact only inside the current tick range**; a size that would leave it is refused rather than guessed (the pool's fee tier has tick spacing 1, so only small sizes are priced). Quotes use the pool's `liquidity()` at the scan block and ignore ticks beyond the range.
- **The V3-style pool is priced from its state, not simulated**: no router for it is documented, so its leg in a mainnet plan is the pool-level `swap` call a helper contract would make, flagged as such in the plan. Nothing in a plan is signed.
- **The hosted RPC sometimes answers a historical read from another state.** The readers refuse a FaroSwap read whose mid price disagrees with a tiny sale or whose quote beats its own mid price, and a V3 read whose `slot0` answers differently twice, and retry up to 3 times (tests cover each). The first version of the backtest acted on such a read twice (a quote far better than the pool's own mid); it was found by looking at a negative gross spread marked ACT, and an ACT now requires a positive gross spread as well.
- **Atlantic pools have finite liquidity**: a size beyond what a pool holds is refused. The pools were topped up after the executed run (see [`deployments.json`](deployments.json)), so re-running `scan --network atlantic --execute` is possible but its numbers will differ from the proof.
- WPROS is priced 1:1 with PROS for gas; both are the same token wrapped.

## Commits

Proofs were recorded commit by commit, each on a clean tree (`dirty: false`): the mainnet scan at `156c3a2`, the backtest at `2892e4e`, then the Atlantic runs. After the Atlantic proofs the engine changed in one way that does not alter any recorded number: an ArbPool quote beyond the pool's own balance is refused (and the pool balance read added to the log's `raw`). Tests: 28 in `test/arbitrage-scanner.test.ts` (V3 math, the cost identity, every skip reason, the threshold, plan building, both executions including the stop after leg 1, the inconsistent-read guards).
