# Trend Watcher — Hard

**Task:** [Trend Watcher](https://pharos-agent-arena.vercel.app/tasks/trend-watcher) (SkillEngine · Hard · 200 pts): a skill with memory that persists
observations across runs and acts only once a multi-observation trend is confirmed.
**Run:** `npm run trend-watcher -- observe --metric balance|supply|basefee [--network atlantic|pharos] [--address 0x…] [--token 0x…] [--steps 3] [--direction fall|rise] [--block N] [--discord] [--proof name]`
and `-- history <same flags> [--last 12]`. Mainnet (`pharos`) is read through the hosted Chain MCP: keyless. `atlantic` needs the one-time `npm run setup:mcp` (no key to observe; the demo helper that moves a balance needs the testnet keys).
**Skill:** [`skills/trend-watcher/SKILL.md`](../../skills/trend-watcher/SKILL.md).
**Uses:** Chain MCP ✅ (`get_block_number`, then `get_balance` / `eth_call` totalSupply / `get_block` AT that block; the demo helper also uses `get_transaction_count`, `estimate_gas`, `get_block`, `get_gas_price`, `send_raw_transaction`, `get_transaction_receipt`) · SkillEngine: skill folder in the SkillEngine layout · Docs MCP: not used.

## How it works

Each run reads **one** observation: the head block number, then the metric **at that block**, so the pair is always consistent. It appends `{block, value, at}` to the
history file ([`state/history.json`](state/history.json), written atomically under a lock), then evaluates the rule on the **stored** history:
`--steps N` consecutive strictly lower values (`--direction fall`, default) or higher ones (`rise`). A flat step or a move the other way resets the streak.
`--steps` must be at least 2, so a trend always needs **at least 3 observations**. The action (a console line, or the Discord alert webhook with `--discord`)
runs on the observation where the streak first reaches N, once per trend.

Because the trigger points are recomputed from the stored history and each trigger is recorded as acted-on by its block, a restart cannot lose an observation
(the file is the memory), duplicate one (the same block is stored once, an older block is refused) or act twice.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Stores state between runs: persistent storage, not just in-memory." | The history is a JSON file written atomically (temp file, fsync, rename) under a lock. Every live run below is a **separate process** that loaded the previous runs' file | [`state/history.json`](state/history.json) · `proof/s2…s6` each show `history` growing by one |
| 2 | "Trend rule needs at least 3 observations to trigger and is configurable." | `--steps N` (≥ 2, so ≥ 3 observations; 1 is refused) and `--direction fall|rise`; 2 observations print "only 2 of the 3 observations a 2-move trend needs" and cannot trigger | `evaluate()` in [`src/trend/watch.ts`](../../src/trend/watch.ts) · `test/trend.test.ts` "needs at least 3 observations" · [`proof/s1-baseline.json`](proof/s1-baseline.json) (`too-few`) |
| 3 | "Handles restarts without losing or duplicating history." | Atomic write, dedupe by block, stale blocks refused. Tested with a real `kill -9` of a process that appends in a loop: the file always parses, blocks have no gap and no duplicate. Live: re-reading block 31570206 stored nothing and acted nothing | [`proof/s7-dedupe.json`](proof/s7-dedupe.json) (`"added": "duplicate"`, `"acted": []`) · `test/trend.test.ts` "survives kill -9" |
| 4 | "Shows the stored history and the exact moment the trend condition was met." | `history` prints every observation with block, value, move, streak, and a `◀ TREND MET` marker on the exact row (see below) | [`proof/history.log`](proof/history.log) · [`proof/s6-trend-met.json`](proof/s6-trend-met.json) (`evaluation.triggers`, `acted`) |
| 5 | "Demonstrates that a single spike does not trigger it." | Observation #2 was a fall, #3 a rise: a lone dip that reversed. The run on #3 reports streak 0 and acts on nothing; only three falls in a row (#4 to #6) fire | [`proof/s2-fall.json`](proof/s2-fall.json) · [`proof/s3-rise.json`](proof/s3-rise.json) (`triggers: []`) · `test/trend.test.ts` "a single spike never triggers" |

## The live run (Atlantic, real observations, a trend we made)

The metric is the **native PHRS balance of our test wallet 2** (`0x8D34…D91B`) on Atlantic. A balance does not fall by itself, so **we made the trend**: between
observations the helper [`scripts/trend-demo-move.ts`](../../scripts/trend-demo-move.ts) sent a real 0.001 PHRS transaction (a *fall*: wallet 2 pays wallet 1 plus gas;
a *rise*: wallet 1 pays wallet 2). Every observation is a real Chain MCP read of that balance, each run a separate process. Rule: 3 consecutive falls.

| # | Step | Move tx (Atlantic, `status success`) | Observation (block) | Run proof | Result |
|---|---|---|---|---|---|
| 1 | baseline | none | 31570137 | [`s1-baseline`](proof/s1-baseline.json) | too few observations |
| 2 | fall | [`0x797923…3230`](https://atlantic.pharosscan.xyz/tx/0x7979239a5f7106c1dbe47d11fca4e124da48ca463354ffe9817d87070bb43230) | 31570151 | [`s2-fall`](proof/s2-fall.json) | streak 1, no action |
| 3 | **rise** (the spike ends) | [`0x559897…d811d`](https://atlantic.pharosscan.xyz/tx/0x5598cf63bcf09fa05da2b0ebf7ed150a86fd4f1e25a792718a360c20566d811d) | 31570165 | [`s3-rise`](proof/s3-rise.json) | streak 0, **no action: a single dip did not trigger** |
| 4 | fall | [`0x82ee30…3828`](https://atlantic.pharosscan.xyz/tx/0x82ee30e4dc5b123a885a6bd158250294ef91a1c1c64c60523e4f4e4690233828) | 31570179 | [`s4-fall`](proof/s4-fall.json) | streak 1 |
| 5 | fall | [`0x98c422…b838`](https://atlantic.pharosscan.xyz/tx/0x98c42214e2e4932f3a84a20356ca02ae36e7cf1a620d0111e670c45c2ad7b838) | 31570193 | [`s5-fall`](proof/s5-fall.json) | streak 2 |
| 6 | fall | [`0x6745b4…e629`](https://atlantic.pharosscan.xyz/tx/0x6745b462ace9d6678aaf47b903ee3a68b438843c4f2ae127b00fa1580c35e629) | 31570206 | [`s6-trend-met`](proof/s6-trend-met.json) | streak 3: **TREND MET**, Discord alert sent (message id 1561311267103449119) |
| 7 | same block again (`--block 31570206`) | none | 31570206 | [`s7-dedupe`](proof/s7-dedupe.json) | not stored (duplicate), no second alert |

The move transactions are in the video's recorded runs (the explorer links above); the run proofs record the observations, the history and the evaluation. (Two stray test
transactions before the baseline, a rise `0x6461e6ef…d5c4` and a fall, are earlier than observation #1 and not part of the history.)

```text
history: native balance of 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B on atlantic · 6 observations, showing 6 · rule: 3 consecutive falls
  #1   block 31570137  15.029200205 PHRS          start streak 0
  #2   block 31570151  15.028179205 PHRS          fall  streak 1
  #3   block 31570165  15.029179205 PHRS          rise  streak 0
  #4   block 31570179  15.028158205 PHRS          fall  streak 1
  #5   block 31570193  15.027137205 PHRS          fall  streak 2
  #6   block 31570206  15.026116205 PHRS          fall  streak 3   ◀ TREND MET: 3 consecutive falls
trend: █▅▇▅▃▁   (triggered, current streak 3/3)
```

## Beyond the requirements: sparkline and slope

`history` draws a sparkline of the stored values (`█▅▇▅▃▁` above), and the moment a trend is met the alert carries the **slope** of the streak, per observation and per
block. The alert for observation #6 is rebuilt below from the stored history with the same function that sent it (the proof records the Discord message id, not its body):

```text
TREND MET: native balance of 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B on atlantic — 3 consecutive falls at observation #6 (block 31570206, 2026-10-18T09:33:33.372Z). █▅▃▁ slope -0.001021 PHRS per observation, -0.00007470731707317 PHRS per block (-0.003063 PHRS over 3 observations, 41 blocks)
```

## A real metric that does not trend (said plainly)

Mainnet base fee, three observations through the hosted Chain MCP ([`state/mainnet-basefee.json`](state/mainnet-basefee.json), proofs
`mainnet-basefee-1..3`): 10 gwei each time, so the streak stays 0 and nothing fires. A flat real metric never triggers; that is the point.
`--metric supply --token <ERC-20>` watches a token's `totalSupply()` the same way.

## Limits

- The Atlantic trend is **made by us** with two of our own wallets; real chain metrics seldom fall three times in a row inside a session.
- One metric per history file (another is refused). History is capped at 1,000 observations.
- The action is a console line or one Discord message. If a crash lands between the message and its record, the next run repeats that one alert rather than losing it.
- A run observes once; scheduling (cron, a loop) is yours.

## Tests

`npm test` — 18 tests in [`test/trend.test.ts`](../../test/trend.test.ts): the rule (minimum steps, flat resets, single spike up or down, re-trigger after a reset, rise), de-dupe and stale
blocks, persistence across runs, a failed action retried and never repeated, wrong-metric / corrupt / out-of-order files refused, a `kill -9` mid-write loop, the three metrics, sparkline, slope and the history marker.
