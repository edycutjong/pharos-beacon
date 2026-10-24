# Portfolio Assistant — Hard

**Task:** [Portfolio Assistant](https://pharos-agent-arena.vercel.app/tasks/portfolio-assistant) (Hard · 200 pts): answer natural-language questions about a wallet's positions, balances and yields across protocols, with sources, and say so when something cannot be read.

**What is real.** Everything is read from **Pharos mainnet (chain 1672)** through the Pharos Chain MCP, for **real third-party wallets** (we do not control them): wallet tokens (native PROS and the SkillEngine token list), the [RockawayX USDC vault](https://www.pharosscan.xyz/address/0x047cd0a91e9b92ed979189a6c8a120bf280f02e5) (`roxUSDC`, ERC-4626), the Centrifuge vaults JTRSY and HYB, and [Morpho Blue](https://www.pharosscan.xyz/address/0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb) positions in six markets. No wallet we found holds positions in two protocols at once (see Limits), so the proofs read a **watch-list of three unrelated wallets** together; every answer line says whose position it is. No mock, no model: the questions are classified by rules and every number comes from a chain read.

**Keys:** none. **Try it** (reproduces `proof/mainnet-watchlist-en.json` line for line; `--block` pins the read so it does not drift with the head):

```text
npm ci
npm run portfolio-assistant -- ask "What am I earning?" "Do I owe anything?" "Where is my USDC?" \
  --wallet 0x67765eA217d0021e35CA973dBae3b54823081a2b --wallet 0x62A0e4b7fD967fab5be1a733c09b22eBC4510673 --wallet 0x0665FDe254598e307b63f3aAe3cCd881a62d4bE3 --block 21136550
```

**Run:** `npm run portfolio-assistant -- ask "<question>"… | report  --wallet 0x… [--wallet 0x…] [--block N] [--window-days 7] [--proof name]`
- `ask` answers each question in turn (English or Bahasa Indonesia); `report` is `ask "what do I hold?"`.
- `--wallet` is repeated for several wallets; `--block N` reads the whole portfolio at block N (default: the head); `--window-days` is the look-back for yield and for "what changed" without a block (default 7).
- Questions understood: **how much** of a token · **where** is my token · **biggest** position · **earning** (yield) · **owe** (debt, health factor) · **total** value · **what do I hold** · **what changed** since block N / N days ago. Anything else gets a plain "I didn't understand" and the list above.

**Uses:** Pharos Chain MCP `eth_call`, `get_balance`, `get_code`, `get_block`, `get_block_number` (hosted `https://mcp.pharos.xyz/mcp`, mainnet); viem for ABI encoding only.

## How an answer is built

1. **One block.** Every read of a run is pinned to one block (`eth_call`/`get_balance`/`get_code` all carry it), so the figures in one answer are mutually consistent and a run is reproducible.
2. **Facts.** Each figure becomes a numbered fact `F1, F2, …` with its contract, the call and the block. An answer line that carries a number ends with the ids it used (`[F25, F40, F26]` for a derived figure); after the answers a **sources** table lists, per id: figure · contract · call · block. A test checks that no answer line with a number lacks its ids.
3. **Existence check.** The node answers `0` for a call to an address with no code. So before trusting a read the assistant checks `get_code` at that block; a contract that does not exist there becomes "I could not read …", never a zero balance or "no debt".
4. **Valuation.** USDC and the vaults' underlying (USDC, via `convertToAssets`) are valued at 1 USDC; PROS/WPROS at the spot price of the WPROS/USDC pool [`0x912c…f647`](https://www.pharosscan.xyz/address/0x912c9ade24d44d8922f0866d8dcb079f1363f647) (`slot0`); a Morpho position as collateral × the market's own oracle `price()` + supply − debt. Anything with no price source read (LINK, WETH, markets not borrowed in USDC) is listed as **not valued** and left out of totals.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Reads positions from at least 2 protocols or vaults, plus wallet token balances." | Wallet balances: native PROS + WPROS, USDC, LINK, WETH (`balanceOf`/`get_balance`). Vaults: roxUSDC (RockawayX), JTRSY and HYB (Centrifuge) via the share `balanceOf` and `convertToAssets`. Morpho Blue: `position()` in six markets (supply, collateral, debt) with the market's totals and oracle. | "What do I hold?" in [`mainnet-watchlist-en.json`](proof/mainnet-watchlist-en.json): wallet tokens, roxUSDC, JTRSY, and two Morpho markets in one answer; code `src/portfolio/read.ts` (`VAULTS`, `MORPHO_MARKETS`, `WALLET_TOKENS`) |
| 2 | "Answers at least 5 different natural-language question types correctly." | Eight types: how much · where · biggest · earning · owe · total · hold · changed, in English and Bahasa Indonesia. "Correctly": exact bigint arithmetic with Morpho's own rounding; the debt/health figures match an independent module; the yields recompute from the two cited share prices. | the 8 answered questions in the proof; [`independent-check.txt`](proof/independent-check.txt) (health 1.8223 and 1.3261 from the Liquidation Watchdog's code); 60 tests in `test/portfolio-assistant.test.ts` |
| 3 | "Shows numbers with sources: which contract and block each figure came from." | Every figure ends with `[F…]`; the sources table gives contract, call and block. | every answer in the proofs; the output block below |
| 4 | "Says clearly when it doesn't know or can't read a protocol, rather than guessing." | Declines a protocol it has no reader for (Harbor), a price prediction / advice, and a token it does not read (DOGE). Names every source it could not read, and never says "no debt" / "nothing earns" / "you hold none" over an unreadable source. | the last three questions of [`mainnet-watchlist-en.json`](proof/mainnet-watchlist-en.json); [`mainnet-before-deploy.json`](proof/mainnet-before-deploy.json): the same wallet read at block 1,000,000, before any of these contracts existed |
| 5 | "Read-only: never initiates transactions." | The task imports no signer and calls only `get_block_number`, `get_block`, `get_balance`, `get_code`, `eth_call` on the hosted mainnet server, which holds no key. A test greps `src/portfolio/` and the task for signer, send and broadcast names. | `test/portfolio-assistant.test.ts` › "read-only by construction"; the only tools in the fake-chain spy are the five read tools |

## Beyond the requirements

- **"What changed since block X?"** The same wallets at two blocks, matched position by position. Each row splits the change into what the owner did (balance or shares moved, priced at the earlier price) and what the market did (share price or PROS price moved, applied to the later amount); the two add up to the total. Morpho rows separate the collateral price move from "amounts changing, including interest accrued on the debt" (the interest cannot be told apart from a repayment without the event history). `ask "What changed since block 21000000?"`, or since `N days ago`.
- **Bahasa Indonesia.** Questions in Bahasa Indonesia get Bahasa Indonesia answers with the same cited figures.
- **Several wallets** in one run, each line naming the wallet.

## Proof

Each proof JSON records `git.dirty: false` and the commit it ran at. Reads are pinned, so the commands below reproduce the text of the proofs.

| Run | Command | Result |
|---|---|---|
| **Watch-list, English** | `ask "What do I hold?" "How much USDC do I have?" … --wallet 0x67765eA217d0021e35CA973dBae3b54823081a2b --wallet 0x62A0e4b7fD967fab5be1a733c09b22eBC4510673 --wallet 0x0665FDe254598e307b63f3aAe3cCd881a62d4bE3 --block 21136550 --proof mainnet-watchlist-en` (11 questions) | 8 answered types, 3 declined (Harbor, a price prediction, DOGE) · [`mainnet-watchlist-en.json`](proof/mainnet-watchlist-en.json) |
| **Bahasa Indonesia + what changed** | `ask "berapa saldo USDC saya?" … "apa yang berubah sejak blok 21000000?" "What changed since block 21000000?" "apa posisi Harbor saya?" … --block 21136550 --proof mainnet-bahasa-changed` (9 questions) | the same wallets, answers in Bahasa Indonesia; the change since block 21,000,000 split into balance moves and price moves · [`mainnet-bahasa-changed.json`](proof/mainnet-bahasa-changed.json) |
| **Unreadable sources** | `ask "What do I hold?" "How much USDC do I have?" "Do I owe anything?" "What am I earning?" --wallet 0x67765eA217d0021e35CA973dBae3b54823081a2b --block 1000000 --proof mainnet-before-deploy` | at block 1,000,000 none of the contracts existed: 9 unreadable sources named, no balance or debt claimed · [`mainnet-before-deploy.json`](proof/mainnet-before-deploy.json) |
| Independent check | the Liquidation Watchdog's `position` command on the same two Morpho positions | health 1.8223 and 1.3261 agree to four decimals · [`independent-check.txt`](proof/independent-check.txt) |
| How the wallets were chosen | scratch scripts, transcript only | [`wallet-search.txt`](proof/wallet-search.txt) |

### Real output (from the proof runs)

```text
Q: What am I earning?
A: 0x62A0…0673 · roxUSDC (RockawayX vault): 1 share grew 0.084% over 7.3 days (1.006414 USDC → 1.007258 USDC) [F40, F26]; 4.29% APY annualised [F40, F26]; on $19,469.79 [F25] that is about $835.36 a year [F25, F40, F26]
A: 0x0665…4bE3 · JTRSY (Centrifuge): 1 share grew 0.071% over 7.3 days (1.119288 USDC → 1.120079 USDC) [F41, F38]; 3.60% APY annualised [F41, F38]; on $34,510.28 [F37] that is about $1,243.70 a year [F37, F41, F38]
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

Q: What's my Harbor position?
A: I can't answer that: I don't read Harbor. I only read wallet token balances (SkillEngine list + PROS), the RockawayX and Centrifuge (JTRSY, HYB) vaults, and Morpho Blue markets on Pharos mainnet.

Q: apa yang menghasilkan bunga?
A: Dompet 0x67765eA217d0021e35CA973dBae3b54823081a2b pada blok 21136550:
A: Dompet 0x62A0e4b7fD967fab5be1a733c09b22eBC4510673 pada blok 21136550:
A: Dompet 0x0665FDe254598e307b63f3aAe3cCd881a62d4bE3 pada blok 21136550:
A: 0x62A0…0673 · roxUSDC (RockawayX vault): 1 share tumbuh 0.084% selama 7.3 hari (1.006414 USDC → 1.007258 USDC) [F39, F25]; 4.29% APY disetahunkan [F39, F25]; dari $19,469.79 [F24] itu sekitar $835.36 setahun [F24, F39, F25]
A: 0x0665…4bE3 · JTRSY (Centrifuge): 1 share tumbuh 0.071% selama 7.3 hari (1.119288 USDC → 1.120079 USDC) [F40, F37]; 3.60% APY disetahunkan [F40, F37]; dari $34,510.28 [F36] itu sekitar $1,243.70 setahun [F36, F40, F37]
A: Saya tidak bisa membaca Wallet: PROS price (WPROS/USDC pool) for 0x62A0…0673 at block 21136550: 0x912c9aDe24D44d8922f0866D8Dcb079f1363f647: slot0 answered differently twice for block 21136550. Saya tidak akan menebaknya.
sources:
  id | figure | contract | call | block
  F24 | roxUSDC worth in USDC | 0x047cD0a91E9B92ED979189a6C8A120bf280f02E5 | convertToAssets(shares) | block 21136550
  F25 | roxUSDC price of 1 share in USDC | 0x047cD0a91E9B92ED979189a6C8A120bf280f02E5 | convertToAssets(1 share) | block 21136550
  F36 | JTRSY worth in USDC | 0x160e0DD4C4f693b05Eca83Bc2Ec6fD51954fc434 | convertToAssets(shares) | block 21136550
  F37 | JTRSY price of 1 share in USDC | 0x160e0DD4C4f693b05Eca83Bc2Ec6fD51954fc434 | convertToAssets(1 share) | block 21136550
  F39 | roxUSDC price of 1 share in USDC (earlier) | 0x047cD0a91E9B92ED979189a6C8A120bf280f02E5 | convertToAssets(1 share) | block 20471891
  F40 | JTRSY price of 1 share in USDC (earlier) | 0x160e0DD4C4f693b05Eca83Bc2Ec6fD51954fc434 | convertToAssets(1 share) | block 20471891
```

## Limits (stated honestly)

- **Three wallets, not one.** No single wallet we found holds positions in two of these protocols: we checked the 13 Morpho borrowers the Liquidation Watchdog found and the recipients of vault-token transfers in the last 300,000 blocks (about 3 days) ([`wallet-search.txt`](proof/wallet-search.txt)). The watch-list is three unrelated public wallets read together: 0x6776…1a2b (Morpho Blue + wallet tokens), 0x62A0…0673 (roxUSDC) and 0x0665…4bE3 (JTRSY + USDC). Totals add them up; the assistant does not claim they are one person. Any single address works the same way (`--wallet` once).
- **Rules, not a model.** Questions are classified by keyword rules (English and Bahasa Indonesia), so unusual phrasing gets "I didn't understand" rather than a guess. There is no LLM anywhere, so no number can come from one.
- **Fixed coverage.** Three vaults and six Morpho markets (the markets the Liquidation Watchdog found on 2026-10-24) plus five wallet tokens. A protocol or a market outside that list is not read, and the assistant says so; it does not discover new ones. The RockawayX vault is an ERC-4626 vault (`convertToAssets` works) whose `MORPHO()` read fails, so we do not call it a Morpho vault.
- **Yield is a measurement, not a forecast.** "Earning" is the growth of one share's price between two blocks, annualised from that window (default 7 days); Morpho supply positions are listed but their APY is not computed.
- **Prices.** PROS/WPROS use one pool's spot price (not a TWAP); LINK, WETH and Morpho markets whose loan token is not USDC have no price read and are shown as "not valued". Morpho "position value" is collateral at the market's own oracle plus supply minus debt.
- **"What changed" needs state at the earlier block.** It worked at the 3-day default and at block 1,000,000 on the hosted server (both in the proofs); a pruned node would make those reads fail, which the assistant would report as unreadable.
- **Time.** One run makes a few hundred read calls and takes about a minute or two at the hosted server's rate limit.
- Tests: 60 in `test/portfolio-assistant.test.ts` (intent rules in both languages, snapshot reads through a fake Chain MCP including block pinning and the no-code check, every answer type with exact figures, citations on every number line, the change split, Bahasa wording, refusals, CLI input checks, the read-only grep); 1000 in the repo.
