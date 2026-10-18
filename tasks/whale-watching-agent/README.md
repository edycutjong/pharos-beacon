# Whale-Watching Agent — Medium

**Task:** [Whale-Watching Agent](https://pharos-agent-arena.vercel.app/tasks/whale-watching-agent) (Trading / Monitoring · Medium · 100 pts):
tracks a set of addresses and reports significant moves.
**Run:** `npm run whale-watching-agent` (keyless, Pharos mainnet, read-only; it scans the last 5,000 blocks by default). Pin a range with
`-- --from-block 20506432 --to-block 20546432`; `--state f` remembers where it stopped so the next run continues from there;
`--notify discord` also posts the moves furthest above their thresholds (see below); `--compact` prints a narrow 3-line-per-report view (used for the demo video); `--proof label` writes `proof/<label>.json`.
**Uses:** Chain MCP ✅ (`get_block_number`, `get_logs`, `eth_call`, `get_code`, `get_block`) · SkillEngine: only the token registry
(`src/lib/networks.ts`) · Docs MCP: not used. The agent never sends a transaction; its only outbound call is the optional Discord message.

## Which addresses

[`watchlist.json`](watchlist.json) holds 7 addresses, the two token thresholds and our own labels. It is a config
file, not code: edit it and re-run. The addresses are not a list from anyone else: [`scripts/find-whales.ts`](../../scripts/find-whales.ts)
(`npm run find-whales`) ranks the addresses that moved the most USDC and WPROS over 40,000 blocks of Transfer logs ([`find-whales-output.txt`](find-whales-output.txt) is its output at head 20546432); `watch-1` to `watch-6` are the six top USDC movers and
`watch-7` is the third WPROS mover, and the `source` field says so. They are named `watch-1` … `watch-7` because we do not know who they are.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Tracks at least 5 configurable addresses." | 7 addresses in `watchlist.json`; the parser rejects a list with fewer than 5, a repeated address or a missing label. Each is checked with `get_code` and printed as wallet or contract | first lines of the sample below · `test/whale.test.ts` "needs 5+ addresses" |
| 2 | "A configurable 'significant' threshold per token or in value terms." | One threshold per token in human units (USDC ≥ 25,000, WPROS ≥ 2,000), turned into base units with the token's own `decimals()`. Moves below it are counted but not reported | `tokens` in `watchlist.json` · line `4650 transfers touch a watched address · 16 at or above their token's threshold` in the sample |
| 3 | "Each report explains the move: what moved, how much, and where to (labelled where known)." | Every report has the direction (IN / OUT / BETWEEN), the amount with decimals, `from → to`, a `why it matters` line and the balance before and after, read with `eth_call` at the block before and at the move's block. Labels: our watchlist names, the Pharos token registry and the null address. **Counterparts we cannot label print as `unlabelled wallet` or `unlabelled contract` (from `get_code`) and are not claimed to be labelled** | the 16 reports in [`proof/usdc-wpros-40k-blocks.json`](proof/usdc-wpros-40k-blocks.json) (`significant[]`: `fromName`, `toName`, `why`) |
| 4 | "Produces a summary view of recent activity across all watched addresses." | A table with one row per watched address and token (all transfers, significant ones, significant in / out, largest) and a totals line | the `summary across all watched addresses` table in the sample · `summary` in the proof |

## Beyond the requirements: Discord alerts

`--notify discord` posts the significant moves that are the largest multiple of their token's threshold (`--discord-max`, default 5; ranked by that multiple because the raw amounts of a 6- and an 18-decimal token are not comparable) to a Discord channel through the same webhook notifier
as the [On-Chain Alert Bot](../on-chain-alert-bot/README.md) (`~/.config/discord/webhook-alerts`, read at run time, never committed). A
sent-set (`--sent`) makes a re-run send nothing twice. Live: 3 messages, ids in the proof
(`notify.delivered`: `1561302866998591588`, `1561302870266216519`, `1561302872497590365`), and the re-run
[`proof/rerun-no-repeat.json`](proof/rerun-no-repeat.json) sent 0 (`notify.alreadySent: 3`; the CLI prints `0 sent, 3 already sent earlier`).

## Proof (Pharos mainnet, chain 1672, blocks 20506432–20546432, pinned)

| Run | Result | File |
|---|---|---|
| 7 watched addresses, USDC ≥ 25,000 and WPROS ≥ 2,000 | 4,650 transfers touch a watched address, 16 are significant (10 USDC, 6 WPROS), 3 sent to Discord (the 3 furthest above their thresholds) | [`proof/usdc-wpros-40k-blocks.json`](proof/usdc-wpros-40k-blocks.json) |
| Same range again with the same sent-set | 0 sent, 3 already sent earlier (`notify.alreadySent`) | [`proof/rerun-no-repeat.json`](proof/rerun-no-repeat.json) |
| Same range with `--compact` (the run recorded for the demo video; a different sent-set, so 3 more Discord messages) | the same 16 significant moves | [`proof/video-run.json`](proof/video-run.json) |

The range is pinned (`--to-block 20546432`), so the same report comes back on any day; the explorer links open the real transactions.
All three proofs were produced by committed code (`dirty: false`).

```text
$ npm run whale-watching-agent -- --from-block 20506432 --to-block 20546432 --notify discord --discord-max 3 --sent /tmp/p102/whale-sent.json --proof usdc-wpros-40k-blocks
whale watch on pharos (chain 1672) via https://mcp.pharos.xyz/mcp
blocks 20506432–20546432 (40001 blocks, pinned) · 7 addresses · USDC ≥ 25000, WPROS ≥ 2000
watchlist source: scripts/find-whales.ts at head 20546432 ranked the addresses that moved the most USDC and WPROS in blocks 20506432-20546432 (output in find-whales-output.txt). watch-1 to watch-6 are the six top USDC movers; watch-7 is the third WPROS mover (the first two are already in the list). Our own list; edit it freely.
  watching 0xB9012614F6151D5569E48E21bABf5fF3F14F0459  watch-1 · wallet
  watching 0xF3503DA2961fF5118ADaa2C4fF8D9A6FB28a411f  watch-2 · contract
  watching 0x912c9aDe24D44d8922f0866D8Dcb079f1363f647  watch-3 · contract
  watching 0xfd78EE919681417d192449715b2594ab58f5D002  watch-4 · contract
  watching 0x936564245B69f5a293b42cbd752E0eE3bb68b470  watch-5 · contract
  watching 0xFf70F4A1d11995621854F3692acF286d8aCd04b2  watch-6 · contract
  watching 0x1F3546a29EeC2102c8d52E21a45114124014c85C  watch-7 · wallet
scanned USDC: 2379 transfers touch a watched address, 10 at or above 25000
scanned WPROS: 2271 transfers touch a watched address, 6 at or above 2000

4650 transfers touch a watched address · 16 at or above their token's threshold

[…]

[7] IN 299,999.5 USDC · block 20528623 · 2026-10-18T02:18:34.000Z
    0x0000…0000 (null address (mint or burn)) → 0xB901…0459 (watch-1)
    why it matters: 11.99× the 25,000 USDC threshold; NEW POSITION: the address held 0 USDC before this; the largest USDC move touching the watchlist in this range; a mint into the watched address
    balance of 0xB901…0459: 0 USDC → 299,999.5 USDC
    https://www.pharosscan.xyz/tx/0x5779ac323897b98eb911e31042164de26382f0c02f019e1bdc97f91527cb126e

[8] BETWEEN 299,999.5 USDC · block 20531788 · 2026-10-18T03:12:07.000Z
    0xB901…0459 (watch-1) → 0xF350…411f (watch-2)
    why it matters: 11.99× the 25,000 USDC threshold; the largest USDC move touching the watchlist in this range
    balance of 0xB901…0459: 299,999.5 USDC → 0 USDC
    https://www.pharosscan.xyz/tx/0x9383d54494558d4019beea5c39d0044d570dd2e2659d9b1b5b710899967b0ab8

[11] IN 7,596.6233 WPROS · block 20542276 · 2026-10-18T06:09:26.000Z
    0x4fD4…5FAE (unlabelled contract) → 0x912c…f647 (watch-3)
    why it matters: 3.79× the 2,000 WPROS threshold; it adds 1.6% to its WPROS balance; the largest WPROS move touching the watchlist in this range; received from a contract, which usually means a deposit, swap or bridge (a heuristic, not a fact)
    balance of 0x912c…f647: 449,987.4693 WPROS → 457,584.0927 WPROS
    https://www.pharosscan.xyz/tx/0xd323d8e7efa5648e82731b0740b11584bfe856ae0eb079de4179310cb3598abd

[…]

summary across all watched addresses (significant moves only in/out/largest)
watched address      token  transfers  significant     in (sig.)   out (sig.)      largest
-------------------  -----  ---------  -----------  ------------  -----------  -----------
watch-1 0xB901…0459  USDC           2            2     299,999.5    299,999.5    299,999.5
watch-1 0xB901…0459  WPROS          0            0             0            0            0
watch-2 0xF350…411f  USDC          23            5  438,118.6894            0    299,999.5
watch-2 0xF350…411f  WPROS          0            0             0            0            0
watch-3 0x912c…f647  USDC        2139            0             0            0            0
watch-3 0x912c…f647  WPROS       2139            6    7,596.6233  11,612.6577   7,596.6233
watch-4 0xfd78…D002  USDC          50            2        49,000       49,000       49,000
watch-4 0xfd78…D002  WPROS          0            0             0            0            0
watch-5 0x9365…b470  USDC        1346            0             0            0            0
watch-5 0x9365…b470  WPROS       1346            3    6,118.8134            0    2,050.189
watch-6 0xFf70…04b2  USDC          49            2   50,133.0752  50,133.0752  50,133.0752
watch-6 0xFf70…04b2  WPROS          2            0             0            0            0
watch-7 0x1F35…c85C  USDC         660            0             0            0            0
watch-7 0x1F35…c85C  WPROS        660            0             0            0            0

totals: USDC: 10 significant, 936,384.34 USDC moved · WPROS: 6 significant, 19,209.281 WPROS moved
notify discord: 3 sent (message ids 1561302866998591588, 1561302870266216519, 1561302872497590365), 0 already sent earlier
```

(`[…]` marks reports left out of this excerpt; the proof file has all 16.)

## Limits (honest)

- Only ERC-20 `Transfer` events are watched: native PROS moves leave no log, so they are not seen.
- "Largest" ranks the moves that touch the watchlist in the scanned range, not all of the chain.
- `why it matters` is built from numbers (size against the threshold, the balance before and after, wallet or contract). "Usually means a
  deposit, swap or bridge" for a contract counterpart is a heuristic and says so; we do not know what the contract is.
- A pass-through (the address held 0 before and after the block) shows as an IN and an OUT of the same size, so `totals` counts it twice.
- The balance context is read at the move's block and the one before, so several moves in one block share one before/after pair.
- 15 tests in `test/whale.test.ts` (watchlist validation, pinned range, de-duplication, labels, exit / new position / pass-through, summary, CLI, compact view, Discord de-dup).
