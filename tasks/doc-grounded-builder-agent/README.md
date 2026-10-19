# Doc-Grounded Builder Agent — Hard

**Live demo:** [pharos.edycu.dev/doc-grounded-builder-agent](https://pharos.edycu.dev/doc-grounded-builder-agent)

**Task:** [Doc-Grounded Builder Agent](https://pharos-agent-arena.vercel.app/tasks/doc-grounded-builder-agent) (Cross-tool / Advanced · Hard · 200 pts):
answers "how do I do X on Pharos?" from the Developer Docs MCP, then does X with the Chain MCP and verifies it on chain.
**Run:** `npm run doc-grounded-builder-agent -- ["request" …] [--address 0x…] [--to 0x…] [--amount PHRS] [--token 0x…] [--tx 0x…] [--execute] [--json] [--proof]`
(no request = the five-request demo; Atlantic needs the one-time `npm run setup:mcp`, keyless; mainnet reads use the hosted Chain MCP. Without a key "my" is the author's public Atlantic test address, which the run prints; nothing can be signed from it)
**Uses:** Docs MCP ✅ (`askQuestion`, `getPage`, `searchDocumentation`) · Chain MCP ✅ (`get_block_number`, `get_balance`, `get_transaction_count`, `estimate_gas`, `get_block`, `get_gas_price`, `eth_call`, `send_raw_transaction`, `get_transaction_receipt`) · SkillEngine: not used

Try it (nothing is signed without `--execute`):
`npm run doc-grounded-builder-agent -- "send PHRS on Atlantic" --to 0x000000000000000000000000000000000000dEaD --amount 0.001 --address <your Atlantic address>`

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | Uses Docs MCP to plan, with sources cited, before acting | `plan()` runs first: `askQuestion`, then each cited page is fetched with `getPage` and must contain the method (`eth_getBalance`, `cast send` + `--value`, `totalSupply`, `eth_getTransactionReceipt`); if none does, `searchDocumentation` is tried. Under "PLAN", before any chain call, it prints the docs answer (labelled as the by-hand route a person would follow), what the agent will actually run (the send is a Chain MCP-prepared transaction, not `cast`), the docs line that names the method (for the send, the line holding `cast send` and `--value`), whether that page was cited by the answer or found with `searchDocumentation`, and the sources with that page first | `agent.ts` `plan` · output block below · [`proof/executed.json`](proof/executed.json) |
| 2 | Executes with Chain MCP and/or SkillEngine; anything that moves funds is prepared for signature | every chain step is a Chain MCP tool call. A send prints the unsigned transaction (nonce, gas, fees from the MCP) and stops, "PREPARED"; only `--execute` signs it locally and broadcasts it, on Atlantic. Mainnet is read-only: `--execute` never opens a broadcasting client for it (test) | [`proof/prepared.json`](proof/prepared.json) (nothing sent) · [`proof/executed.json`](proof/executed.json) |
| 3 | Verifies the outcome on chain and reports success or failure against the plan | each result states `expected:` (from the plan) and `observed:` (re-read through the Chain MCP) and lists the checks: a send compares the receipt status, the recipient's balance change (exactly the amount) and the sender's change (amount + gasUsed × effectiveGasPrice); balance and total-supply reads are re-read at the same block, a receipt is checked for status 0x1; a revert or a mismatch is `FAILED` and exits 1. The balance and the receipt also have an independent cross-check: the balance is read a second way, through `Multicall3.getEthBalance` (`eth_call`), and the receipt's hash must be in the transaction list of the block the receipt names | the "VERIFY" lines below · tests `send --execute: …a failure` |
| 4 | Works for at least 3 different "how do I…" requests | four executed requests: check a PHRS balance, send PHRS (Atlantic), read a token's total supply (mainnet WPROS), look up a transaction receipt | [`proof/executed.json`](proof/executed.json): 4 × `success`; all four are pasted in full below (requests 1–4) |
| 5 | Says so when the docs don't cover a request instead of improvising | a request is "not covered" when the docs answer is a refusal, or when no cited page names the method. It prints "THE DOCS DON'T COVER THIS", makes no plan and opens no chain client (test). Demo: "how do I bridge to Solana on Pharos?" (request 5 below; the Chainlink CCIP page it cites lists lanes to Ethereum, Jovay, Polygon and Base, and the LayerZero page gives no Solana destination). "Wrap PHRS into WPHRS" is classified and tested as not covered, but kept out of the demo because the docs answer to it changes between runs | the last block below · [`proof/executed.json`](proof/executed.json) · tests `a request the docs don't cover…` |

## How it works

1. **Plan** (Docs MCP). The request is mapped to a docs question. `askQuestion` is a language model and can answer from general knowledge, so
   its answer only counts when a page it cites, fetched with `getPage`, contains the method the plan needs. Otherwise the docs are searched with
   `searchDocumentation`, and a page found that way is cited as such. A refusal-shaped answer ("can't find", "don't list", "isn't supported") is
   "not covered" whatever it cites. No language model of ours is involved: the same docs answers and chain state give the same report.
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
| `--execute` | the send is signed and mined, both balances checked; Atlantic tx [`0xdc44f87a…ebfa`](https://atlantic.pharosscan.xyz/tx/0xdc44f87aeed01b93eb0305b399ea3da86ed9712a3fba5f9bbfdae27b50d4ebfa) | [`proof/executed.json`](proof/executed.json) |

The receipt lookup reads Atlantic tx `0x01cd6b78…4fe88`, the first transaction of the [Docs MCP Onboarding](../docs-mcp-onboarding/) task. The recipient is the burn address
`0x…dEaD` (a distinct address, never a self-transfer); when the second test wallet's key is present (`PRIVATE_KEY_2`) the recipient is that wallet instead, because no one else's send can touch its balance in the same block, which the exact-amount check relies on. The proof run used the second test wallet. The test key's address is read from `~/.config/pharos/testnet.env` only to know who "my" is.

Sample output of `npm run doc-grounded-builder-agent -- --execute --proof`, in full (all five requests; pasted from the run behind `proof/executed.json`). The docs answers vary between runs, so quotes differ from run to run; a quoted line like `"name": "totalSupply",` is the page's own line that names the method (here an ABI fragment in the Rust guide):

```text
[1/5] request: "check my PHRS balance"  → balance on atlantic
  1. PLAN (Docs MCP, before acting)
     asked: How do I check my PHRS balance on Pharos Atlantic testnet?
     docs answer (askQuestion), the by-hand route a person would follow:
       "Check it in either your wallet or the Atlantic Testnet explorer: * Explorer: Search for your wallet’s public address."
       "The account page shows its PHRS balance."
       "* Wallet: Switch to Atlantic Testnet and view the native-token balance."
     what this agent runs: Chain MCP get_balance (the docs' eth_getBalance)
     the docs name eth_getBalance on a page found with searchDocumentation:
       "| `get_balance`             | `eth_getBalance`            | Native PROS balance of an address |"
       https://docs.pharos.xyz/tooling-and-infrastructure/mcp
     sources:
       - Pharos MCP (found with searchDocumentation): https://docs.pharos.xyz/tooling-and-infrastructure/mcp
       - Get PROS Gas (found with searchDocumentation): https://docs.pharos.xyz/getting-started/get-pros-gas
       - JSON-RPC API Methods (found with searchDocumentation): https://docs.pharos.xyz/api-and-sdk/json-rpc-methods
       - Pharos Network Snapshots: https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots
  2. EXECUTE (Chain MCP)
     1) Chain MCP get_balance(0x317bca01Bb101C0F1E86C21576a4e14D92B02975) at block 31580870 (docs: eth_getBalance returns wei)
     2) Divide by 10^18 for PHRS
     3) Re-read at block 31580870, and read the same balance through Multicall3.getEthBalance
  3. VERIFY (on chain)
     expected: 14.920271289999979 PHRS: the wei balance divided by 10^18, identical on a re-read and through Multicall3.getEthBalance at the same block
     observed: 14920271289999979000 wei = 14.920271289999979 PHRS at block 31580870
     ok   re-read at the same block equals the first read: 14920271289999979000
     ok   tool's PHRS figure equals wei / 10^18: 14.920271289999979
     ok   Multicall3.getEthBalance (a different route, eth_call) gives the same wei: 14920271289999979000
  RESULT: SUCCESS

[2/5] request: "send PHRS on Atlantic"  → send on atlantic
  1. PLAN (Docs MCP, before acting)
     asked: How do I send PHRS on Pharos Atlantic testnet?
     docs answer (askQuestion), the by-hand route a person would follow:
       "Add Pharos Atlantic Testnet to your EVM wallet with these settings: * RPC URL: https://atlantic.dplabs-internal.com * Chain ID: 688689 * Currency symbol: PHRS Then choose Send, enter the recipient address and PHRS amount, and confirm the transaction."
       "You’ll need testnet PHRS; the setup guide points to the Pharos faucet or the team for test tokens."
       "See Atlantic Testnet network details."
     what this agent runs: a Chain MCP-prepared transaction signed here and sent with send_raw_transaction (the docs' `cast send <to> --value` is the by-hand route)
     the docs name cast send + --value on a page the docs answer cites:
       "cast send <recipient> --value 0.1ether --private-key $PRIVATE_KEY --rpc-url $RPC"
       https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide
     sources:
       - Pharos Skill Engine: https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide
       - Pharos Network Snapshots: https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots
       - ZAN RPC: https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan
       - Network: https://docs.pharos.xyz/getting-started/network
  2. EXECUTE (Chain MCP)
     1) Docs: a native transfer is `cast send <to> --value <amount>`; here the Chain MCP prepares it (nonce 110, gas 21000, fees from the latest block)
     2) Sign locally and broadcast through the Chain MCP (send_raw_transaction)
     3) Re-read the receipt and both balances through the Chain MCP
     unsigned transaction (for signature):
       from: 0x317bca01Bb101C0F1E86C21576a4e14D92B02975
       to: 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
       value: 1000000000000000 wei (0.001 PHRS)
       chainId: 688689
       nonce: 110
       gas: 21000
       maxFeePerGas: 2000000000
       maxPriorityFeePerGas: 0
     tx 0xdc44f87aeed01b93eb0305b399ea3da86ed9712a3fba5f9bbfdae27b50d4ebfa  https://atlantic.pharosscan.xyz/tx/0xdc44f87aeed01b93eb0305b399ea3da86ed9712a3fba5f9bbfdae27b50d4ebfa
  3. VERIFY (on chain)
     expected: receipt status 0x1, recipient +1000000000000000 wei, sender −(1000000000000000 wei + gasUsed × effectiveGasPrice)
     observed: success in block 31580877; recipient 15029632205000000000 → 15030632205000000000 wei, sender 14920271289999979000 → 14919250289999979000 wei, fee 21000000000000 wei
     ok   sender can cover value + max fee: 14920271289999979000 wei ≥ 1042000000000000 wei
     ok   receipt status: success
     ok   recipient balance rose by the amount: 1000000000000000
     ok   sender fell by the amount + gasUsed × effectiveGasPrice: 1021000000000000
  RESULT: SUCCESS

[3/5] request: "read a token's total supply"  → supply on pharos
  1. PLAN (Docs MCP, before acting)
     asked: How do I read the total supply of an ERC-20 token on Pharos?
     docs answer (askQuestion), the by-hand route a person would follow:
       "Call the token contract’s totalSupply() view function."
       "With Foundry’s cast: For Pharos Atlantic Testnet, use https://atlantic.dplabs-internal.com as the RPC URL instead."
       "The result is an integer in the token’s smallest units; check decimals() to interpret it."
     what this agent runs: Chain MCP eth_call of totalSupply()
     the docs name totalSupply on a page found with searchDocumentation:
       ""name": "totalSupply","
       https://docs.pharos.xyz/developer-guide/rust
     sources:
       - Rust: https://docs.pharos.xyz/developer-guide/rust
       - About Pharos: https://docs.pharos.xyz/introduction/readme
       - Why Pharos: https://docs.pharos.xyz/introduction/why-pharos
       - x402 Atlantic Testnet: https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet
  2. EXECUTE (Chain MCP)
     1) Chain MCP eth_call totalSupply() on 0x52C48d4213107b20bC583832b0d951FB9CA8F0B0 at block 20580945
     2) Chain MCP eth_call decimals() (18) and symbol()
     3) Divide by 10^decimals (docs), re-read at block 20580945
  3. VERIFY (on chain)
     expected: totalSupply() as a raw integer; 23,287,530.238744886383023838 WPROS once divided by 10^18, identical on a re-read at the same block
     observed: 23287530238744886383023838 base units = 23,287,530.238744886383023838 WPROS at block 20580945
     ok   re-read at the same block equals the first read: 23287530238744886383023838
  RESULT: SUCCESS

[4/5] request: "look up the receipt of a transaction"  → receipt on atlantic
  1. PLAN (Docs MCP, before acting)
     asked: How do I look up a transaction receipt on Pharos?
     docs answer (askQuestion), the by-hand route a person would follow:
       "Use the transaction hash to find the transaction in Hemera SocialScan, Pharos’s block explorer."
       "Open its transaction details to inspect the receipt."
       "For a direct RPC lookup, call eth_getTransactionReceipt with the hash: The receipt includes fields such as status, gasUsed, blockNumber, and logs."
     what this agent runs: Chain MCP get_transaction_receipt (the docs' eth_getTransactionReceipt)
     the docs name eth_getTransactionReceipt on a page the docs answer cites:
       ""method": "eth_getTransactionReceipt","
       https://docs.pharos.xyz/api-and-sdk/json-rpc-methods
     sources:
       - JSON-RPC API Methods: https://docs.pharos.xyz/api-and-sdk/json-rpc-methods
       - Hardhat: https://docs.pharos.xyz/developer-guide/hardhat
       - Foundry: https://docs.pharos.xyz/developer-guide/foundry
       - x402 Atlantic Testnet: https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet
  2. EXECUTE (Chain MCP)
     1) Chain MCP get_transaction_receipt(0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88)
     2) Read status, blockNumber, gasUsed
     3) Chain MCP get_block(receipt block): the hash is in that block's transaction list
     tx 0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88  https://atlantic.pharosscan.xyz/tx/0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88
  3. VERIFY (on chain)
     expected: a receipt with status 0x1 (success), for a transaction that is listed in the block the receipt names
     observed: status 0x1, block 31557251, gasUsed 21000
     ok   receipt status: 0x1 success
     ok   the block's transaction list contains the hash: block 31557251
  RESULT: SUCCESS

[5/5] request: "how do I bridge to Solana on Pharos?"  → no executor
  1. PLAN (Docs MCP, before acting)
     asked: how do I bridge to Solana on Pharos?
     NOT COVERED: the docs answer says they cannot confirm this
     sources:
       - About Pharos: https://docs.pharos.xyz/introduction/readme
       - Why Pharos: https://docs.pharos.xyz/introduction/why-pharos
       - Pharos Network Snapshots: https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots
       - x402 Atlantic Testnet: https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet
  RESULT: THE DOCS DON'T COVER THIS. The docs don't cover this, so no plan is made and nothing is executed (no improvised steps).

summary: 5 requests · 4 verified · 0 prepared · 1 not covered/executed · 0 failed
via Docs MCP https://docs.pharos.xyz/~gitbook/mcp and the Pharos Chain MCP
```

## Limits (stated plainly)

- Four request kinds have executors (balance, send, total supply, receipt). A new "how do I…" request the docs describe is planned and cited
  but not executed.
- Balance and send are native PHRS on Atlantic only: a request that names a token or mainnet ("my USDC balance") is classed as "other", looked up in the docs and not executed.
- "Covered" means a cited (or searched) docs page contains the method name; it does not prove the page explains it well. For total supply the
  page that names `totalSupply` in the docs search is the Rust guide. The [Docs MCP + Chain MCP Agent](../docs-chain-mcp-agent/) accepts cited pages only, so it reports `totalSupply()` as
  not described where this agent finds that page by search and carries on.
- The checks on the total-supply read are a same-block re-read, which catches a flaky endpoint, not a wrong contract. The balance is also read through `Multicall3.getEthBalance` and the receipt's hash must be in its block's
  transaction list, which catches a wrong figure or a receipt that does not belong to a mined transaction, but not a wrong plan. Only the send is verified against a plan (recipient + amount, sender − (amount + fee)).
- "Wrap PHRS into WPHRS" is classified as a request with no executor and is not in the demo: whether the docs answer counts as a refusal changed between runs. The docs list a WPHRS contract but not its wrapping method, so nothing is guessed (`deposit()`).
- 38 tests ([`test/doc-grounded-builder-agent.test.ts`](../../test/doc-grounded-builder-agent.test.ts)) cover the classifier, the refusal patterns, the grounding fallback, prepared vs executed sends,
  a failed balance check, the Multicall3 and block-list cross-checks, the PLAN printout, and "not covered ⇒ no chain call".
