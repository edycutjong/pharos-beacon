## #1 askQuestion · 2026-10-18T01:35:34.421Z

Query: What is ai.pharos.xyz and how do I get started with it?

I can’t find documentation for **ai.pharos.xyz** specifically. The Pharos docs describe **Anvita Flow**, an AI-agent platform, and **Anvita On**, its user-facing chat interface. The docs list `flow.anvita.xyz/agent/chat` as the chat URL, not `ai.pharos.xyz`.

To try the documented chat:

1. Register at [Anvita Flow](https://flow.anvita.xyz/home).
2. Open [Anvita On](https://flow.anvita.xyz/agent/chat) and ask your Steward Agent for a task.
3. To use a particular service, ask the Steward Agent to find that Service Agent and do the task.

Anvita Flow routes requests to published Service Agents in its Marketplace. For developer setup and publishing, see [Anvita Flow](/tooling-and-infrastructure/overview) and [Publish Service Agent](/tooling-and-infrastructure/overview/publish-skill-af).

# Sources

- [x402 Atlantic Testnet](https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet)
- [Node Debugging & Configuration](https://docs.pharos.xyz/node-and-validator-guide/node-debugging-and-configuration)
- [Pharos Network Snapshots](https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots)
- [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)
- [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
- [Goldsky](https://docs.pharos.xyz/tooling-and-infrastructure/indexing/goldsky)
- [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
- [About Pharos](https://docs.pharos.xyz/introduction/readme)
- [Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide)
- [Vision & Mission](https://docs.pharos.xyz/introduction/vision-and-mission)
- [Publish Service Agent](https://docs.pharos.xyz/tooling-and-infrastructure/overview/publish-skill-af)
- [x402](https://docs.pharos.xyz/developer-guide/x402)
- [Get PROS Gas](https://docs.pharos.xyz/getting-started/get-pros-gas)
- [Using Binary](https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment/using-binary-deployment)
- [Using Docker](https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment/using-docker-deployment)
- [Anvita Flow](https://docs.pharos.xyz/tooling-and-infrastructure/overview)

## #2 askQuestion · 2026-10-18T01:35:55.157Z

Query: How do I set up a wallet and add the Atlantic testnet network?

Create an account in an EVM wallet, then add Atlantic Testnet as a custom network:

1. In your wallet, choose **Add network** or **Add a custom network**.
2. Enter these Atlantic settings:
   * **Network name:** Atlantic Testnet
   * **RPC URL:** `https://atlantic.dplabs-internal.com`
   * **Chain ID:** `688689`
   * **Block explorer:** `https://atlantic.pharosscan.xyz/`
3. Save the network and switch to it.

The network reference doesn’t specify a currency-symbol field. See [Atlantic Testnet](/getting-started/network/atlantic-testnet). For wallet options, see [Wallet](/tooling-and-infrastructure/wallets).

# Sources

- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)
- [Node Management](https://docs.pharos.xyz/node-and-validator-guide/node-management)
- [Wallet](https://docs.pharos.xyz/tooling-and-infrastructure/wallets)
- [Canonical Contracts](https://docs.pharos.xyz/getting-started/canonical-contracts)
- [Pharos Network Snapshots](https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots)
- [Network](https://docs.pharos.xyz/getting-started/network)
- [Token Registry](https://docs.pharos.xyz/getting-started/token-registry)
- [ZAN RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan)
- [Rust](https://docs.pharos.xyz/developer-guide/rust)
- [Get PROS Gas](https://docs.pharos.xyz/getting-started/get-pros-gas)
- [Write Your First NFT](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-nft)
- [Write Your First Token](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-token)
- [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)

## #3 askQuestion · 2026-10-18T01:36:13.988Z

Query: Where is the faucet for Atlantic testnet PHRS and how do I claim tokens?

The docs don’t provide a faucet URL or claim steps. They only say to get Atlantic testnet PHRS from the **Pharos faucet or directly from the team**.

Atlantic Testnet uses chain ID `688689`, RPC `https://atlantic.dplabs-internal.com`, and PHRS as its native token. See [Atlantic Testnet](/getting-started/network/atlantic-testnet).

# Sources

- [Token Registry](https://docs.pharos.xyz/getting-started/token-registry)
- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)
- [Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide)
- [x402 Atlantic Testnet](https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet)
- [Pharos Network Snapshots](https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots)
- [ZAN RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan)
- [Network](https://docs.pharos.xyz/getting-started/network)
- [Write Your First Token](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-token)
- [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)
- [Node Management](https://docs.pharos.xyz/node-and-validator-guide/node-management)
- [Write Your First Token](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token)
- [Write Your First NFT](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-nft)
- [Rust](https://docs.pharos.xyz/developer-guide/rust)
- [Pharos Testnet: Rebuild Node with Preserved Node Info](https://docs.pharos.xyz/pharos-testnet-rebuild-node-with-preserved-node-info)
- [Get PROS Gas](https://docs.pharos.xyz/getting-started/get-pros-gas)
- [Hardhat](https://docs.pharos.xyz/developer-guide/hardhat)
- [Foundry](https://docs.pharos.xyz/developer-guide/foundry)

## #4 askQuestion · 2026-10-18T01:36:27.087Z

Query: How do I set up the Pharos Chain MCP server so my AI agent can read the chain? Give the exact install command and config.

For read access, use the hosted Pharos MCP server. It needs no API key. Add this to your agent’s MCP configuration:

```json
{
  "mcpServers": {
    "pharos": {
      "type": "http",
      "url": "https://mcp.pharos.xyz/mcp"
    }
  }
}
```

If your agent only supports **stdio** servers, use `mcp-remote` as a bridge. The exact command is:

```bash
npx -y mcp-remote https://mcp.pharos.xyz/mcp
```

Configure it like this:

```json
{
  "mcpServers": {
    "pharos": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.pharos.xyz/mcp"]
    }
  }
}
```

The server connects to Pharos mainnet (chain ID `1672`) and exposes read tools for blocks, balances, transactions, contracts, and logs. Verify availability with:

```bash
curl https://mcp.pharos.xyz/health
```

See [Pharos MCP](/tooling-and-infrastructure/mcp) for the supported tools and configuration details.

# Sources

- [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
- [x402 Atlantic Testnet](https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet)
- [x402 Pacific Mainnet](https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet)
- [Node Debugging & Configuration](https://docs.pharos.xyz/node-and-validator-guide/node-debugging-and-configuration)
- [Cross Chain Infrastructure](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain)
- [x402](https://docs.pharos.xyz/developer-guide/x402)
- [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
- [About Pharos](https://docs.pharos.xyz/introduction/readme)
- [Fordefi](https://docs.pharos.xyz/tooling-and-infrastructure/wallets/fordefi)
- [Why Pharos](https://docs.pharos.xyz/introduction/why-pharos)

## #5 askQuestion · 2026-10-18T01:36:39.129Z

Query: How do I install and use the Pharos SkillEngine and what is a skill?

The **Pharos Skill Engine** is a package of instructions, network settings, templates, and CLI references that helps an AI agent perform Pharos blockchain tasks. A **skill** is a folder of files that teaches the agent how to handle a specific capability or task.

### Install and start using it

1. Unzip the Skill Engine package and enter its folder:

   ```bash
   unzip pharos-skill-engine-0.1.0.zip
   cd pharos-skill-engine-0.1.0
   ```
2. Install Foundry if needed, then verify `cast` and `forge` are available:

   ```bash
   curl -L https://foundry.paradigm.xyz | bash
   source ~/.zshenv && foundryup
   cast --version
   forge --version
   ```
3. Set your private key as an environment variable. **Never paste it into a script or commit it to git.**

   ```bash
   export PRIVATE_KEY=0xYOUR_PRIVATE_KEY
   ```
4. Give the package to an AI agent, such as Claude, or run the documented `cast` and `forge` commands yourself. The agent reads `SKILL.md` to find a capability, then follows the matching instructions in `references/`. For example, you can ask it to check a balance, send PHRS, or deploy a contract.

For write operations, pass the key explicitly as `--private-key $PRIVATE_KEY`, and specify the network with `--rpc-url`. The engine does not automatically read the key from your environment.

See the [Pharos Skill Engine](/tooling-and-infrastructure/pharos-skill-engine-guide) for setup and usage. The [Piggy Bank Tutorial](/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide) shows how to add a custom skill for deploying and using a time-locked vault.

# Sources

- [Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide)
- [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
- [Publish Service Agent](https://docs.pharos.xyz/tooling-and-infrastructure/overview/publish-skill-af)
- [Anvita Flow](https://docs.pharos.xyz/tooling-and-infrastructure/overview)
- [Write Your First dApp](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-dapp)
- [Rapid Node Initialization(Devnet)](https://docs.pharos.xyz/node-and-validator-guide/rapid-node-initialization/rapid-node-initialization-devnet)
- [x402 Pacific Mainnet](https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet)
- [x402 Atlantic Testnet](https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet)
- [Validator Node Deployment](https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment)
- [About Pharos](https://docs.pharos.xyz/introduction/readme)

## #6 askQuestion · 2026-10-18T01:37:02.879Z

Query: Where do I download the Pharos Skill Engine package pharos-skill-engine-0.1.0.zip?

The [Pharos Skill Engine](/tooling-and-infrastructure/pharos-skill-engine-guide) shows how to unzip `pharos-skill-engine-0.1.0.zip`, but it doesn’t specify where to download it. I cannot find a download link in the docs.

# Sources

- [x402 Atlantic Testnet](https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet)
- [x402 Pacific Mainnet](https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet)
- [Validator Node Deployment](https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment)
- [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)
- [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
- [Publish Service Agent](https://docs.pharos.xyz/tooling-and-infrastructure/overview/publish-skill-af)
- [Chainlink Push Engine Feeds](https://docs.pharos.xyz/tooling-and-infrastructure/oracles/chainlink-pe)
- [Rapid Node Initialization(Testnet)](https://docs.pharos.xyz/node-and-validator-guide/rapid-node-initialization/rapid-node-initialization-testnet)
- [Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide)
- [Enable AutoPruning in Pharos Node](https://docs.pharos.xyz/enable-pruning-in-pharos-node)
- [Using Binary](https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment/using-binary-deployment)
- [Rapid Node Initialization(Devnet)](https://docs.pharos.xyz/node-and-validator-guide/rapid-node-initialization/rapid-node-initialization-devnet)
- [Pharos Network Snapshots](https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots)

## #7 askQuestion · 2026-10-18T01:37:15.742Z

Query: How do I point the Pharos MCP server at Atlantic testnet instead of mainnet?

The hosted MCP endpoint is configured for mainnet. To use Atlantic Testnet, run a self-hosted Pharos MCP server and set its RPC URL and chain ID to Atlantic’s values.

```json
{
  "mcpServers": {
    "pharos": {
      "command": "node",
      "args": ["/absolute/path/to/pharos-mcp/dist/src/index.js"],
      "env": {
        "PHAROS_RPC_URL": "https://atlantic.dplabs-internal.com",
        "PHAROS_CHAIN_ID": "688689",
        "PHAROS_NATIVE_SYMBOL": "PROS"
      }
    }
  }
}
```

The Atlantic RPC is `https://atlantic.dplabs-internal.com`, and its chain ID is `688689`. The MCP server’s default values (`https://rpc.pharos.xyz` and `1672`) point to mainnet. See [Pharos MCP](/tooling-and-infrastructure/mcp) and [Atlantic Testnet](/getting-started/network/atlantic-testnet).

# Sources

- [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)
- [Pharos Network Snapshots](https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots)
- [ZAN RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan)
- [Network](https://docs.pharos.xyz/getting-started/network)
- [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)
- [x402 Atlantic Testnet](https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet)
- [Node Management](https://docs.pharos.xyz/node-and-validator-guide/node-management)
- [Pharos Testnet: Rebuild Node with Preserved Node Info](https://docs.pharos.xyz/pharos-testnet-rebuild-node-with-preserved-node-info)
- [Node Debugging & Configuration](https://docs.pharos.xyz/node-and-validator-guide/node-debugging-and-configuration)

## #8 askQuestion · 2026-10-18T01:37:34.558Z

Query: Where do I get the pharos-mcp source or package to self-host it? What is the npm package name or git repository?

The source repository is [PharosNetwork/pharos-mcp](https://github.com/PharosNetwork/pharos-mcp). The docs don’t specify an npm package name; self-host from the Git repository:

```bash
git clone https://github.com/PharosNetwork/pharos-mcp.git
cd pharos-mcp
npm install
npm run build
npm start
```

You’ll need Node.js 20 or newer. See the [Pharos MCP](/tooling-and-infrastructure/mcp) for configuration and Docker options.

# Sources

- [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
- [About Pharos](https://docs.pharos.xyz/introduction/readme)
- [Node Debugging & Configuration](https://docs.pharos.xyz/node-and-validator-guide/node-debugging-and-configuration)
- [Pharos Node Monitoring](https://docs.pharos.xyz/pharos-node-monitoring)
- [Pharos Network Snapshots](https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots)
- [x402 Atlantic Testnet](https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet)
- [x402 Pacific Mainnet](https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet)
- [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)
- [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
- [Why Pharos](https://docs.pharos.xyz/introduction/why-pharos)

## #9 askQuestion · 2026-10-18T01:37:43.083Z

Query: What is the native token symbol of Atlantic testnet, PHRS or PROS?

**PHRS** is Atlantic Testnet’s native token symbol. The Atlantic configuration sets `nativeCurrency.symbol` to `PHRS`; **PROS** appears in validator staking amounts. See [x402 Atlantic Testnet](/developer-guide/x402/x402-atlantic-testnet) and [Node Management](/node-and-validator-guide/node-management).

# Sources

- [Token Registry](https://docs.pharos.xyz/getting-started/token-registry)
- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)
- [x402 Atlantic Testnet](https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet)
- [Write Your First Token](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token)
- [Node Management](https://docs.pharos.xyz/node-and-validator-guide/node-management)
- [Write Your First Token](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-token)
- [Write Your First NFT](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-nft)
- [Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide)
- [Rapid Node Initialization(Testnet)](https://docs.pharos.xyz/node-and-validator-guide/rapid-node-initialization/rapid-node-initialization-testnet)
- [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)

## #10 askQuestion · 2026-10-18T01:37:52.925Z

Query: What are the canonical contract addresses on Pharos mainnet, for example WPROS?

Pharos **Pacific Mainnet** uses chain ID `1672`. The token registry lists these mainnet addresses:

* **WPROS** — `0x52c48d4213107b20bc583832b0d951fb9ca8f0b0`
* **USDC (Circle-deployed)** — `0xc879c018db60520f4355c26ed1a6d572cdac1815`
* **LINK** — `0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29`
* **WETH** — `0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9`

For infrastructure contracts, the [Canonical Contracts](/getting-started/canonical-contracts) includes, for example, **MultiCall3** at `0xcA11bde05977b3631167028862bE2a173976CA11` and **Permit2** at `0x000000000022D473030F116dDEE9F6B43aC78BA3`.

See the full [Token Registry](/getting-started/token-registry) for token details.

# Sources

- [Canonical Contracts](https://docs.pharos.xyz/getting-started/canonical-contracts)
- [Pacific Mainnet](https://docs.pharos.xyz/getting-started/network/pacific-mainnet)
- [Token Registry](https://docs.pharos.xyz/getting-started/token-registry)
- [Get PROS Gas](https://docs.pharos.xyz/getting-started/get-pros-gas)
- [Circle CCTP](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/circle-cctp)
- [x402 Pacific Mainnet](https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet)
- [Write Your First Uniswap Contract](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-uniswap-contract)
- [Write Your First Uniswap Contract](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-uniswap-contract)
- [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
- [Pharos Network Snapshots](https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots)

## #11 askQuestion · 2026-10-18T01:38:38.555Z

Query: How do I send my first PHRS transfer on Atlantic testnet from the command line?

Use Foundry’s `cast` to send native PHRS. Atlantic Testnet uses RPC `https://atlantic.dplabs-internal.com` and chain ID `688689`. See [Atlantic Testnet](/getting-started/network/atlantic-testnet).

1. Set your private key in the terminal. Don’t paste it into shared commands or commit it to a file.

   ```sh
   export PRIVATE_KEY=0xYOUR_PRIVATE_KEY
   export RPC=https://atlantic.dplabs-internal.com
   ```
2. Check the sending wallet’s address and PHRS balance:

   ```sh
   cast wallet address --private-key "$PRIVATE_KEY"
   cast balance YOUR_SENDER_ADDRESS --rpc-url "$RPC" --ether
   ```

   You need testnet PHRS for the transfer and transaction fees. Get testnet PHRS from the faucet.
3. Send `0.1` PHRS, replacing the recipient:

   ```sh
   cast send 0xRECIPIENT_ADDRESS \
     --value 0.1ether \
     --private-key "$PRIVATE_KEY" \
     --rpc-url "$RPC"
   ```

`cast send` prints the transaction details, including its hash. View the transaction on [Atlantic PharosScan](https://atlantic.pharosscan.xyz/). The [Pharos Skill Engine](/tooling-and-infrastructure/pharos-skill-engine-guide) also documents native PHRS transfers with `cast`.

# Sources

- [Network](https://docs.pharos.xyz/getting-started/network)
- [Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)
- [x402 Atlantic Testnet](https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet)
- [Node Management](https://docs.pharos.xyz/node-and-validator-guide/node-management)
- [Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide)
- [Rapid Node Initialization(Testnet)](https://docs.pharos.xyz/node-and-validator-guide/rapid-node-initialization/rapid-node-initialization-testnet)
- [Token Registry](https://docs.pharos.xyz/getting-started/token-registry)
- [Write Your First Token](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token)
- [Write Your First Token](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-token)
- [Write Your First NFT](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-nft)
- [Pharos Skill Engine](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide)
- [Pharos Network Snapshots](https://docs.pharos.xyz/node-and-validator-guide/pharos-network-snapshots)
- [ZAN RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan)
- [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)

## #12 askQuestion · 2026-10-18T01:38:55.086Z

Query: How do I connect my wallet to ai.pharos.xyz and log in?

I cannot find app-specific instructions for connecting a wallet or logging in to **ai.pharos.xyz**. The Pharos [Wallet](/tooling-and-infrastructure/wallets) confirms wallets can connect to decentralized applications, but doesn’t document this site’s sign-in flow.

Only approve a connection or signature request you understand. Never enter your seed phrase or private key into the site.

# Sources

- [Wallet](https://docs.pharos.xyz/tooling-and-infrastructure/wallets)
- [Node Debugging & Configuration](https://docs.pharos.xyz/node-and-validator-guide/node-debugging-and-configuration)
- [Get PROS Gas](https://docs.pharos.xyz/getting-started/get-pros-gas)
- [Hardhat](https://docs.pharos.xyz/developer-guide/hardhat)
- [Foundry](https://docs.pharos.xyz/developer-guide/foundry)
- [ZAN RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/zan)
- [Safe MultiSig](https://docs.pharos.xyz/tooling-and-infrastructure/wallets/safe)
- [Fordefi](https://docs.pharos.xyz/tooling-and-infrastructure/wallets/fordefi)
- [Alchemy RPC](https://docs.pharos.xyz/tooling-and-infrastructure/rpc/alchemy)
- [Pharos MCP](https://docs.pharos.xyz/tooling-and-infrastructure/mcp)
- [Write Your First dApp](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp)
- [Write Your First dApp](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-dapp)

## #13 searchDocumentation · 2026-10-18T01:39:06.975Z

Query: ai.pharos.xyz

Title: Pharos MCP
Link: https://docs.pharos.xyz/tooling-and-infrastructure/mcp
Content: The Pharos MCP server brings Pharos chain data and onchain operations into any client that speaks the Model Context Protocol — Claude Desktop, Cursor, Windsurf, Codex, and custom agent runners.

Instead of writing RPC plumbing, you ask your AI assistant in plain language — "what's the latest Pharos block?", "check the PROS balance of 0x…" — and it calls the right chain method for you.

Hosted endpoint
https://mcp.pharos.xyz/mcp
Transport
Streamable HTTP
Authentication
None — public
Rate limit
120 requests per minute per IP
Chain ID
1672 (0x688)
Native token
PROS
Source
github.com/PharosNetwork/pharos-mcp

Title: Pharos Skill Engine
Link: https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide
Content: # ── SETUP ──────────────────────────────────────────────────────────
curl -L https://foundry.paradigm.xyz | bash && source ~/.zshenv && foundryup
export PRIVATE_KEY=0x...
export RPC=https://atlantic.dplabs-internal.com
export DEPLOYER=$(cast wallet address --private-key $PRIVATE_KEY)
# ── QUERY (free — no gas) ──────────────────────────────────────────
cast balance $DEPLOYER --rpc-url $RPC --ether
cast call <token> "balanceOf(address)(uint256)" $DEPLOYER --rpc-url $RPC
cast tx <tx_hash> --rpc-url $RPC
cast receipt <tx_hash> --rpc-url $RPC
cast call <contract> "<method()(<returns>)>" --rpc-url $RPC
# ── TRANSACTIONS ───────────────────────────────────────────────────
cast send <to> --value 0.1ether --private-key $PRIVATE_KEY --rpc-url $RPC
cast send <contract> "<method(type)>" <arg> --private-key $PRIVATE_KEY --rpc-url $RPC
cast send <contract> "<payable()>" --value 0.01ether --private-key $PRIVATE_KEY --rpc-url $RPC
# ── GAS ────────────────────────────────────────────────────────────
cast estimate <to> --value 0.1ether --rpc-url $RPC
cast gas-price --rpc-url $RPC
# ── DEPLOY ─────────────────────────────────────────────────────────
forge script script/Deploy<Name>.s.sol:<Name> \
  --rpc-url $RPC --private-key $PRIVATE_KEY --broadcast
# ── VERIFY ─────────────────────────────────────────────────────────
sleep 10
forge verify-contract <addr> src/<path>:<Name> \
  --chain-id 688689 \
  --verifier-url https://api.socialscan.io/pharos-atlantic-testnet/v1/explorer/command_api/contract \
  --verifier blockscout
# ── EVENTS ─────────────────────────────────────────────────────────
cast logs --from-block 0 --address <contract> "<Event(types)>" --rpc-url $RPC
# ── AIRDROP (large scale) ──────────────────────────────────────────
CSV_PATH=airdrop.csv BATCH_SIZE=200 \
  forge script assets/airdrop/BatchAirdrop.s.sol:BatchAirdrop \
  --rpc-url $RPC --private-key $PRIVATE_KEY --broadcast

Title: About Pharos
Link: https://docs.pharos.xyz/introduction/readme
Content: Pharos has designed a Modular & Full-stack Parallel L1 Blockchain Network, structured into three primary layers: L1-Base, L1-Core, and L1-Extension.

L1-Base: Delivers industry-leading data availability and hardware acceleration.
L1-Core: A high-performance, globally distributed blockchain network powered by decentralized nodes. These nodes provide high-throughput and sub-second finality, enabling real-time Web3 user experiences.
L1-Extension: Built on top of L1-Core, this layer supports network expansion across three dimensions:
Leverages heterogeneous computation to create custom Special Processing Networks (SPNs), capable of running blockchain networks, sidechains, or non-blockchain applications like HFT, ZKML, and AI models.
Enables Native Restaking to support rapid SPN creation, shared security, staking rewards, and slashing mechanisms. SPNs utilize the excess computing power of validators, providing flexibility in resource use while incentivizing upgrades.
Facilitates Cross-SPNs Interoperation, allowing infrastructure, middleware, and application-focused SPNs to communicate and collaborate effortlessly, fostering a highly modular and composable ecosystem.

Title: Piggy Bank Tutorial
Link: https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide
Content: A Pharos Skill is a folder of files that teaches an AI (Claude) how to interact with the Pharos blockchain. When you ask the AI something like "Deploy a vault on Pharos", it reads your skill files to know exactly which commands to run.

The AI is smart but it does not automatically know your contract. You teach it by writing instruction files in plain Markdown. The AI reads those files and follows them precisely.

Title: Circle CCTP
Link: https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/circle-cctp
Content: The relationship between CCTP’s onchain components and Circle’s offchain Attestation Service is illustrated below for a burn-and-mint of USDC between EVM-compatible domains:

On Pharos, the onchain component for crosschain burning and minting is called TokenMessengerV2, which is built on top of MessageTransmitterV2, an onchain component for generalized message passing.

In the diagram, a token depositor calls the TokenMessengerV2#depositForBurn function to deposit a native token (such as USDC), which delegates to the TokenMinterV2 contract to burn the token. The TokenMessengerV2 contract then sends a message via the MessageTransmitterV2#sendMessage function. After sufficient block confirmations, Circle’s offchain attestation service, Iris, signs the message. An API consumer must query this attestation and submits it onchain to the destination domain’s MessageTransmitterV2#receiveMessage function.

To send an arbitrary message, directly call MessageTransmitterV2#sendMessage. The message recipient must implement the following methods to handle messages based on their finality threshold:

Implement IMessageHandlerV2#handleReceiveFinalizedMessage to receive messages with finalityThresholdExecuted ≥ 2000.
Implement IMessageHandlerV2#handleReceiveUnfinalizedMessage to receive messages with finalityThresholdExecuted < 2000.

This distinction allows the recipient to control the level of finality it requires before accepting a message.

Title: Node Debugging & Configuration
Link: https://docs.pharos.xyz/node-and-validator-guide/node-debugging-and-configuration
Content: You can refer to the Pharos Block Validation document for details on the Pharos consensus mechanism and block validation process.

Title: Fordefi
Link: https://docs.pharos.xyz/tooling-and-infrastructure/wallets/fordefi
Content: Pharos can be enabled directly within the Fordefi platform from the Chains settings:

https://app.fordefi.com/settings/chains?search=PHAROS&page=1

Title: Rapid Node Initialization
Link: https://docs.pharos.xyz/node-and-validator-guide/rapid-node-initialization
Content: Atlantic

Title: JSON-RPC API Methods
Link: https://docs.pharos.xyz/api-and-sdk/json-rpc-methods
Content: These are Pharos-specific debug methods that extend the standard debug namespace.

Title: Validator Node Deployment
Link: https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment
Content: Before running a Validator Node or Validator Full Node (VFN) on the Pharos Network, you must choose a deployment method and ensure your machine meets the required specifications.

This guide provides clear instructions for deploying nodes using different methods. Once deployed, you can connect your node to the Pharos network and begin participating in consensus or network operations.

📘 Note: Please review the Node Requirements before choosing a deployment method.
