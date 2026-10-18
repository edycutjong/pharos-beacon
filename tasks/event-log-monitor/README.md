# Event/Log Monitor — Easy

**Task:** [Event/Log Monitor](https://pharos-agent-arena.vercel.app/tasks/event-log-monitor) (Chain MCP · Easy · 50 pts):
build a small monitor that watches for a specific on-chain event/log via Chain MCP.
**Run (keyless, mainnet, replays the last 300 blocks):** `npm run event-log-monitor -- --network pharos --contract 0xc879c018db60520f4355c26ed1a6d572cdac1815 --event Transfer --from-block head-300 --max-polls 2`
**Run (live, Atlantic testnet, waits for new events):** `npm run event-log-monitor -- --contract 0x838800b758277CC111B2d48Ab01e5E164f8E9471 --event Transfer`
**Uses:** Chain MCP ✅ (`get_chain_info`, `get_block_number`, `get_logs`, `eth_call` for `decimals()`/`symbol()`) · Docs MCP: not used · SkillEngine: addresses from the token registry

Flags: `--contract` (required), `--event` (`Transfer`, `Approval`, `Deposit`, `Withdrawal`, or a full signature such as
`"Swap(address indexed sender, uint256 amount0In, uint256 amount1Out, address indexed to)"`), `--network atlantic|pharos` (default atlantic),
`--from-block head|N|head-N` (default `head`: only events from now on), `--poll-ms` (default 3000), `--max-polls N` / `--until-events N` (stop; otherwise it runs until Ctrl-C),
`--state f` (cursor file; default in the temp dir, so a try-out never writes into the repo), `--log f`, `--verbose`, `--proof label`.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | Uses Chain MCP log queries filtered by contract address and event signature | every poll is one `get_logs` call per ≤1000-block window with `address: <contract>` and `topics: [topic0]`, where `topic0` is the hash of the event signature (`parseEvent` in `src/watch/decode.ts`) | `src/watch/watch.ts` `pollOnce` · the proof's `topic0` field · test "watch" |
| 2 | Runs continuously and reports only new events, with no duplicates | a poll loop (`--poll-ms`) that never stops by itself; a block cursor plus a handled-set keyed by `txHash:logIndex` is saved after every event, so a restart resumes at the cursor and an overlapping scan cannot print an event twice | [live run](proof/live-run.log): 19 polls, 2 events, each once · [restart](proof/restart-run.log): 4 polls, 0 new · `test/watch.test.ts` (overlapping polls, restart, crash after handling, two events in one block) |
| 3 | Decodes each event into readable fields (from, to, amount, tx hash, block) | `from`, `to`, `amount` (decimals applied, `0.01 WPHRS`), `tx` with its explorer link, `block` and `log #`; other parameters are printed by name | [live run](proof/live-run.log) · `test/alert-bot.test.ts` "formats from / to / amount / tx / block" |
| 4 | Demonstrated catching at least one live or test event | monitor started first, then real WPHRS transfers were sent on Atlantic (`npm run emit-events`); it caught both | tx [`0xee5e…5e0b`](https://atlantic.pharosscan.xyz/tx/0xee5ef39c357f34e39a4c8902dd59b51bcc0a116d6a686bbffa9501c0dd525e0b) (0.01 WPHRS) and [`0x9bd3…b33b2`](https://atlantic.pharosscan.xyz/tx/0x9bd36d74638d4ad84bbcfc1fae60af2c7666562e76f8e62f3447d905b83b33b2) (0.0001 WPHRS) |

## Live run (Atlantic testnet)

The monitor was started first (head 31555620); then `npm run emit-events -- --execute …` wrapped PHRS into WPHRS (a `Deposit`
event, which this monitor ignores because it asked for `Transfer`) and sent WPHRS to the second test wallet. The senders' output is in
[`proof/emit-events.log`](proof/emit-events.log): in the first run the third step (the 0.0001 transfer) failed at gas estimation because the wallet held no WPHRS
after the 0.01 transfer and nothing was broadcast, so a second run wrapped 0.0002 PHRS and sent that transfer. Proof:
[`proof/live-run.json`](proof/live-run.json) (`dirty: false`), full output [`proof/live-run.log`](proof/live-run.log).

```text
watching Transfer(address,address,uint256) on 0x838800b758277CC111B2d48Ab01e5E164f8E9471 (WPHRS, 18 decimals)
atlantic (chain 688689) via local stdio PharosNetwork/pharos-mcp@9a3750c · head 31555620 · poll 2500 ms · state /tmp/p91/mon.json
Transfer  block 31555629  log #0
  from    0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  to      0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
  amount  0.01 WPHRS
  tx      0xee5ef39c357f34e39a4c8902dd59b51bcc0a116d6a686bbffa9501c0dd525e0b
          https://atlantic.pharosscan.xyz/tx/0xee5ef39c357f34e39a4c8902dd59b51bcc0a116d6a686bbffa9501c0dd525e0b
Transfer  block 31555647  log #0
  from    0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  to      0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
  amount  0.0001 WPHRS
  tx      0x9bd36d74638d4ad84bbcfc1fae60af2c7666562e76f8e62f3447d905b83b33b2
          https://atlantic.pharosscan.xyz/tx/0x9bd36d74638d4ad84bbcfc1fae60af2c7666562e76f8e62f3447d905b83b33b2
stopped after 19 polls: 2 new Transfer events; next block to scan 31555651
```

## Restart: nothing is printed twice

Same state file, started again after those events (a restart resumes at the saved cursor): [`proof/restart-run.json`](proof/restart-run.json).

```text
watching Transfer(address,address,uint256) on 0x838800b758277CC111B2d48Ab01e5E164f8E9471 (WPHRS, 18 decimals)
atlantic (chain 688689) via local stdio PharosNetwork/pharos-mcp@9a3750c · head 31555659 · poll 2500 ms · state /tmp/p91/mon.json
stopped after 4 polls: 0 new Transfer events; next block to scan 31555662
```

## Make your own event

`npm run emit-events -- --execute` (run `npm run setup:mcp` once for the local Atlantic Chain MCP; needs `PRIVATE_KEY` and `PRIVATE_KEY_2` in `~/.config/pharos/testnet.env`; Atlantic testnet only) wraps 0.01 PHRS and sends
0.01 WPHRS to the second wallet; a dry run without `--execute` sends nothing. Run it in a second terminal while the monitor waits.

## Tests

`npm test`: 9 tests in `test/watch.test.ts` (cursor, de-duplication, resume, crash window, decoding) and 4 for this task in `test/alert-bot.test.ts`
(`--from-block` forms, a live event caught once and a restart that prints nothing, the printed fields, flag errors). `npm run typecheck` is clean.

## Limits, stated plainly

- Polling, not a subscription: an event shows up one poll after its block (the default interval is 3 s).
- A block is treated as final once it is the head (`confirmations` is 0 here); a chain reorganisation deeper than one poll could show an event that is later dropped.
- Anything the node's `get_logs` does not return (a pruned range) cannot be seen.
- The live proof used a token (WPHRS) on the testnet because that is where it is free to make events; the mainnet command above shows the same monitor on real traffic.
