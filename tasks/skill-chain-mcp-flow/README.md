# Skill + Chain MCP Flow — Medium

**Task:** [Skill + Chain MCP Flow](https://pharos-agent-arena.vercel.app/tasks/skill-chain-mcp-flow) (Composition · Medium · 100 pts): compose a SkillEngine skill with a Chain MCP call into one working agent flow.
**The flow we picked:** *"Can I treat this transaction as paid?"* The skill [`settlement-verdict`](../../skills/settlement-verdict/SKILL.md) decides SETTLED / WAIT / FAILED / MISMATCH / NOT_FOUND, and every on-chain fact it decides on (transaction, receipt, head block, block times) comes from the Pharos Chain MCP in the same run. The head block decides WAIT versus SETTLED; NOT_FOUND, FAILED and MISMATCH come from the transaction and receipt.
**Run** (keyless, read-only, Pharos mainnet, Node ≥ 20): `npm ci && npm run skill-chain-mcp-flow -- 0x25ab34a78eca00c179f7ac76c860dc93ffaf4d67292d3f048d88cc53902accd0` (a mainnet transaction: SETTLED), `-- --latest` (whatever is newest: often WAIT), or `npm run skill-chain-mcp-flow -- 0x<txhash> [--expect-to 0x… --min-value 0.5 --follow 60]`. `--network atlantic` needs the one-time `npm run setup:mcp`.
**Install as a skill:** `npx skills add https://github.com/edycutjong/pharos-beacon --skill settlement-verdict`.

## The flow: what calls what, in what order

```text
user request  "can I treat 0x… as paid?"
   │
   ▼
agent loads the Skill  settlement-verdict (SKILL.md: the question, the rules, the guardrails)
   │  runs ONE command: npm run skill-chain-mcp-flow -- <hash>
   ▼
 1 Chain MCP  get_transaction          → from, to, value
 2 Chain MCP  get_block_number         → the head right now   (no transaction at step 1 → NOT_FOUND, stop)
 3 Chain MCP  get_transaction_receipt  → status, block, logs    (no receipt → WAIT: not mined)
   │   status 0x0 → FAILED, stop
   │   --expect-to / --min-value differ → MISMATCH, stop
 4 Chain MCP  get_block (head)         ┐ sent in parallel, so their order in `flow` varies: the observed
 5 Chain MCP  get_block (head − 20)    ┘ seconds per block over the last 20 blocks (to say how long a WAIT lasts)
   ▼
Skill rule   confirmations = head − block + 1  vs  the value tier's requirement (3 / 12 / 32)
   │  below → WAIT n more blocks (about s seconds)     at or above → SETTLED
   ▼
verdict + the rule that decided + depth    (exit code 0 SETTLED · 2 WAIT · 1 FAILED, MISMATCH, NOT_FOUND or a runtime error; bad flags also exit 2 and print the usage line)
```

The order is the order of the tool calls in every proof (`flow` in each `proof/*.json`, with the arguments and the milliseconds each call took). `--follow` repeats the reads every 2 s until the verdict is no longer WAIT or the `--follow` seconds run out (a not-yet-mined WAIT repeats steps 1–3 only). `--latest` first adds `get_block_number` and up to 60 `get_block` calls to find a transaction.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "The Skill's output depends on live data fetched via Chain MCP in the same flow." | The verdict is a function of the head block read in the same run: the same hash is WAIT, then SETTLED a few blocks later, and the required depth comes from the transaction's value, also read in that run. | [`atlantic-wait`](proof/atlantic-wait.json) (3 of 12 confirmations, WAIT) and [`atlantic-follow-settled`](proof/atlantic-follow-settled.json) (the same hash, 9 → 11 → 12 confirmations, then SETTLED) |
| 2 | "The flow runs end to end from a single user request." | One prompt to an agent, nothing else supplied; the agent loaded the skill and ran one command. The skill was installed with `npx skills add` from a fresh local clone (the install output in that file was re-captured after the run). | [`proof/agent-run.md`](proof/agent-run.md) |
| 3 | "A diagram or short write-up of the flow: what calls what, and in what order." | The diagram above; the recorded order of the real calls is `flow` in every proof. | this file; [`proof/mainnet-settled.json`](proof/mainnet-settled.json) |
| 4 | "A demo run showing real data moving through both tools." | Real mainnet transaction and real Atlantic transactions, five outcomes, each run a separate process. | the table below |

## The runs

All runs read through the Chain MCP: mainnet through the hosted `https://mcp.pharos.xyz/mcp`, Atlantic through the local stdio server. The transactions on Atlantic were sent by hand from our test wallets with `cast send` (a 1 PHRS transfer to our second wallet; a withdraw of 1,000 WPHRS that the wallet cannot cover, with a gas limit forced so that it is mined and reverts); the mainnet one is somebody else's.

| Outcome | Transaction | Command | Proof |
|---|---|---|---|
| SETTLED (mainnet, third party) | [`0x25ab34…ccd0`](https://www.pharosscan.xyz/tx/0x25ab34a78eca00c179f7ac76c860dc93ffaf4d67292d3f048d88cc53902accd0): 101 confirmations, 3 required | `npm run skill-chain-mcp-flow -- 0x25ab34a7…ccd0` | [`mainnet-settled`](proof/mainnet-settled.json) · [log](proof/mainnet-settled.log) |
| MISMATCH (mainnet) | the same transaction, caller expects it to have gone to `0x…dEaD` | `… --expect-to 0x000000000000000000000000000000000000dEaD` | [`mainnet-mismatch`](proof/mainnet-mismatch.json) · [log](proof/mainnet-mismatch.log) |
| NOT_FOUND (mainnet) | `0xdede…dede`, a made-up hash the node has no transaction for | `npm run skill-chain-mcp-flow -- 0xdede…dede` | [`mainnet-not-found`](proof/mainnet-not-found.json) · [log](proof/mainnet-not-found.log) |
| WAIT (Atlantic) | [`0x62dd81…534b`](https://atlantic.pharosscan.xyz/tx/0x62dd81a1e9e79ba5e96e858fa62f68d391ebebbc935b9405647c8c8bbde5534b): 1 PHRS, so tier 2 needs 12 confirmations; 3 reached | `… 0x62dd81a1… --network atlantic` | [`atlantic-wait`](proof/atlantic-wait.json) · [log](proof/atlantic-wait.log) |
| WAIT → SETTLED (Atlantic) | the same transaction, asked again until done | `… --network atlantic --follow 90` | [`atlantic-follow-settled`](proof/atlantic-follow-settled.json) · [log](proof/atlantic-follow-settled.log) |
| FAILED (Atlantic) | [`0x5ab577…0b1d`](https://atlantic.pharosscan.xyz/tx/0x5ab577af2e458a5f631e615c44dd111544333324408a10dd7fac299559a70b1d): mined with status 0x0 | `… 0x5ab577af… --network atlantic` | [`atlantic-failed`](proof/atlantic-failed.json) · [log](proof/atlantic-failed.log) |

Output of the follow run (from [its log](proof/atlantic-follow-settled.log), minus the explorer and proof lines):

```text
WAIT  9/12 confirmations at head 31806034; asking again in 2 s
WAIT  11/12 confirmations at head 31806036; asking again in 2 s
WAIT  11/12 confirmations at head 31806036; asking again in 2 s
VERDICT SETTLED
rule    mined with status 0x1 and 12 confirmations, at least the 12 this tier needs
tx      0x62dd81a1e9e79ba5e96e858fa62f68d391ebebbc935b9405647c8c8bbde5534b
from    0x317bca01bb101c0f1e86c21576a4e14d92b02975  →  to 0x8d347c72431ed6e033d5f43e56c0987e97f5d91b
value   1 native
mined   block 31806026, head 31806037, status success, gas used 21000
depth   12 confirmations of 12 required (1 native value → tier 2 of 3 (below 100))
network atlantic (chain 688689)
```

## Installed and run by an agent

[`proof/agent-run.md`](proof/agent-run.md) records it: `npx skills add <fresh clone> --skill settlement-verdict -a claude-code` installs the skill, then `claude -p` (Sonnet) gets one short prompt ("I am about to release goods against the newest transaction on Pharos mainnet. Can I treat it as paid? Give me the verdict and the rule behind it, in two lines."). The agent calls the Skill tool, runs `npm run skill-chain-mcp-flow -- --latest --network pharos`, and answers WAIT with the rule. It ran against whatever was newest at that moment, so a re-run gives another transaction and maybe another verdict. A second run in the same file (section 5) names the mainnet transaction `0x25ab34…ccd0`: the agent reports status and depth (1053 confirmations against 3 required) and says it cannot call it paid without the expected recipient and amount, which is the skill's guardrail.

## Limits

- Native value only. A token transfer with no native value is treated as at least the middle tier because its worth is unknown; the skill does not read token amounts (use `--expect-to`, and the explorer link it prints, for the amount).
- Confirmations are counted on the node the Chain MCP talks to; they are not consensus finality. The tiers (3 / 12 / 32) are our defaults, changeable with `--tiers` or `--confirmations`.
- `--latest` takes the first transaction of the newest block in the last 60 blocks that has one, so it is a demo convenience, not a payment lookup.
- The seconds in a WAIT use the last 20 blocks' average and can be off by a block.

## Tests

23 tests in [`test/skill-chain-mcp-flow.test.ts`](../../test/skill-chain-mcp-flow.test.ts): the five verdicts, the tier boundaries (exactly 1 coin is tier 2), mismatch before depth, a failed transaction that is never MISMATCH, token transfers, block-time edge cases, the CLI's bad-input errors and exit codes, `--follow` polling, and the order of the recorded calls.
