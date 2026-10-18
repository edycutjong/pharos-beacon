# Doc-Grounded Builder Agent — Hard

**Task:** [Doc-Grounded Builder Agent](https://pharos-agent-arena.vercel.app/tasks/doc-grounded-builder-agent) (Cross-tool / Advanced · Hard · 200 pts):
answers "how do I do X on Pharos?" from the Developer Docs MCP, then does X with the Chain MCP and verifies it on chain.
**Run:** `npm run doc-grounded-builder-agent -- ["request" …] [--address 0x…] [--to 0x…] [--amount PHRS] [--token 0x…] [--tx 0x…] [--execute] [--json] [--proof]`
(no request = the six-request demo; Atlantic needs the one-time `npm run setup:mcp`, keyless; mainnet reads use the hosted Chain MCP)
**Uses:** Docs MCP ✅ (`askQuestion`, `getPage`, `searchDocumentation`) · Chain MCP ✅ (`get_block_number`, `get_balance`, `get_transaction_count`, `estimate_gas`, `get_block`, `get_gas_price`, `eth_call`, `send_raw_transaction`, `get_transaction_receipt`) · SkillEngine: not used

Try it (nothing is signed without `--execute`):
`npm run doc-grounded-builder-agent -- "send PHRS on Atlantic" --to 0x000000000000000000000000000000000000dEaD --amount 0.001 --address <your Atlantic address>`

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | Uses Docs MCP to plan, with sources cited, before acting | `plan()` runs first: `askQuestion`, then each cited page is fetched with `getPage` and must contain the method (`eth_getBalance`, `cast send` + `--value`, `totalSupply`, `eth_getTransactionReceipt`); if none does, `searchDocumentation` is tried. The docs sentences and source URLs are printed under "PLAN" before any chain call | `agent.ts` `plan` · output block below · [`proof/executed.json`](proof/executed.json) |
| 2 | Executes with Chain MCP and/or SkillEngine; anything that moves funds is prepared for signature | every chain step is a Chain MCP tool call. A send prints the unsigned transaction (nonce, gas, fees from the MCP) and stops, "PREPARED"; only `--execute` signs it locally and broadcasts it, on Atlantic. Mainnet is read-only: `--execute` never opens a broadcasting client for it (test) | [`proof/prepared.json`](proof/prepared.json) (nothing sent) · [`proof/executed.json`](proof/executed.json) |
| 3 | Verifies the outcome on chain and reports success or failure against the plan | each result states `expected:` (from the plan) and `observed:` (re-read through the Chain MCP) and lists the checks: a send compares the receipt status, the recipient's balance change (exactly the amount) and the sender's change (amount + gasUsed × effectiveGasPrice); reads are re-read at the same block; a revert or a mismatch is `FAILED` and exits 1 | the "VERIFY" lines below · tests `send --execute: …a failure` |
| 4 | Works for at least 3 different "how do I…" requests | four executed requests: check a PHRS balance, send PHRS (Atlantic), read a token's total supply (mainnet WPROS), look up a transaction receipt | [`proof/executed.json`](proof/executed.json): 4 × `success` |
| 5 | Says so when the docs don't cover a request instead of improvising | a request is "not covered" when the docs answer is a refusal, or when no cited page names the method. It prints "THE DOCS DON'T COVER THIS", makes no plan and opens no chain client (test). Demo: "how do I bridge to Solana on Pharos?" (block 6 below) and "wrap PHRS into WPHRS" (request 5 in the proof) | the last block below · [`proof/executed.json`](proof/executed.json) · tests `a request the docs don't cover…` |

## How it works

1. **Plan** (Docs MCP). The request is mapped to a docs question. `askQuestion` is a language model and can answer from general knowledge, so
   its answer only counts when a page it cites, fetched with `getPage`, contains the method the plan needs. Otherwise the docs are searched with
   `searchDocumentation`, and a page found that way is cited as such. A refusal-shaped answer ("can't find", "don't list", "isn't supported") is
   "not covered" whatever it cites. No language model of ours is involved: the same docs and chain give the same report.
2. **Execute** (Chain MCP). Reads go to the chain pinned to one block. A send is prepared with the Chain MCP (`get_transaction_count`
   pending, `estimate_gas`, base fee × 2 + priority fee), shown, and signed locally only with `--execute`.
3. **Verify**. A balance and a total supply are re-read at the same block; a receipt must have status 0x1; a send is checked against both
   balances at the receipt's block.

The docs answers vary between runs: the wording of the quoted sentences, which pages are cited, and sometimes whether a borderline request
(wrap) counts as covered. The proofs record what each run saw. Unknown requests the docs do describe are reported with their sources and
**not executed** ("NOT EXECUTED": this agent only has executors for balance, send, total supply and receipt).

## Proof (Atlantic chain 688689, Pacific mainnet 1672)

| Run | What it shows | Link |
|---|---|---|
| prepared (no flag) | the send is PREPARED: unsigned tx, funding check, nothing signed | [`proof/prepared.json`](proof/prepared.json) |
| `--execute` | the send is signed and mined, both balances checked; Atlantic tx [`0x5a0bdb1a…31e5`](https://atlantic.pharosscan.xyz/tx/0x5a0bdb1a4b718a4f19d72fb92826ac10e25f21ebdc259ecfe4ae0400e1fa31e5) | [`proof/executed.json`](proof/executed.json) |

The receipt lookup reads Atlantic tx `0x01cd6b78…4fe88`, the first transaction of the [Docs MCP Onboarding](../docs-mcp-onboarding/) task. The recipient is the burn address
`0x…dEaD` (a distinct address, never a self-transfer). The test key's address is read from `~/.config/pharos/testnet.env` only to know who "my" is.

Sample output of `npm run doc-grounded-builder-agent -- --execute --proof` (pasted from the run behind `proof/executed.json`):

```text
[1/6] request: "check my PHRS balance"  → balance on atlantic
  1. PLAN (Docs MCP, before acting)
     asked: How do I check my PHRS balance on Pharos Atlantic testnet?
     "Paste your wallet’s public address into the search bar on the Atlantic PharosScan explorer."
     "Open the address page to view its balance."
     "You can also check in your wallet after switching to Pharos Atlantic Testnet (chain ID 688689)."
     (checked: eth_getBalance is named on https://docs.pharos.xyz/getting-started/get-pros-gas)
     sources:
       - Pharos Network Snapshots: https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots
       - Token Registry: https://docs.pharos.xyz/getting-started/token-registry
       - x402 Atlantic Testnet: https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet
       - About Pharos: https://docs.pharos.xyz/introduction/readme
  2. EXECUTE (Chain MCP)
     1) Chain MCP get_balance(0x317bca01Bb101C0F1E86C21576a4e14D92B02975) at block 31561773 (docs: eth_getBalance returns wei)
     2) Divide by 10^18 for PHRS
     3) Re-read at block 31561773
  3. VERIFY (on chain)
     expected: 14.943867638999979 PHRS: the wei balance divided by 10^18, identical on a re-read at the same block
     observed: 14943867638999979000 wei = 14.943867638999979 PHRS at block 31561773
     ok   re-read at the same block equals the first read: 14943867638999979000
     ok   tool's PHRS figure equals wei / 10^18: 14.943867638999979
  RESULT: SUCCESS

[2/6] request: "send PHRS on Atlantic"  → send on atlantic
  1. PLAN (Docs MCP, before acting)
     asked: How do I send PHRS on Pharos Atlantic testnet?
     "To send native PHRS, use cast send with Atlantic’s RPC endpoint."
     "Atlantic uses chain ID 688689."
     "Replace the recipient and amount as needed."
     (checked: cast send + --value is named on https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
     sources:
       - Pharos Network Snapshots: https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots
       - Network: https://docs.pharos.xyz/getting-started/network
       - Atlantic Testnet: https://docs.pharos.xyz/getting-started/network/atlantic-testnet
       - x402 Atlantic Testnet: https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet
  2. EXECUTE (Chain MCP)
     1) Docs: a native transfer is `cast send <to> --value <amount>`; here the Chain MCP prepares it (nonce 41, gas 21000, fees from the latest block)
     2) Sign locally and broadcast through the Chain MCP (send_raw_transaction)
     3) Re-read the receipt and both balances through the Chain MCP
     unsigned transaction (for signature):
       from: 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
       to: 0x000000000000000000000000000000000000dEaD
       value: 1000000000000000 wei (0.001 PHRS)
       chainId: 688689
       nonce: 41
       gas: 21000
       maxFeePerGas: 2000000000
       maxPriorityFeePerGas: 0
     tx 0x5a0bdb1a4b718a4f19d72fb92826ac10e25f21ebdc259ecfe4ae0400e1fa31e5  https://atlantic.pharosscan.xyz/tx/0x5a0bdb1a4b718a4f19d72fb92826ac10e25f21ebdc259ecfe4ae0400e1fa31e5
  3. VERIFY (on chain)
     expected: receipt status 0x1, recipient +1000000000000000 wei, sender −(1000000000000000 wei + gasUsed × effectiveGasPrice)
     observed: success in block 31561778; recipient 3760145791673329147 → 3761145791673329147 wei, sender 14943867638999979000 → 14942846638999979000 wei, fee 21000000000000 wei
     ok   sender can cover value + max fee: 14943867638999979000 wei ≥ 1042000000000000 wei
     ok   receipt status: success
     ok   recipient balance rose by the amount: 1000000000000000
     ok   sender fell by the amount + gasUsed × effectiveGasPrice: 1021000000000000
  RESULT: SUCCESS

[6/6] request: "how do I bridge to Solana on Pharos?"  → no executor
  1. PLAN (Docs MCP, before acting)
     asked: how do I bridge to Solana on Pharos?
     NOT COVERED: the docs answer says they cannot confirm this
     sources:
       - Chainlink CCIP: https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/chainlink-ccip
       - Cross Chain Infrastructure: https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain
       - RPC Infrastructure: https://docs.pharos.xyz/tooling-and-infrastructure/rpc
       - Why Pharos: https://docs.pharos.xyz/introduction/why-pharos
  RESULT: THE DOCS DON'T COVER THIS. The docs don't cover this, so no plan is made and nothing is executed (no improvised steps).

summary: 6 requests · 4 verified · 0 prepared · 2 not covered/executed · 0 failed
via Docs MCP https://docs.pharos.xyz/~gitbook/mcp and the Pharos Chain MCP
```

## Limits (stated plainly)

- Four request kinds have executors (balance, send, total supply, receipt). A new "how do I…" request the docs describe is planned and cited
  but not executed.
- Balance and send are native PHRS on Atlantic only: a request that names a token or mainnet ("my USDC balance") is classed as "other", looked up in the docs and not executed.
- "Covered" means a cited (or searched) docs page contains the method name; it does not prove the page explains it well. For total supply the
  page that names `totalSupply` in the docs search is the Rust guide.
- Verification of a read is a same-block re-read, which catches a flaky endpoint, not a wrong contract; a send is verified against both balances.
- The docs say Atlantic lists a WPHRS contract but not its wrapping method, so "wrap PHRS" stays uncovered here rather than guessing `deposit()`.
- 31 tests ([`test/doc-grounded-builder-agent.test.ts`](../../test/doc-grounded-builder-agent.test.ts)) cover the classifier, the refusal patterns, the grounding fallback, prepared vs executed sends,
  a failed balance check, and "not covered ⇒ no chain call".
