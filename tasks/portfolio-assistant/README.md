# Portfolio Assistant — Hard

**Task:** [Portfolio Assistant](https://pharos-agent-arena.vercel.app/tasks/portfolio-assistant) (Hard · 200 pts): answer natural-language questions about a wallet's positions, balances and yields across protocols, with sources, and say so when something cannot be read.

**What is real.** Everything is read from **Pharos mainnet (chain 1672)** through the Pharos Chain MCP, for **real third-party wallets** (found by an on-chain scan; we have no relation to them): wallet tokens (native PROS and the SkillEngine token list), the [RockawayX USDC vault](https://www.pharosscan.xyz/address/0x047cd0a91e9b92ed979189a6c8a120bf280f02e5) (`roxUSDC`; an ERC-4626-style vault: `totalAssets()` and `convertToAssets()` answer), the JTRSY and HYB tokenized-fund vaults (share-token names on chain: “Janus Henderson Treasury Fund” and “NYLIM US High Yield Bond Fund”), and [Morpho Blue](https://www.pharosscan.xyz/address/0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb) positions in six markets. **No single wallet we found holds positions in two of these protocols**, so the proofs read a **watch-list of three unrelated wallets** together; every answer line says whose position it is (see Limits). No mock, no model: the questions are classified by rules and every number comes from a chain read.

**Keys:** none. **Try it** (the three answers are the same text as in `proof/mainnet-watchlist-en.txt`; `--block` pins the read so it does not drift with the head, and if the hosted node misbehaves a source is reported unreadable instead of printed wrong, see point 4 below):

```text
npm ci
npm run portfolio-assistant -- ask "What am I earning?" "Do I owe anything?" "Where is my USDC?" \
  --wallet 0x67765eA217d0021e35CA973dBae3b54823081a2b --wallet 0x62A0e4b7fD967fab5be1a733c09b22eBC4510673 --wallet 0x0665FDe254598e307b63f3aAe3cCd881a62d4bE3 --block 21136550
```

**Run:** `npm run portfolio-assistant -- ask "<question>"… | report  --wallet 0x… [--wallet 0x…] [--block N] [--window-days 7] [--proof name]`
- `ask` answers each question in turn (English or Bahasa Indonesia); `report` is `ask "what do I hold?"`.
- `--wallet` is repeated for several wallets; `--block N` reads the whole portfolio at block N (default: the head); `--window-days` is the look-back for yield and for "what changed" without a block (default 7).
- `--proof name` also writes `proof/name.json` and the same run as readable text, `proof/name.txt`.
- Questions understood: **how much** of a token · **where** is my token · **biggest** position · **earning** (yield) · **owe** (debt, health factor) · **total** value · **what do I hold** · **what changed** since block N / N days ago. Anything else gets a plain "I didn't understand" and the list above.

**Uses:** Pharos Chain MCP `eth_call`, `get_balance`, `get_code`, `get_block`, `get_block_number` (hosted `https://mcp.pharos.xyz/mcp`, mainnet), plus `get_chain_info` once per connection (the chain-id check); viem for ABI encoding only.

## How an answer is built

1. **One block.** Every read of a run is pinned to one block (`eth_call`/`get_balance`/`get_code` all carry it), so the figures in one answer are mutually consistent and a run is reproducible.
2. **Facts.** Each figure becomes a numbered fact `F1, F2, …` with its contract, the call and the block. Every answer line that carries a figure ends with the ids it used (`[F25, F40, F26]` for a derived figure); after the answers a **sources** table lists, per id: figure · contract · call · block. The block header lines and the notes about unreadable sources name the block but cite no id. A test checks that no answer line with a figure lacks its ids.
3. **Existence check.** A call to an address with no code returns `0x` (`proof/vault-reads.txt`, section 3), which this reader rejects as "no uint256". So before trusting a read the assistant checks `get_code` at that block; a contract that does not exist there becomes "I could not read … not deployed yet", never a zero balance or "no debt".
4. **Every read is asked twice.** Each `eth_call` and `get_balance` is asked twice and must agree (a third read breaks a tie; no agreement = "I could not read …"). The hosted node has returned wrong numbers on single reads, two of 36 repeats of one historical call, and one share price in the first English proof: a historical USDC `balanceOf` of 1,420,307 (and once 1.44) instead of 4,382,642 for the same pinned block, and a head-block roxUSDC share price of 1.003821 instead of 1.007258 that made a vault look like it was losing money. Transcript: [`node-flake.txt`](proof/node-flake.txt). A wrong figure is worse than none.
5. **Valuation.** USDC and the vaults' underlying (USDC, via `convertToAssets`) are valued at 1 USDC; PROS/WPROS at the spot price of the WPROS/USDC pool [`0x912c…f647`](https://www.pharosscan.xyz/address/0x912c9ade24d44d8922f0866d8dcb079f1363f647) (`slot0`, re-read up to 4 times if the node answers it inconsistently); a Morpho position as collateral × the market's own oracle `price()` + supply − debt, with the parts shown. Anything with no price source read (LINK, WETH, markets not borrowed in USDC) is listed as **not valued** and left out of totals.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Reads positions from at least 2 protocols or vaults, plus wallet token balances." | Wallet balances: native PROS + WPROS, USDC, LINK, WETH (`balanceOf`/`get_balance`). Vaults: roxUSDC (RockawayX), JTRSY and HYB (fund vaults) via the share `balanceOf` and `convertToAssets`. Morpho Blue: `position()` in six markets (supply, collateral, debt) with the market's totals and oracle. The three proof wallets together hold wallet tokens, roxUSDC, JTRSY and two Morpho markets. | "What do I hold?" in [`mainnet-watchlist-en.txt`](proof/mainnet-watchlist-en.txt); code `src/portfolio/read.ts` (`VAULTS`, `MORPHO_MARKETS`, `WALLET_TOKENS`). One wallet holding two protocols was not found (Limits). |
| 2 | "Answers at least 5 different natural-language question types correctly." | Eight types: how much · where · biggest · earning · owe · total · hold · changed, in English and Bahasa Indonesia. "Correctly": exact bigint arithmetic with Morpho's own rounding (debt rounded up, as the contract does); the yields recompute from the two cited share prices; the −$4.38M row of "What changed" equals the wallet's USDC `Transfer`s out of the window; the health factors match the Liquidation Watchdog's CLI (it shares the Morpho read code, so this checks the wiring and block-to-block consistency, not the formula; the formula has its own recompute in `tasks/liquidation-watchdog/proof/independent-check.py`). | the 8 answered questions in the proof; [`independent-check.txt`](proof/independent-check.txt) (health 1.8223 and 1.3261); 66 tests in `test/portfolio-assistant.test.ts` |
| 3 | "Shows numbers with sources: which contract and block each figure came from." | Every figure ends with `[F…]`; the sources table gives contract, call and block. | every answer in the proofs; the output block below |
| 4 | "Says clearly when it doesn't know or can't read a protocol, rather than guessing." | Declines a protocol it has no reader for (Harbor), a price prediction / advice, and a token it does not read (DOGE). Names every source it could not read, and never says "no debt" or "nothing earns" while a Morpho or vault source is unreadable, and never says "you hold none" of a token whose own read failed; unreadable sources are always listed beside the answer. | the last three questions of [`mainnet-watchlist-en.txt`](proof/mainnet-watchlist-en.txt); [`mainnet-before-deploy.txt`](proof/mainnet-before-deploy.txt): the same wallet read at block 1,000,000, before any of these contracts existed: 9 unreadable sources named, no token balance or debt claimed (only native PROS was readable) |
| 5 | "Read-only: never initiates transactions." | The task imports no signer and calls only read tools on the hosted mainnet server (`get_chain_info` at connect, `get_block_number`, `get_block`, `get_balance`, `get_code`, `eth_call`). A test greps `src/portfolio/` and the task for signer, send and broadcast names. | `test/portfolio-assistant.test.ts` › "read-only by construction"; the fake-chain spy there sees five of those six tools (the sixth, `get_chain_info`, is in `src/lib/mcp.ts`, shared by every task) |

## Beyond the requirements

- **"What changed since block X?"** The same wallets at two blocks, matched position by position. Each row splits the change into what the owner did (balance or shares moved, priced at the earlier price) and what the market did (share price or PROS price moved); the two add up to the total. Morpho rows separate the collateral price move from the debt side ("the debt changing: interest accrued, or a borrow/repay"; the interest cannot be told apart from a repayment without the event history). `ask "What changed since block 21000000?"`, or since `N days ago`. The one large row in the proof (0x0665…4bE3, USDC −$4,382,336.95) is checked against the chain's own `Transfer` logs in `proof/usdc-outflow-check.txt`.
- **Bahasa Indonesia.** Questions in Bahasa Indonesia get Bahasa Indonesia answers with the same cited figures (token and protocol names, and the reason text of an unreadable source, stay in English).
- **Several wallets** in one run, each line naming the wallet.

## Proof

Each proof JSON records `git.dirty: false` and the commit it ran at; the `.txt` next to it is the same run as readable text. Reads are pinned, so the commands below reproduce the text of the proofs (a node that serves another state at a pinned block would differ).

| Run | Command | Result |
|---|---|---|
| **Watch-list, English** | `ask "What do I hold?" "How much USDC do I have?" "Where is my USDC?" "What's my biggest position?" "What am I earning?" "Do I owe anything?" "What is my total portfolio value?" "What changed since 3 days ago?" "What's my Harbor position?" "Will PROS go up next week?" "How much DOGE do I have?" --wallet 0x67765eA217d0021e35CA973dBae3b54823081a2b --wallet 0x62A0e4b7fD967fab5be1a733c09b22eBC4510673 --wallet 0x0665FDe254598e307b63f3aAe3cCd881a62d4bE3 --block 21136550 --proof mainnet-watchlist-en` | 11 questions: 8 answered types, 3 declined (Harbor, a price prediction, DOGE); 409 read calls, 311 s · [`.txt`](proof/mainnet-watchlist-en.txt) · [`.json`](proof/mainnet-watchlist-en.json) |
| **Bahasa Indonesia + what changed** | `ask "berapa saldo USDC saya?" "di mana USDC saya?" "apa posisi terbesar saya?" "apa yang menghasilkan bunga?" "apakah saya punya utang?" "berapa total nilai portofolio saya?" "apa yang berubah sejak blok 21000000?" "What changed since block 21000000?" "apa posisi Harbor saya?" … --block 21136550 --proof mainnet-bahasa-changed` (same wallets) | 9 questions (8 in Bahasa Indonesia, 1 in English); the change since block 21,000,000 split into balance moves and price moves; 610 read calls, 427 s · [`.txt`](proof/mainnet-bahasa-changed.txt) · [`.json`](proof/mainnet-bahasa-changed.json) |
| **Unreadable sources** | `ask "What do I hold?" "How much USDC do I have?" "Do I owe anything?" "What am I earning?" --wallet 0x67765eA217d0021e35CA973dBae3b54823081a2b --block 1000000 --proof mainnet-before-deploy` | at block 1,000,000 none of the contracts existed: 9 unreadable sources named, no token balance or debt claimed · [`.txt`](proof/mainnet-before-deploy.txt) · [`.json`](proof/mainnet-before-deploy.json) |
| Cross-check | the Liquidation Watchdog's `position` command on the same two Morpho positions, about 1,350 blocks later | health 1.8223 and 1.3261 agree to four decimals · [`independent-check.txt`](proof/independent-check.txt) |
| Check of the −$4.38M row | USDC `Transfer` logs out of 0x0665…4bE3 between the two blocks (scratch script, transcript only) | two transfers, 4,382,332.52 + 4.43 = 4,382,336.95 USDC, exactly the row in "What changed since 3 days ago?" · [`usdc-outflow-check.txt`](proof/usdc-outflow-check.txt) |
| The node's wrong reads | transcript | [`node-flake.txt`](proof/node-flake.txt) |
| How the wallets were chosen | scratch scripts, transcript only | [`wallet-search.txt`](proof/wallet-search.txt) |
| What the vault and no-code statements rest on | scratch scripts, transcript only (values at the head of 2026-10-25) | [`vault-reads.txt`](proof/vault-reads.txt) |

### Real output (excerpts, pasted verbatim from `proof/mainnet-watchlist-en.txt` and `proof/mainnet-bahasa-changed.txt`; wallet header lines and some sources tables left out)

```text
Q: What am I earning?
A: 0x62A0…0673 · roxUSDC (RockawayX vault): 1 share grew 0.084% over 7.3 days (1.006414 USDC → 1.007258 USDC) [F40, F26]; 4.29% APY annualised [F40, F26]; on $19,469.79 [F25] that is about $835.36 a year [F25, F40, F26]
A: 0x0665…4bE3 · JTRSY (Fund vault): 1 share grew 0.071% over 7.3 days (1.119288 USDC → 1.120079 USDC) [F41, F38]; 3.60% APY annualised [F41, F38]; on $34,510.28 [F37] that is about $1,243.70 a year [F37, F41, F38]
sources:
  id | figure | contract | call | block
  F25 | roxUSDC worth in USDC | 0x047cD0a91E9B92ED979189a6C8A120bf280f02E5 | convertToAssets(shares) | block 21136550
  F26 | roxUSDC price of 1 share in USDC | 0x047cD0a91E9B92ED979189a6C8A120bf280f02E5 | convertToAssets(1 share) | block 21136550
  F37 | JTRSY worth in USDC | 0x160e0DD4C4f693b05Eca83Bc2Ec6fD51954fc434 | convertToAssets(shares) | block 21136550
  F38 | JTRSY price of 1 share in USDC | 0x160e0DD4C4f693b05Eca83Bc2Ec6fD51954fc434 | convertToAssets(1 share) | block 21136550
  F40 | roxUSDC price of 1 share in USDC (earlier) | 0x047cD0a91E9B92ED979189a6C8A120bf280f02E5 | convertToAssets(1 share) | block 20471891
  F41 | JTRSY price of 1 share in USDC (earlier) | 0x160e0DD4C4f693b05Eca83Bc2Ec6fD51954fc434 | convertToAssets(1 share) | block 20471891

Q: Do I owe anything?
A: 0x6776…1a2b · Morpho Blue APT/USDC: debt 900,765.36 USDC, collateral 1,894,576.6198 APT [F12, F11]; health factor 1.8223 (collateral 1,908,657.11 USDC [F13]; may fall 45.1% before liquidation) [F12, F13]
A: 0x6776…1a2b · Morpho Blue APC3M/USDC: debt 1,004,931.82 USDC, collateral 1,500,000.6465 APC3M [F16, F15]; health factor 1.3261 (collateral 1,549,584.67 USDC [F17]; may fall 24.6% before liquidation) [F16, F17]
sources:
  id | figure | contract | call | block
  F11 | APT/USDC collateral (APT) | 0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb | position(id,wallet).collateral | block 21136550
  F12 | APT/USDC debt (USDC) | 0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb | position(id,wallet).borrowShares × market() | block 21136550
  F13 | APT/USDC collateral valued in USDC | 0xd7E33079D91c5fA12798C1e7b28A7877045aa7C3 | price() | block 21136550
  F15 | APC3M/USDC collateral (APC3M) | 0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb | position(id,wallet).collateral | block 21136550
  F16 | APC3M/USDC debt (USDC) | 0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb | position(id,wallet).borrowShares × market() | block 21136550
  F17 | APC3M/USDC collateral valued in USDC | 0x4Eb6fcFfc4D1B27eA773EDc062D5AdFC94A81FaE | price() | block 21136550

Q: What's my biggest position?
A: The biggest position across these wallets is 0x6776…1a2b · Morpho Blue APT/USDC (collateral + supply − debt): $1,007,891.76 = 1,908,657.11 USDC collateral + 0.00 USDC supplied − 900,765.36 USDC debt [F10, F13, F12]
A: Ranked #2: 0x6776…1a2b · Morpho Blue APC3M/USDC (collateral + supply − debt) $544,652.84 = 1,549,584.67 USDC collateral + 0.00 USDC supplied − 1,004,931.82 USDC debt [F14, F17, F16]
A: Ranked #3: 0x0665…4bE3 · JTRSY (Fund vault) $34,510.28 [F37]
A: Ranked #4: 0x62A0…0673 · roxUSDC (RockawayX vault) $19,469.79 [F25]
A: Ranked #5: 0x6776…1a2b · USDC in wallet $431.48 [F4]

Q: What's my Harbor position?
A: I can't answer that: I don't read Harbor. I only read wallet token balances (SkillEngine list + PROS), the RockawayX and JTRSY/HYB fund vaults, and Morpho Blue markets on Pharos mainnet.

Q: apa yang menghasilkan bunga?
A: 0x62A0…0673 · roxUSDC (RockawayX vault): 1 share tumbuh 0.084% selama 7.3 hari (1.006414 USDC → 1.007258 USDC) [F40, F26]; 4.29% APY disetahunkan [F40, F26]; dari $19,469.79 [F25] itu sekitar $835.36 setahun [F25, F40, F26]
A: 0x0665…4bE3 · JTRSY (Fund vault): 1 share tumbuh 0.071% selama 7.3 hari (1.119288 USDC → 1.120079 USDC) [F41, F38]; 3.60% APY disetahunkan [F41, F38]; dari $34,510.28 [F37] itu sekitar $1,243.70 setahun [F37, F41, F38]
```

## Limits (stated honestly)

- **Three wallets, not one.** None of the three holds positions in two protocols, but one single wallet does: the burn address 0x…dEaD holds RockawayX (1.01 USDC) and Morpho Blue supply (APT/USDC 1.00, APC3M/USDC 1.00) at block 21,146,194, read by the same assistant in [`mainnet-two-protocols.txt`](proof/mainnet-two-protocols.txt) (`--wallet 0x000000000000000000000000000000000000dEaD --block 21146194`; found by the Multi-Protocol Aggregator, nobody controls the address). The wallet search ([`wallet-search.txt`](proof/wallet-search.txt)) covered the 13 borrower addresses in the Liquidation Watchdog's borrower index (a state file that is not committed; its committed `proof/mainnet-scan-discord.json` lists the 13 open positions) and the recipients of vault-token transfers in the last 300,000 blocks (about 3 days); older holders were not scanned, so this does not prove none exists. The watch-list is three unrelated public wallets read together: 0x6776…1a2b (Morpho Blue + wallet tokens), 0x62A0…0673 (roxUSDC) and 0x0665…4bE3 (JTRSY + USDC). Totals add them up; the assistant does not claim they are one person. Any single address works the same way (`--wallet` once).
- **Rules, not a model.** Questions are classified by keyword rules (English and Bahasa Indonesia), so unusual phrasing gets "I didn't understand" rather than a guess. There is no LLM anywhere, so no number can come from one.
- **Fixed coverage.** Three vaults and six Morpho markets (those with `Borrow` events in the Liquidation Watchdog's scan on 2026-10-24; its committed `proof/mainnet-scan-discord.json` shows 13 open positions in five of them) plus native PROS and four tokens. HYB and four of the six Morpho markets hold nothing for the proof wallets, so they are exercised by tests only. A protocol or a market outside that list is not read, and the assistant says so; it does not discover new ones. The RockawayX vault is an ERC-4626-style vault whose `MORPHO()` read reverts (`vault-reads.txt`, section 2), so we do not call it a Morpho vault.
- **"Biggest" is by value, not by gross exposure.** A Morpho position counts as collateral + supply − debt, and the answer prints those parts next to the total.
- **Yield is a measurement, not a forecast.** "Earning" is the growth of one share's price between two blocks, annualised from that window (default 7 days); Morpho supply positions are listed but their APY is not computed. The "3 days ago" window and the 7-day yield window are different block spans, so their dates differ.
- **Prices.** PROS/WPROS use one pool's spot price (not a TWAP); LINK, WETH and Morpho markets whose loan token is not USDC have no price read and are shown as "not valued".
- **"What changed" needs state at the earlier block.** It worked 3 days back and since block 21,000,000 (the proofs); at block 1,000,000 the server also answered `get_code`, `get_balance` and `eth_call` (the unreadable-sources proof). A pruned node would make those reads fail, which the assistant would report as unreadable.
- **Time.** One run makes several hundred read calls at the hosted server's rate limit, every `eth_call` and `get_balance` asked twice: 409 calls in 311 s for the 11-question English proof, 610 in 427 s for the Bahasa one. A single question over one wallet is roughly 50 to 70 calls.
- Tests: 66 in `test/portfolio-assistant.test.ts` (intent rules in both languages, snapshot reads through a fake Chain MCP including block pinning, the no-code check and the slot0 retry, every answer type with exact figures, citations on every number line, the change split, Bahasa wording, refusals, CLI input checks, the read-only grep).
