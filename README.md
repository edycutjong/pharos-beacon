# Beacon

Agent tools for **Pharos**, built task by task for the Pharos Season of AI Agent Arena.
The tasks share one toolkit: the Pharos Chain MCP for every onchain read, viem for local signing, and network
config from SkillEngine. Each task lives in its own folder under `tasks/`.

## Tasks

| Task | Tier | What | Proof |
|---|---|---|---|
| [Threshold Guardian](tasks/threshold-guardian/) | Medium | Checks N onchain conditions through Chain MCP and acts only if all pass. Fails closed and re-checks before sending | [Atlantic tx](https://atlantic.pharosscan.xyz/tx/0x0fda4e6f656566e65b2067d0d34492bb49449b873f7faa3bb8eda9f0daea5b50) · [proof/](tasks/threshold-guardian/proof/) |

## Quick start

```bash
npm install
npm run setup:mcp   # builds the sponsor Chain MCP server locally for Atlantic testnet reads (pinned commit)
npm run smoke       # hosted Chain MCP tools + mainnet chain info, testnet block, wallet balance
npm test            # 31 unit tests (policy validation, MCP tool mapping, guard outcomes)
npm run guard -- tasks/threshold-guardian/policies/wpros-watch.json   # mainnet, read-only, no key needed
```

Write operations target **Pharos Atlantic testnet** (chain 688689) and need `PRIVATE_KEY` (see `.env.example`;
loaded from `~/.config/pharos/testnet.env`, never from the repo). Mainnet (chain 1672) is read-only here.

## Layout

| Path | What |
|---|---|
| `src/lib/mcp.ts` | Chain MCP client: hosted HTTP for mainnet, local stdio server for Atlantic |
| `src/lib/chain.ts` | viem clients for testnet + mainnet, signing wallet |
| `src/lib/networks.ts` | chain definitions + known token addresses (from SkillEngine `assets/`) |
| `src/guardian/` | Threshold Guardian: policy schema, MCP reader, evaluator, guard |
| `tasks/<slug>/` | one Arena task each: entry point + README + proof |
| `test/` | vitest unit tests |

## License

MIT
