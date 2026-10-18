# Onboarding to Pharos with only the Developer Docs MCP

An honest log. Goal: go from zero to a working Pharos setup (wallet and Atlantic network, faucet, Chain MCP, SkillEngine, a first
transaction and a contract read) and say where the docs got me unstuck and where they failed.

**Rules I followed.** Every answer I acted on came from the Developer Docs MCP (`https://docs.pharos.xyz/~gitbook/mcp`: `askQuestion`,
`searchDocumentation`). No web search, no copies of the docs, no community help, and `sendFeedback` was not called. The one
exception is that I (an AI agent) already knew what an EVM wallet, `cast` and an MCP config are; I did not use any Pharos-specific
knowledge to choose an answer, with two exceptions: query #3 names PHRS and query #10 names WPROS from prior knowledge (the answers and the address came from the docs). Every call is a line in [`proof/transcript.jsonl`](proof/transcript.jsonl), rendered in
[`proof/transcript.md`](proof/transcript.md); each quote below (`>` lines) is copied from it and checked by a test
(`test/docs-onboarding.test.ts`). `#N` is the call number in the transcript.

**Target.** The Season of AI task says "onboard into ai.pharos.xyz". That site is not found by the Docs MCP (gap 1), so
I onboarded onto what the docs do describe: the Atlantic testnet, the Chain MCP, the SkillEngine and a first transaction.

## Step log

### 1. What is ai.pharos.xyz?
Query (#1, `askQuestion`): `What is ai.pharos.xyz and how do I get started with it?`

> I can’t find documentation for **ai.pharos.xyz** specifically. The Pharos docs describe **Anvita Flow**, an AI-agent platform, and **Anvita On**, its user-facing chat interface. The docs list `flow.anvita.xyz/agent/chat` as the chat URL, not `ai.pharos.xyz`.

Result: dead end for the named site. The answer offers a neighbouring product (Anvita Flow) and says so honestly, which helped me stop
guessing. I did not follow the Anvita route (it needs a browser login). **Gap 1.**

### 2. Wallet and the Atlantic network
Query (#2): `How do I set up a wallet and add the Atlantic testnet network?`

> The network reference doesn’t specify a currency-symbol field. See [Atlantic Testnet](/getting-started/network/atlantic-testnet). For wallet options, see [Wallet](/tooling-and-infrastructure/wallets).

Result: the answer gave the network name, RPC `https://atlantic.dplabs-internal.com`, chain ID `688689` and the explorer, enough to
configure a wallet. A browser wallet needs a human, so adding the network to a wallet extension is logged as "needs a browser
wallet login" (HUMAN-TODO). I used a key in a shell variable with Foundry instead (step 8). The missing currency symbol is **gap 5**.

### 3. Faucet
Query (#3): `Where is the faucet for Atlantic testnet PHRS and how do I claim tokens?`

> The docs don’t provide a faucet URL or claim steps. They only say to get Atlantic testnet PHRS from the **Pharos faucet or directly from the team**.

Result: blocked. I could not get tokens from the docs. The testnet wallet I used had already been funded before this session (14.956 PHRS at
the start of step 8), so the faucet was **not** exercised through the docs. **Gap 2.** A claim through the faucet is also a browser step
(HUMAN-TODO).

### 4. Chain MCP (hosted, mainnet)
Query (#4): `How do I set up the Pharos Chain MCP server so my AI agent can read the chain? Give the exact install command and config.`

> For read access, use the hosted Pharos MCP server. It needs no API key. Add this to your agent’s MCP configuration:

> npx -y mcp-remote https://mcp.pharos.xyz/mcp

> curl https://mcp.pharos.xyz/health

Result: worked first time. The health check returned `{"status":"ok","chain":"Pharos","chainId":1672,...}` with HTTP 200
([`proof/commands.txt`](proof/commands.txt)), and the hosted endpoint then served a real read (step 7). This answer is the best one in
the log: exact config, exact command, a way to verify.

### 5. SkillEngine
Queries (#5, #6): `How do I install and use the Pharos SkillEngine and what is a skill?` and
`Where do I download the Pharos Skill Engine package pharos-skill-engine-0.1.0.zip?`

> A **skill** is a folder of files that teaches the agent how to handle a specific capability or task.

> 1. Unzip the Skill Engine package and enter its folder:

> The [Pharos Skill Engine](/tooling-and-infrastructure/pharos-skill-engine-guide) shows how to unzip `pharos-skill-engine-0.1.0.zip`, but it doesn’t specify where to download it. I cannot find a download link in the docs.

Result: I understood the concept and the layout (`SKILL.md` plus `references/`), but I could not install it: step 1 of the install
is "unzip the package" and no answer says where the package is. **Gap 3.** Not done.

### 6. Chain MCP on Atlantic testnet
Queries (#7, #8): `How do I point the Pharos MCP server at Atlantic testnet instead of mainnet?` and
`Where do I get the pharos-mcp source or package to self-host it? What is the npm package name or git repository?`

> The hosted MCP endpoint is configured for mainnet. To use Atlantic Testnet, run a self-hosted Pharos MCP server and set its RPC URL and chain ID to Atlantic’s values.

> The source repository is [PharosNetwork/pharos-mcp](https://github.com/PharosNetwork/pharos-mcp). The docs don’t specify an npm package name; self-host from the Git repository:

Result: worked. I cloned the repository, ran `npm install` and `npm run build` (both exit 0, HEAD `9a3750c`, [`proof/commands.txt`](proof/commands.txt)), and started the built
`dist/src/index.js` over stdio with the RPC URL and chain ID from #7. One deviation, on purpose: #7's config sets `PHAROS_NATIVE_SYMBOL`
to `PROS`, but step 7 below showed Atlantic's native token is `PHRS`, so I set `PHRS`. **Gap 4.** The answer also had to be asked twice
(#7 then #8) because the first one used a path (`/absolute/path/to/pharos-mcp/...`) without saying where that comes from.

### 7. Native token and a first contract read
Queries (#9, #10): `What is the native token symbol of Atlantic testnet, PHRS or PROS?` and
`What are the canonical contract addresses on Pharos mainnet, for example WPROS?`

> **PHRS** is Atlantic Testnet’s native token symbol. The Atlantic configuration sets `nativeCurrency.symbol` to `PHRS`; **PROS** appears in validator staking amounts.

> * **WPROS** — `0x52c48d4213107b20bc583832b0d951fb9ca8f0b0`

Result: worked. With the address from #10, `npm run docs-onboarding:first-read` read WPROS through the hosted Chain MCP: name
`Wrapped PROS`, symbol `WPROS`, decimals 18, at mainnet block 20526425 ([`proof/first-read.json`](proof/first-read.json), `meta.git.dirty`
false). The same run asked the self-hosted Atlantic server (chain 688689) for the balance of the test wallet, which returned `PHRS`.

### 8. First transaction
Query (#11): `How do I send my first PHRS transfer on Atlantic testnet from the command line?`

> `cast send` prints the transaction details, including its hash. View the transaction on [Atlantic PharosScan](https://atlantic.pharosscan.xyz/). The [Pharos Skill Engine](/tooling-and-infrastructure/pharos-skill-engine-guide) also documents native PHRS transfers with `cast`.

Result: worked exactly as written. I ran `cast send <recipient> --value 0.01ether` (0.01 instead of the docs' 0.1) to a second test wallet
(distinct from the sender): tx
[`0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88`](https://atlantic.pharosscan.xyz/tx/0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88),
block 31557251, status 1 (success), gas used 21000 ([`proof/first-tx.txt`](proof/first-tx.txt)). I then read the receipt back through the
self-hosted Chain MCP (`get_transaction_receipt`: status `0x1`, block `0x1e18683`).

### 9. Logging in to ai.pharos.xyz
Queries (#12, #13): `How do I connect my wallet to ai.pharos.xyz and log in?` and `searchDocumentation: ai.pharos.xyz`

> I cannot find app-specific instructions for connecting a wallet or logging in to **ai.pharos.xyz**. The Pharos [Wallet](/tooling-and-infrastructure/wallets) confirms wallets can connect to decentralized applications, but doesn’t document this site’s sign-in flow.

Result: confirmation of gap 1; the search returned the Pharos MCP page and the SkillEngine page, neither about the site. The
login itself needs a browser wallet, so it is logged as "needs a browser wallet login" and left to the human; it was **not** done.

## Gaps and suggested fixes

| # | Gap | Exact query | Why it hurts | What the docs should say |
|---|---|---|---|---|
| 1 | **Missing:** `ai.pharos.xyz` is not found by the Docs MCP: neither questions nor a plain search turn up the site (#1, #12, #13). | `What is ai.pharos.xyz and how do I get started with it?` | The task's own entry point is undocumented, so an agent that follows the rules cannot onboard to it. | A page "ai.pharos.xyz" in Getting Started: what the site is, how it relates to Anvita Flow, the sign-in flow (which wallet, which network), and the first thing to do after login. |
| 2 | **Missing:** no faucet URL or claim steps (#3). #11 also says "Get testnet PHRS from the faucet" with no link. | `Where is the faucet for Atlantic testnet PHRS and how do I claim tokens?` | Every other step needs PHRS, so this is the real blocker for a newcomer. | On the Atlantic Testnet page: the faucet URL, the amount per claim, the cooldown, whether a login is needed, and the contact for "directly from the team". |
| 3 | **Missing:** the SkillEngine install starts with "unzip `pharos-skill-engine-0.1.0.zip`" but no page says where to download it (#6). | `Where do I download the Pharos Skill Engine package pharos-skill-engine-0.1.0.zip?` | The install cannot be completed from the docs. | A download link or `git clone` URL (and the version/commit) at the top of the Skill Engine page, plus a checksum. |
| 4 | **Wrong/inconsistent:** the Atlantic MCP config example sets `PHAROS_NATIVE_SYMBOL` to `PROS` (#7) while Atlantic's native token is `PHRS` (#9); the Pharos MCP page lists "Native token PROS" (#13) without saying it is mainnet-only. | `How do I point the Pharos MCP server at Atlantic testnet instead of mainnet?` | A copy-pasted config labels balances with the wrong symbol. | Use `PHRS` in the Atlantic example, and label the "Native token" row on the MCP page as "PROS (mainnet) / PHRS (Atlantic)". |
| 5 | **Missing:** the add-network answer gives no currency symbol (#2), and wallets require one. | `How do I set up a wallet and add the Atlantic testnet network?` | A wallet's "Add network" form has a mandatory symbol field. | Add `Currency symbol: PHRS (18 decimals)` to the network table of the Atlantic Testnet page. |

Smaller friction: the testnet MCP answer used `/absolute/path/to/pharos-mcp/...` and only a second question (#8) revealed it is built from
the GitHub repository, so the MCP page should link the repository and the `npm install && npm run build` steps next to the config.

## What was built and run by the end

- Hosted Chain MCP: health check OK, and a real read of WPROS at mainnet block 20526425 ([`proof/first-read.json`](proof/first-read.json)).
- Self-hosted `pharos-mcp` built from the repository (HEAD `9a3750c`) and pointed at Atlantic (chain 688689): chain ID and balance read.
- A first transaction on Atlantic, [`0x01cd6b78…fe88`](https://atlantic.pharosscan.xyz/tx/0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88), status success.
- The [Doc-Search CLI](../doc-search-cli/README.md), a small `pharos-docs` tool built on the same Docs MCP, to make this kind of query a one-liner.

**Not done:** logging in to ai.pharos.xyz and adding the network to a browser wallet (need a human with a wallet), claiming from the faucet (no
URL in the docs), installing the SkillEngine package (no download link in the docs).

## Reproduce

```bash
npm ci
npm run docs-onboarding -- ask "How do I set up a wallet and add the Atlantic testnet network?"   # appends to proof/transcript.jsonl
npm run docs-onboarding:render                                                                      # rewrites proof/transcript.md
npm run docs-onboarding:first-read                                                                  # hosted Chain MCP read (keyless)
```
