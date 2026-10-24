---
name: settlement-verdict
description: >
  Decide whether a Pharos transaction can be treated as paid, from live chain data. Use when the user asks "did this
  payment go through?", "is it safe to release the goods / credit the deposit?", "has 0x… settled yet?", "is this
  transaction final?", or wants the latest transaction on Pharos checked. The verdict is SETTLED, WAIT (with how many more
  blocks), FAILED (mined and reverted), MISMATCH (wrong recipient or too little value) or NOT_FOUND, and it names the rule
  that decided. The confirmations it asks for grow with the value moved. Reads Pharos mainnet (keyless) or Atlantic testnet
  through the Pharos Chain MCP; never sends anything.
version: 0.1.0
requires:
  anyBins:
  - node
  - npm
---

# Settlement Verdict

A Skill that makes the decision and the Chain MCP that supplies the facts, in one call. The skill never answers from
memory: the same hash is WAIT now and SETTLED a few blocks later, because the head block it compares with is read in
the same run.

## Setup (once)

Installing this skill alone copies only this file. If `package.json` with the `skill-chain-mcp-flow` script is not in the working folder, clone the repo first:

```bash
git clone https://github.com/edycutjong/pharos-beacon && cd pharos-beacon && npm ci
npm run setup:mcp        # only for Atlantic (testnet); mainnet (--network pharos) is keyless
```

## Workflow

One user request ("can I treat 0x… as paid?") is one command. Do not call the Chain MCP tools yourself first; the command
does it, in this order, and prints the verdict:

1. **Run it** (from the repo folder):
   ```bash
   npm run skill-chain-mcp-flow -- 0x<txhash> --network pharos
   npm run skill-chain-mcp-flow -- --latest   # first transaction of the newest block that has one (last 60 blocks): a demo convenience
   ```
   Add what the user told you to expect: `--expect-to 0x<recipient>` and `--min-value <coins>`. For "tell me when it is
   final" add `--follow 60` (asks again every 2 s, for about 60 s). `--network atlantic` for the testnet.
2. **Read the chain** (inside the command): `get_transaction` → `get_block_number` → `get_transaction_receipt` →
   `get_block` for the head and for head − 20, sent in parallel (the observed block time).
3. **Decide** (inside the command), first rule that matches:
   - no transaction for the hash → `NOT_FOUND`
   - no receipt yet → `WAIT` (not mined)
   - receipt status `0x0` → `FAILED`
   - recipient or value differs from what the user expects → `MISMATCH`
   - confirmations (head − block + 1) below the value tier's requirement → `WAIT n more blocks`
   - otherwise `SETTLED`.
   The tier defaults to 3 confirmations below 1 coin, 12 from 1 up to (not including) 100, 32 from 100 up; `--tiers 1=3,100=12,*=32` changes it and
   `--confirmations N` overrides it for this run.
4. **Report** the verdict line, the `rule` line and the depth line to the user in plain words. Exit code 0 = SETTLED,
   2 = WAIT (also bad flags), 1 = FAILED, MISMATCH, NOT_FOUND or an error.

## Guardrails

- Say WAIT as WAIT: never turn it into "paid" because the user is in a hurry. Lowering `--confirmations` below the tier
  needs the user's explicit instruction, and you say that you did it.
- A token (ERC-20) transfer has no native value, so it is treated as at least the middle tier. The skill does not read token
  amounts: for "paid in USDC" also check the amount in the explorer link it prints.
- Confirmations are counted on the node the Chain MCP talks to. They are not a finality proof from the chain's consensus.
- It reads only. Nothing is signed or sent.
