# Doc-Search CLI — Easy

**Task:** [Doc-Search CLI](https://pharos-agent-arena.vercel.app/tasks/doc-search-cli) (Developer Docs MCP · Easy · 50 pts):
a small wrapper on the Developer Docs MCP that searches the Pharos docs from a terminal.
**Run:** `pharos-docs "<question>"` (after `npm ci`: `npm run doc-search-cli -- "<question>"`)
**Uses:** Docs MCP ✅ (`askQuestion`, `searchDocumentation`) · Chain MCP not used by this task · SkillEngine not used by this task

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | Accepts a natural-language question as input, e.g. `pharos-docs "how do I deploy a contract?"` | the bin is called `pharos-docs`; the question is the argument (unquoted words are joined) | [`bin/pharos-docs.mjs`](../../bin/pharos-docs.mjs) · [Example 1](#example-1) |
| 2 | Returns a concise answer plus links or references to the source doc sections | the answer from `askQuestion`, then its cited pages as absolute links (de-duplicated by URL, the pages the answer itself links first, same-titled pages told apart by their docs section, 5 shown, `--sources N` for more) | [`index.ts`](index.ts) `format` · Examples 1–3 |
| 3 | Handles "no good answer found" gracefully instead of inventing one | no cited source, or a reply that says it found nothing or OPENS by saying the docs/pages do not list, provide, document or specify it (a negation about anything else, such as "the faucet does not support mainnet", is an answer; an explicit contrast sentence such as "They do say …" keeps a half-answer) → "Not found in the Pharos docs", the model's text is dropped, the 3 closest pages from `searchDocumentation` are listed, exit code 3 | [Example 4](#example-4-a-question-the-docs-cannot-answer) · [Example 5](#example-5-a-pharos-question-the-docs-do-not-cover) · `test/doc-search-cli.test.ts` |
| 4 | README with install and usage instructions and 3 example queries with outputs | this file | Examples 1–5 below (rendered by the CLI from the `proof/*.json` runs) |

## Install

```bash
git clone https://github.com/edycutjong/pharos-beacon && cd pharos-beacon
npm ci                      # Node 20+; no API key, the Docs MCP is keyless
npm link                    # optional: puts `pharos-docs` on your PATH
```

Without `npm link`: `npm run doc-search-cli -- "<question>"` or `./bin/pharos-docs.mjs "<question>"`.

## Usage

```text
pharos-docs "<question>" [--goal "<what you are trying to do>"] [--sources N] [--json] [--proof]
```

| Flag | Meaning |
|---|---|
| `--goal` | the broader goal, passed to `askQuestion` so the answer is tailored to it |
| `--sources N` | how many source links to print (default 5) |
| `--json` | print the structured result (`found`, `answer`, `sources`, `closest`) instead of text |
| `--proof` | also write `proof/<question-slug>.json` (endpoint, server version, commit, command) |

Exit codes: `0` answered, `3` the docs have no answer, `2` bad usage, `1` failure (network, server error).

## What it does

It connects to the Developer Docs MCP (`https://docs.pharos.xyz/~gitbook/mcp`, keyless) and calls `askQuestion`, which returns a
written answer ending in a `# Sources` list. The answer is good only if it cites at least one page and does not say it found
nothing. Otherwise the CLI prints a clear "not found" line, calls `searchDocumentation` for the closest pages and lists them as
"may not answer it". If `askQuestion` itself fails, it says so and still lists the closest pages. It prints only what
`askQuestion` returned and adds only absolute links and the source list.

## Docs MCP tools

| Tool | Used for |
|---|---|
| `askQuestion` | the answer and its `# Sources` list |
| `searchDocumentation` | the closest pages when there is no good answer |

## Example queries (real output)

Each block below is the CLI's output from the proof run named under it (2026-10-18), rendered from the proof JSON by the CLI's own formatter.

### Example 1

```text
$ pharos-docs "how do I deploy a contract?"
On Pharos, compile and test your contract, then deploy it with Foundry or Hardhat. You’ll need a Pharos RPC URL and a funded wallet for deployment gas.

**Foundry:** Set your private key, then run your deployment script:

```bash
export PRIVATE_KEY=<your-private-key>
forge build
forge test
forge script script/DeployToken.s.sol \
  --rpc-url <PHAROS_RPC_URL> \
  --broadcast
```

Your script should load `PRIVATE_KEY`, start broadcasting, and create the contract with `new YourContract(...)`. See the [Write Your First Token](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token) for a complete example.

**Hardhat:** Store the key with `npx hardhat vars set PRIVATE_KEY`, then compile and deploy:

```bash
npx hardhat compile
npx hardhat test
npx hardhat ignition deploy ./ignition/modules/Token.js --network pharos
```

See the [Write Your First Token](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-token) for network configuration and an example.

Sources:
  - Write Your First Token (foundry): https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token
  - Write Your First Token (hardhat): https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-token
  - Write Your First Uniswap Contract (foundry): https://docs.pharos.xyz/developer-guide/foundry/write-your-first-uniswap-contract
  - Write Your First Uniswap Contract (hardhat): https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-uniswap-contract
  - Validator Node Deployment: https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment
  (+5 more cited by the docs; use --sources 10 to list them)
```

Exit code 0. Proof: [`proof/how-do-i-deploy-a-contract.json`](proof/how-do-i-deploy-a-contract.json).

### Example 2

```text
$ pharos-docs "what is the chain ID and RPC URL of the Atlantic testnet?"
Atlantic Testnet uses:

* **Chain ID:** `688689`
* **RPC URL:** `https://atlantic.dplabs-internal.com`

See [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet).

Sources:
  - Atlantic Testnet: https://docs.pharos.xyz/getting-started/network/atlantic-testnet
  - x402 Atlantic Testnet: https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet
  - Node Management: https://docs.pharos.xyz/node-and-validator-guide/node-management
  - ZAN RPC: https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan
  - Write Your First Token (hardhat): https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-token
  (+5 more cited by the docs; use --sources 10 to list them)
```

Exit code 0. Proof: [`proof/what-is-the-chain-id-and-rpc-url-of-the-atlantic-testnet.json`](proof/what-is-the-chain-id-and-rpc-url-of-the-atlantic-testnet.json).

### Example 3

```text
$ pharos-docs "how do I get testnet tokens from the faucet?"
Add the **Pharos Atlantic Testnet** to your wallet, then request testnet PHRS from the Pharos faucet using your wallet address. The network uses RPC `https://atlantic.dplabs-internal.com`, chain ID `688689`, and token symbol `PHRS`.

The docs don’t provide the faucet URL or claim steps. See [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet) and [Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide).

Sources:
  - Atlantic Testnet: https://docs.pharos.xyz/getting-started/network/atlantic-testnet
  - Piggy Bank Tutorial: https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide
  - Token Registry: https://docs.pharos.xyz/getting-started/token-registry
  - Write Your First Token (foundry): https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token
  - Write Your First Token (hardhat): https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-token
  (+7 more cited by the docs; use --sources 12 to list them)
```

Exit code 0. Proof: [`proof/how-do-i-get-testnet-tokens-from-the-faucet.json`](proof/how-do-i-get-testnet-tokens-from-the-faucet.json). The missing faucet URL is also gap 2 in the [Docs MCP Onboarding](../docs-mcp-onboarding/ONBOARDING.md#gaps-and-suggested-fixes) log.

### Example 4: a question the docs cannot answer

```text
$ pharos-docs "what is the best pizza recipe in Naples?"
Not found in the Pharos docs: no good answer to this question, so none is given.

Closest pages (they may not answer it):
  - Solidity: https://docs.pharos.xyz/resources/solidity
  - Piggy Bank Tutorial: https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide
  - Gas Model: https://docs.pharos.xyz/getting-started/gas-model
```

Exit code 3. Proof: [`proof/what-is-the-best-pizza-recipe-in-naples.json`](proof/what-is-the-best-pizza-recipe-in-naples.json).

### Example 5: a Pharos question the docs do not cover

```text
$ pharos-docs "how do I bridge to Solana from Pharos?"
Not found in the Pharos docs: no good answer to this question, so none is given.

Closest pages (they may not answer it):
  - ZAN RPC: https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan
  - Pharos Skill Engine: https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide
  - About Pharos: https://docs.pharos.xyz/introduction/readme
```

Exit code 3. Proof: [`proof/how-do-i-bridge-to-solana-from-pharos.json`](proof/how-do-i-bridge-to-solana-from-pharos.json).

## Proof

| Run | Result | File |
|---|---|---|
| deploy a contract | answered, sources listed | [`proof/how-do-i-deploy-a-contract.json`](proof/how-do-i-deploy-a-contract.json) |
| Atlantic chain ID and RPC | answered, sources listed | [`proof/what-is-the-chain-id-and-rpc-url-of-the-atlantic-testnet.json`](proof/what-is-the-chain-id-and-rpc-url-of-the-atlantic-testnet.json) |
| faucet | answered, with the docs' own admission that the faucet URL is not specified | [`proof/how-do-i-get-testnet-tokens-from-the-faucet.json`](proof/how-do-i-get-testnet-tokens-from-the-faucet.json) |
| off-topic question | not found, closest pages, exit 3 | [`proof/what-is-the-best-pizza-recipe-in-naples.json`](proof/what-is-the-best-pizza-recipe-in-naples.json) |
| Pharos question the docs do not cover (bridge to Solana) | not found, closest pages, exit 3 | [`proof/how-do-i-bridge-to-solana-from-pharos.json`](proof/how-do-i-bridge-to-solana-from-pharos.json) |

Each proof was written from a clean, committed tree (`meta.git.dirty` is false). The task is read-only; there is no transaction.

## Limits

- The answer text is written by the Docs MCP's own `askQuestion`; the CLI does not verify it beyond requiring a cited source.
- "No good answer" is detected from the reply wording ("cannot find…", "not documented…") plus an empty source list. A reply phrased
  differently with sources would be shown as an answer. The same holds the other way: an answer that opens with "the docs do not list …" (bold or not) is
  treated as not found even when it goes on to say something useful, so a half-answer phrased that way loses its second half.
- The listed sources are what the Docs MCP cites; for broad questions some may be loosely related (see Example 1).

## Tests

`npm test` runs 26 tests for this task (`test/doc-search-cli.test.ts`) against a fake Docs client with replies recorded from the live
server: answer + de-duplicated sources (linked pages first, same-titled pages told apart), a bolded refusal counting as not found, the refusal rule (docs as the subject, verb list, contrast sentence, four live replies to the faucet question and the two live Solana replies), the off-topic path (no answer text printed, closest pages from `searchDocumentation`),
`askQuestion` failing, both calls failing, relative links made absolute, the `--sources` cap, `--json`, exit codes, and usage errors.

The model words its reply differently from run to run (the faucet question was answered as a half-answer in 3 of 4 runs and as "I cannot find" in the fourth). (replies and exit codes: [`proof/gate-runs-2026-10-18.txt`](proof/gate-runs-2026-10-18.txt).) The gate is therefore a stated rule, pinned by the tests above, not a property of one reply; re-run on 2026-10-18 after the rule was tightened, the faucet question exited 0 four times out of four and the Solana question exited 3 four times out of four.
