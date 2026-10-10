# Beacon

Agent tools for **Pharos**, built task by task for the Pharos Season of AI Agent Arena.
The tasks share one toolkit: the Pharos Chain MCP for every condition read, viem for local signing, and chain
constants copied from SkillEngine's `assets/`. Each task lives in its own folder under `tasks/`.

## Tasks

| Task | Tier | What | Proof |
|---|---|---|---|
| [Threshold Guardian](tasks/threshold-guardian/) | Medium | Checks N onchain conditions through Chain MCP and acts only if all pass. Fails closed and re-checks before sending | [Atlantic tx](https://atlantic.pharosscan.xyz/tx/0xfa437f21fb7dd6ef66f5915ce4cff7f7e032cf110d709b79f5d52ad64deddff8) · [proof/](tasks/threshold-guardian/proof/) |

## Quick start

```bash
npm install
npm test            # 38 unit tests (policy validation, MCP tool mapping, guard outcomes)
npm run guard -- tasks/threshold-guardian/policies/wpros-watch.json   # mainnet via hosted Chain MCP, read-only, no key needed
npm run setup:mcp   # builds the sponsor Chain MCP server locally for Atlantic testnet reads (pinned commit)
npm run smoke       # hosted Chain MCP tool list + chain info, Atlantic block (+ wallet balance if PRIVATE_KEY is set)
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
