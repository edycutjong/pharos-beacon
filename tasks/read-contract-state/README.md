# Read Contract State — Easy

**Task:** [Read Contract State](https://pharos-agent-arena.vercel.app/tasks/read-contract-state) (Chain MCP · Easy · 50 pts):
read a smart contract's state via Chain MCP.
**Run:** `npm run read-contract-state` (no key, no setup: it uses the hosted keyless Chain MCP on Pharos mainnet; `--proof` saves the result)
**Uses:** Chain MCP ✅ (`get_chain_info`, `get_block_number`, `eth_call`, `get_code`) · Docs MCP: not used · SkillEngine: only the token registry
(addresses and decimals in `src/lib/networks.ts`)

## Which contract

**USDC on Pharos mainnet, `0xC879C018dB60520F4355C26eD1a6D572cdAC1815`** — listed as "USDC (Circle Deployed)" in SkillEngine's token
registry. It is a token that real users hold, with an owner and a pause switch, so there is more to read than a bare ERC-20.
Pick another with `--contract 0x…` (any ERC-20) and label addresses with `--holder 0x…=Treasury`.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | Reads at least 3 different values from one contract via Chain MCP | 5 values from the one contract through `eth_call`: `name()`, `symbol()`, `decimals()`, `totalSupply()`, `balanceOf(holder)` (two holders), plus `owner()` and `paused()` | [`proof/0xc879…1815.json`](proof/0xc879c018db60520f4355c26ed1a6d572cdac1815.json) · [`index.ts`](index.ts) `readState` |
| 2 | Shows the contract address and the block number the data was read at | Printed in the first two lines; every read is pinned to that block, so the numbers describe one moment | [sample output below](#sample-output) · `proof` field `state.block` |
| 3 | Formats raw values for humans: token decimals applied, addresses labelled | `totalSupply` 40901150791646 → `40,901,150.791646 USDC` using the contract's own `decimals()` (the raw value stays beside it); every address gets a label: a token from the registry, the contract itself, your `=label`, or `wallet (no code)` / `contract (has code)` from `get_code` | [`index.ts`](index.ts) `labelsFor`, `formatState` · `test/read-contract-state.test.ts` |
| 4 | Includes a short README: which contract, how to run it, sample output | This file | — |

## Sample output

Run on 2026-10-17 (proof: [`proof/0xc879…1815.json`](proof/0xc879c018db60520f4355c26ed1a6d572cdac1815.json)):

```text
Contract  0xC879C018dB60520F4355C26eD1a6D572cdAC1815  (USDC)
Read at   block 20453298 on Pharos mainnet (chain 1672)

  name         USDC
  symbol       USDC
  decimals     6   (1 USDC = 1000000 base units)
  totalSupply  40,901,150.791646 USDC   (raw 40901150791646)
  balance      0 USDC   held by 0xC879C018dB60520F4355C26eD1a6D572cdAC1815  [USDC token contract (this contract)]
  balance      0.807275 USDC   held by 0x52C48d4213107b20bC583832b0d951FB9CA8F0B0  [WPROS token contract]
  owner        0x9F8Ea09770Dc38fc61f5a62031b3BE0526D54D92  [unlabelled wallet (no code)]
  paused       no

via https://mcp.pharos.xyz/mcp · up to 8 eth_call reads and get_code lookups pinned to block 20453298
```

The supply and balances change with the chain; the block number says which moment you are looking at. `owner()` and `paused()` are
optional views: if the contract reverts on them the report says "none" instead of failing, but any other error (network, rate limit)
stops the run. Pointing it at an address that is not a token fails with `returned no data: not a token contract`.

## Chain MCP tools

| Tool | Used for |
|---|---|
| `get_chain_info` | chain check at connect (must be 1672) |
| `get_block_number` | the block every read is pinned to (`--block N` reads an older one) |
| `eth_call` | `name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`, `owner`, `paused` |
| `get_code` | tells a wallet from a contract for addresses nobody labelled |

## Proof

| Run | Network · block | Result | File |
|---|---|---|---|
| default contract, 2026-10-17 | Pharos mainnet 1672 · block 20453298 | the output above | [`proof/0xc879…1815.json`](proof/0xc879c018db60520f4355c26ed1a6d572cdac1815.json) |

The task is read-only, so there is no transaction: the proof is the file above (it also records the endpoint, server version and
the command). It was produced from the working tree before this task's commit (`meta.git.dirty` is true).

## Tests

`npm test` runs 6 tests for this task (`test/read-contract-state.test.ts`) against a fake Chain MCP: values decoded with decimals applied,
all reads pinned to one block, labelling rules, a contract without `owner()`/`paused()`, a transport error not mistaken for "no owner",
a non-token address, and the report text.
