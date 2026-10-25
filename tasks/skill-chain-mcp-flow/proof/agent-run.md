# Agent run: Settlement Verdict installed with `npx skills add` and run by Claude Code (Sonnet), 2026-10-24

## 1. Install (from a fresh clone of branch task/skill-chain-mcp-flow, local path as the source)

(The output below is from the install re-run after the agent run to capture it, hence "overwrites"; the first install, before the run, printed the same without that line.)

$ npx -y skills add <clone> --skill settlement-verdict -a claude-code -y

│
●   claude-code_2-1-291_agent  Agent detected — installing non-interactively
│
◇  Source: <clone>
│
◇  Local path validated
│
◇  Found 7 skills
│
●  Selected 1 skill: settlement-verdict
│
◇  Installation Summary ────────────────╮
│                                       │
│  ./.agents/skills/settlement-verdict  │
│    copy → Claude Code                 │
│    overwrites: Claude Code            │
│                                       │
├───────────────────────────────────────╯
│
◇  Installation complete
│
◇  Installed 1 skill ───────────────────────╮
│                                           │
│  ✓ settlement-verdict (copied)            │
│    → ./.claude/skills/settlement-verdict  │
│                                           │
├───────────────────────────────────────────╯
│
└  Done!  Review skills before use; they run with full agent permissions.

## 2. The user's request (one prompt, nothing else given)

I am about to release goods against the newest transaction on Pharos mainnet. Can I treat it as paid? Give me the verdict and the rule behind it, in two lines.

$ claude -p "<request>" --model sonnet --permission-mode dontAsk --allowedTools "Skill" "Bash(npm run skill-chain-mcp-flow:*)"

## 3. What the agent did, in order

1. tool call `Skill`: {"skill": "settlement-verdict"}

2. tool call `Bash`: {"command": "npm run skill-chain-mcp-flow -- --latest --network pharos 2>&1 | tail -30", "description": "Run settlement verdict on latest Pharos mainnet tx"}

   result:
```
> beacon@0.2.0 skill-chain-mcp-flow
> tsx tasks/skill-chain-mcp-flow/index.ts --latest --network pharos

latest transaction: 0x2cc1072412e5da0d88cdff086a3d1686527b1a9162f2cce5566f04c530670c64 (block 21079757)
VERDICT WAIT
rule    mined with status 0x1 but 2 confirmation(s) is below the 12 this tier needs
tx      0x2cc1072412e5da0d88cdff086a3d1686527b1a9162f2cce5566f04c530670c64
from    0x5c10af7337f123f5e952f9665febf35c5346410f  →  to 0x52acdeb49056518578c7af788ae2c367132e2db5
value   0 native, 1 token transfer(s) in the receipt
mined   block 21079757, head 21079758, status success, gas used 53631
depth   2 confirmations of 12 required (1 token transfer(s) and no native value, so the worth is unknown → tier 2 of 3 (below 100))
wait    10 more block(s), about 8.5 s at the observed 0.85 s per block
network pharos (chain 1672)
explorer https://www.pharosscan.xyz/tx/0x2cc1072412e5da0d88cdff086a3d1686527b1a9162f2cce5566f04c530670c64
```

## 4. The agent's answer

**Verdict: WAIT.** Don't release the goods yet. The latest transaction (`0x2cc10724…0c64`) is mined and succeeded, but it has only 2 confirmations.

**Rule:** it is a token transfer with no native value, so it falls in the middle tier, which needs 12 confirmations. That is 10 more blocks, about 8.5 s at the observed 0.85 s per block.

Two caveats before you release anything:
- I ran this on the newest transaction on the chain, with no expected recipient or amount. I haven't checked that it's your payment. If you give me your recipient and amount, I can rerun it with `--expect-to` and `--min-value`.
- The skill doesn't read token amounts, so check the amount on the explorer: https://www.pharosscan.xyz/tx/0x2cc1072412e5da0d88cdff086a3d1686527b1a9162f2cce5566f04c530670c64

(total cost reported by the CLI: $0.140; the skill's SKILL.md was loaded by the agent through the Skill tool in step 1.)

## 5. Second run: a named mainnet transaction

(Installed again from the clone at the commit before the round-1 wording fixes to SKILL.md; the commands and rules are the same.)

Prompt: A customer says they paid me with transaction 0x25ab34a78eca00c179f7ac76c860dc93ffaf4d67292d3f048d88cc53902accd0 on Pharos mainnet. Can I treat it as paid? Verdict and rule, in two lines.

1. tool call `Skill`: {"skill": "settlement-verdict", "args": "0x25ab34a78eca00c179f7ac76c860dc93ffaf4d67292d3f048d88cc53902accd0 on Pharos mainnet"}

2. tool call `Bash`: {"command": "npm run skill-chain-mcp-flow -- 0x25ab34a78eca00c179f7ac76c860dc93ffaf4d67292d3f048d88cc53902accd0 --network pharos 2>&1 | tail -30", "description": "Run settlement verdict for the transaction"}

   result:
```
> beacon@0.2.0 skill-chain-mcp-flow
> tsx tasks/skill-chain-mcp-flow/index.ts 0x25ab34a78eca00c179f7ac76c860dc93ffaf4d67292d3f048d88cc53902accd0 --network pharos

VERDICT SETTLED
rule    mined with status 0x1 and 1053 confirmations, at least the 3 this tier needs
tx      0x25ab34a78eca00c179f7ac76c860dc93ffaf4d67292d3f048d88cc53902accd0
from    0xda12bd94cded64c0927272674df0ed4c0ec1f88c  →  to 0x52acdeb49056518578c7af788ae2c367132e2db5
value   0 native
mined   block 21079587, head 21080639, status success, gas used 46040
depth   1053 confirmations of 3 required (0 native value → tier 1 of 3 (below 1))
network pharos (chain 1672)
explorer https://www.pharosscan.xyz/tx/0x25ab34a78eca00c179f7ac76c860dc93ffaf4d67292d3f048d88cc53902accd0
```

Answer:

**Verdict:** The transaction is mined, succeeded, and has 1053 confirmations against the 3 required. It has not been checked against who or how much you were owed, so I can't call it paid yet.

**Rule:** The check only passed on status and depth. It moved 0 native coins (probably a token transfer, gas used 46040), and I ran it without `--expect-to` or `--min-value`. Before you treat it as paid, confirm the recipient is your address and the token amount is right on [the explorer](https://www.pharosscan.xyz/tx/0x25ab34a78eca00c179f7ac76c860dc93ffaf4d67292d3f048d88cc53902accd0). The skill doesn't read token amounts. The `to` address is `0x52ac…2db5`.
