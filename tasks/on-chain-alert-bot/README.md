# On-Chain Alert Bot — Easy

**Task:** [On-Chain Alert Bot](https://pharos-agent-arena.vercel.app/tasks/on-chain-alert-bot) (Trading / Monitoring · Easy · 50 pts):
watches for a price threshold, large transfer, or contract call and notifies.
**Run:** `npm run on-chain-alert-bot -- --rules tasks/on-chain-alert-bot/rules.atlantic.json` (Discord webhook from `DISCORD_WEBHOOK_URL` or `~/.config/discord/webhook-alerts`; `--notify console` prints instead)
**Try it without a key or a webhook (mainnet USDC ≥ 100, replays the last 300 blocks):** `npm run on-chain-alert-bot -- --rules tasks/on-chain-alert-bot/rules.pharos.json --notify console --from-block head-300 --max-polls 1`
**Uses:** Chain MCP ✅ (`get_chain_info`, `get_block_number`, `get_logs`, `eth_call`) · Discord incoming webhook · Docs MCP: not used

## Conditions (a JSON rules file)

```json
{ "network": "atlantic", "rules": [
  { "id": "big-wphrs-transfer", "kind": "large-transfer", "token": "0x8388…9471", "minAmount": "0.005" },
  { "id": "wphrs-deposit", "kind": "contract-event", "contract": "0x8388…9471", "event": "Deposit" } ] }
```

- `large-transfer`: a `Transfer` of an ERC-20 for at least `minAmount` (token units, decimals applied).
- `contract-event`: any occurrence of a named event on a contract (`Deposit`, or a full signature), optionally only where `from`/`to` equals `involving`.
- Not covered: a price feed (no price source is wired in) and a plain function call that emits no event; a call that does log an event is the same `contract-event` rule.

Flags: `--rules` (required), `--notify discord|console`, `--from-block head|N|head-N`, `--poll-ms`, `--max-polls`, `--until-alerts N`, `--state`, `--sent`, `--log`, `--verbose`, `--proof label`.
State (cursor and sent-set) defaults to the temp dir, so a try-out never writes into the repo.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | At least one configurable alert condition | two kinds of rule in a JSON file (above), each with its own id, token/contract and threshold; bad rules fail with a clear message | `tasks/on-chain-alert-bot/rules.ts` · `rules.atlantic.json` · `test/alert-bot.test.ts` "rules" |
| 2 | Delivers alerts to a real channel | a Discord channel through an incoming webhook; the reply (`?wait=true`) returns the message id, and both messages below were fetched back from Discord afterwards (HTTP 200) | message ids [`1561176862451834920`, `1561176876892954723`] in [`proof/live-run.json`](proof/live-run.json) |
| 3 | Each alert includes what happened, the value, and a tx or explorer link | `What:` (event, contract, from → to), `Value:` (decimals applied), `Block:` and the `Tx:` explorer link | the alert text in the output below · `alertText` in `rules.ts` |
| 4 | No repeat spam for the same event | one alert per rule per `txHash:logIndex`, saved to a sent-set file; the poller's own cursor also never rescans; a failed delivery is retried (the one crash window is under Limits) | [restart](proof/restart-run.log): 3 polls, 0 alerts · [cursor lost](proof/rescan-run.log): the same 2 events seen again, `2 already sent earlier (not repeated)` · `test/alert-bot.test.ts` |

## Live run (Atlantic testnet → Discord)

The bot was started, then `npm run emit-events -- --execute --wrap 0.0102 --transfer 0.01 --small 0.0001` sent three real transactions:
a wrap ([`0x9490…f046`](https://atlantic.pharosscan.xyz/tx/0x9490dbf1e6f8e1e15e48dc667505114c4e607810d4cce72fa4eaeddfd430f046), fires the Deposit rule),
a 0.01 WPHRS transfer ([`0x9ce6…996b`](https://atlantic.pharosscan.xyz/tx/0x9ce6f668093284a0fee10cc9ca5980fe1719416e7e660e2fbc595c2eedca996b), fires the large-transfer rule)
and a 0.0001 WPHRS transfer ([`0xaf94…ae93`](https://atlantic.pharosscan.xyz/tx/0xaf94b342a2f0ef6ef94b70949a541148a37781058df77159980f94bb61adae93), below 0.005: no alert, as configured).
Proof: [`proof/live-run.json`](proof/live-run.json) (`dirty: false`), output [`proof/live-run.log`](proof/live-run.log), the three transactions in [`proof/emit-events.log`](proof/emit-events.log).
The Atlantic runs need the local Atlantic Chain MCP (`npm run setup:mcp` once); the mainnet command above does not.

```text
alert bot on atlantic (chain 688689) via local stdio PharosNetwork/pharos-mcp@9a3750c · head 31555664 · notify discord · 2 rules
  rule big-wphrs-transfer: large-transfer on 0x838800b758277CC111B2d48Ab01e5E164f8E9471 (>= 0.005 WPHRS)
  rule wphrs-deposit: contract-event on 0x838800b758277CC111B2d48Ab01e5E164f8E9471 (Deposit(address,uint256))
ALERT wphrs-deposit → discord message 1561176862451834920
  | 🔔 **Deposit event** on Pharos Atlantic testnet (rule `wphrs-deposit`)
  | **What:** Deposit on 0x838800b758277CC111B2d48Ab01e5E164f8E9471, to 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  | **Value:** 0.0102 WPHRS
  | **Block:** 31555669 · **Tx:** https://atlantic.pharosscan.xyz/tx/0x9490dbf1e6f8e1e15e48dc667505114c4e607810d4cce72fa4eaeddfd430f046
ALERT big-wphrs-transfer → discord message 1561176876892954723
  | 🔔 **Large transfer** on Pharos Atlantic testnet (rule `big-wphrs-transfer`: at least 0.005 WPHRS)
  | **What:** Transfer on 0x838800b758277CC111B2d48Ab01e5E164f8E9471, 0x317bca01Bb101C0F1E86C21576a4e14D92B02975 → 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
  | **Value:** 0.01 WPHRS
  | **Block:** 31555672 · **Tx:** https://atlantic.pharosscan.xyz/tx/0x9ce6f668093284a0fee10cc9ca5980fe1719416e7e660e2fbc595c2eedca996b
stopped after 32 polls: 2 alerts sent, 0 already sent earlier (not repeated); next block to scan 31555721
```

## Restart and lost cursor: no repeats

Same state files, started again: [`proof/restart-run.log`](proof/restart-run.log) ends `0 alerts sent`. With the cursor deleted and
`--from-block 31555660` (the events are in range again) but the sent-set kept ([`proof/rescan-run.json`](proof/rescan-run.json)):

```text
alert bot on atlantic (chain 688689) via local stdio PharosNetwork/pharos-mcp@9a3750c · head 31555745 · notify discord · 2 rules
  rule big-wphrs-transfer: large-transfer on 0x838800b758277CC111B2d48Ab01e5E164f8E9471 (>= 0.005 WPHRS)
  rule wphrs-deposit: contract-event on 0x838800b758277CC111B2d48Ab01e5E164f8E9471 (Deposit(address,uint256))
stopped after 1 polls: 0 alerts sent, 2 already sent earlier (not repeated); next block to scan 31555746
```

## Tests

`npm test`: 9 tests in `test/watch.test.ts` (shared poller) and 11 for this task in `test/alert-bot.test.ts` (rules and thresholds, alert text, Discord retries on 429
and the webhook never appearing in an error, one alert per event across restarts, a failed delivery retried, `--until-alerts`). `npm run typecheck` is clean.

## Limits, stated plainly

- The webhook URL is a credential: read at run time, validated, never printed, never in a proof or an error message.
- Delivery is at-least-once in one narrow case: a crash between Discord accepting a message and the sent-set being written could repeat that one alert after a restart.
- The alert channel is a private Discord server; the proof carries the message ids and text, not a screenshot.
- Polling, not push: an alert arrives one poll interval after its block.
