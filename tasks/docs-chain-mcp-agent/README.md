# Docs MCP + Chain MCP Agent — Medium

**Task:** [Docs MCP + Chain MCP Agent](https://pharos-agent-arena.vercel.app/tasks/docs-chain-mcp-agent) (Composition · Medium · 100 pts):
explains a contract function from the Developer Docs MCP, then calls it via Chain MCP and interprets the result.
**Run:** `npm run docs-chain-mcp-agent` (the five-function demo on Pharos mainnet) or
`npm run docs-chain-mcp-agent -- --contract 0x… --function name|symbol|decimals|totalSupply|balanceOf|getChainId [--arg 0x<holder>] [--block N] [--json] [--proof]` (keyless; read-only)
**Uses:** Docs MCP ✅ (`askQuestion`, `getPage`) · Chain MCP ✅ (hosted `https://mcp.pharos.xyz/mcp`: `get_block_number`, `eth_call`, `get_logs`) · SkillEngine: not used

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | The explanation comes from Docs MCP, with sources referenced | step 1 of every function is `askQuestion`; the sentences that name the function are printed verbatim and the cited pages are listed | every proof has `docs.excerpt` and `docs.sources` · [usdc-balanceof](proof/usdc-balanceof.json) |
| 2 | The agent then calls the same function on chain via Chain MCP | step 2 is an `eth_call` of the same selector on the same contract, after the docs step, pinned to one block | `chain.raw` + `chain.block` in each proof |
| 3 | Interprets the result in the context of the explanation | step 3 quotes the docs excerpt it relies on and applies it (decimals → "26,001.969072 USDC"); with no docs explanation it says so and gives the raw value | the `interpretation` field of each proof |
| 4 | Works for at least 2 different functions or contracts | 5 functions on 3 contracts (USDC, WPROS, Multicall3): 3 explained by the docs and read, 2 that the docs do not describe, reported as such | the five proofs below |

## How it works

For each function the agent does three things in order.
1. **Docs MCP.** `askQuestion` ("What does the `balanceOf(address)` function of a token like USDC do on Pharos, and how should its result be read?").
   `askQuestion` is a language model and can answer from general knowledge, so its answer only counts when a page it cites names the function:
   the agent fetches up to 6 cited pages with `getPage` and needs an exact, case-sensitive match on the function name in at least one of them
   (the page is printed as `checked: … is named on <url>`). It also checks that the contract address is listed on the docs
   [Token Registry](https://docs.pharos.xyz/getting-started/token-registry) page. If there is no grounded explanation the agent prints
   `NOT DESCRIBED in the docs` and gives none: no explanation and no unit from general knowledge.
2. **Chain MCP.** The same function, same contract, `eth_call` at the block read from `get_block_number` (one block for the whole run).
3. **Reading.** Deterministic code (no language model, so the same inputs give the same report) combines the two: it quotes the docs excerpt, then
   applies it. `decimals()` → "1 token is 10^N base units". `balanceOf` / `totalSupply` → the base-unit integer divided by the chain's own
   `decimals()` at the same block, with `symbol()`. For an undocumented function, the raw value only.

The docs answers come from a live language model, so the excerpt wording (and occasionally which functions count as documented) can change between runs.
The proofs record what each run saw.

## Proof (live runs on Pharos mainnet, chain 1672, hosted Chain MCP)

Each proof is a separate run committed on its own, so every file records `"dirty": false`.

| # | Contract | Function | Docs explanation | Chain result | Proof |
|---|---|---|---|---|---|
| 1 | USDC (Circle-deployed) `0xc879…1815` | `decimals()` | yes, grounded | `6` | [proof](proof/usdc-decimals.json) |
| 2 | USDC (Circle-deployed) `0xc879…1815` | `balanceOf(address)` | yes, grounded | `26001969072` → 26,001.969072 USDC | [proof](proof/usdc-balanceof.json) |
| 3 | WPROS `0x52c4…f0b0` | `decimals()` | yes, grounded (the registry lists the address, not the decimals; the chain gives 18) | `18` | [proof](proof/wpros-decimals.json) |
| 4 | WPROS `0x52c4…f0b0` | `totalSupply()` | no: no cited page names it | `23265853327450767742350284` (raw, no unit applied) | [proof](proof/wpros-totalsupply.json) |
| 5 | Multicall3 `0xcA11…CA11` | `getChainId()` | no: no cited page names it | `1672` (raw) | [proof](proof/multicall3-getchainid.json) |

An explained function (proof 2, abridged only by the 4-source cap in the printout):

```text
$ npm run docs-chain-mcp-agent -- --contract 0xc879c018db60520f4355c26ed1a6d572cdac1815 --function balanceOf --arg 0x94807fE4300D15909C1a4fd39f76c61D68aee11E
Pharos mainnet (chain 1672), every read pinned to block 20534832

[1/1] USDC (Circle-deployed) · balanceOf(address)  holder 0x94807fE4300D15909C1a4fd39f76c61D68aee11E [the --arg address]
  contract 0xC879C018dB60520F4355C26eD1a6D572cdAC1815  (this address is listed on the docs Token Registry page)
  1. Docs MCP (askQuestion):
     "balanceOf(address) reads the USDC balance held by the address you pass."
     "USDC uses 6 decimals, so divide the returned value by 1,000,000 to get USDC."
     (checked: balanceOf(address) is named on https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
     sources:
       - About Pharos: https://docs.pharos.xyz/introduction/readme
       - Token Registry: https://docs.pharos.xyz/getting-started/token-registry
       - Fordefi: https://docs.pharos.xyz/tooling-and-infrastructure/wallets/fordefi
       - Pharos Skill Engine: https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide
  2. Chain MCP (eth_call @ 20534832): 26001969072
  3. Reading: Docs: "balanceOf(address) reads the USDC balance held by the address you pass. USDC uses 6 decimals, so divide the returned value by 1,000,000 to get USDC." The chain returned 26001969072 base units for the holder 0x94807fE4300D15909C1a4fd39f76c61D68aee11E (the --arg address); the same block's decimals() is 6, so that is 26,001.969072 USDC.

via https://mcp.pharos.xyz/mcp (Chain MCP) and https://docs.pharos.xyz/~gitbook/mcp (Docs MCP)
```

A function the docs do not describe (proof 4):

```text
$ npm run docs-chain-mcp-agent -- --contract 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0 --function totalSupply
Pharos mainnet (chain 1672), every read pinned to block 20534880

[1/1] WPROS (Wrapped PROS) · totalSupply()
  contract 0x52C48d4213107b20bC583832b0d951FB9CA8F0B0  (this address is listed on the docs Token Registry page)
  1. Docs MCP (askQuestion):
     NOT DESCRIBED in the docs: no cited page names totalSupply, so no explanation is given (nothing is filled in from general knowledge).
     sources:
       - Get PROS Gas: https://docs.pharos.xyz/getting-started/get-pros-gas
       - Pacific Mainnet: https://docs.pharos.xyz/getting-started/network/pacific-mainnet
       - Token Registry: https://docs.pharos.xyz/getting-started/token-registry
       - Pharos MCP: https://docs.pharos.xyz/tooling-and-infrastructure/mcp
  2. Chain MCP (eth_call @ 20534880): 23265853327450767742350284
  3. Reading: The docs do not describe totalSupply(), so there is no explanation to read this against and no unit is applied. Raw result: 23265853327450767742350284.

via https://mcp.pharos.xyz/mcp (Chain MCP) and https://docs.pharos.xyz/~gitbook/mcp (Docs MCP)
```

## Notes

- Read-only: no key, no transaction, no mainnet write. Nothing is written unless `--proof` is passed.
- The demo (no flags) picks a USDC holder with `get_logs` (the recipient of a large recent transfer that still holds a balance), as Read Contract State does.
- 12 tests in `test/docs-chain-mcp-agent.test.ts` (grounding, refusals, the docs-before-chain order, one pinned block, units only for a documented function, flag errors, a token without decimals()).
