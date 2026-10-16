# Beacon

Agent tools for **Pharos**, built task by task for the Pharos Season of AI Agent Arena.
The tasks share one toolkit: the Pharos Chain MCP for every condition read, viem for local signing, and chain
constants copied from SkillEngine's `assets/`. The repo also ships a tested client for the Developer Docs MCP
(`src/lib/docs-mcp.ts`); no task depends on it yet. Each task lives in its own folder under `tasks/`; tasks that ship
as agent skills also have a folder under `skills/`.

## Tasks

| Task | Tier | What | Proof |
|---|---|---|---|
| [Threshold Guardian](tasks/threshold-guardian/) | Medium | Checks N onchain conditions through Chain MCP and acts only if all pass. Fails closed and re-checks before sending. Also packaged as a [SkillEngine-format skill](skills/threshold-guardian/SKILL.md) | [Atlantic tx](https://atlantic.pharosscan.xyz/tx/0xd567073eaa5d89eb5e30c3e3efa2948818851648fe628d93ff6fa29074dfbf39) · [proof/](tasks/threshold-guardian/proof/) |

## Quick start

```bash
npm install
npm test            # 109 unit tests (policy validation, MCP tool mapping, guard outcomes, Docs MCP client)
npm run guard -- tasks/threshold-guardian/policies/wpros-watch.json   # mainnet via hosted Chain MCP, read-only, no key needed
npm run setup:mcp   # builds the sponsor Chain MCP server locally for Atlantic testnet reads (pinned commit)
npm run smoke       # hosted Chain MCP tool list + chain info, Atlantic block (+ wallet balance if PRIVATE_KEY is set)
npm run smoke:docs  # live Developer Docs MCP check: tools/list, a search, a page fetch, a question (keyless)
```

Write operations target **Pharos Atlantic testnet** (chain 688689) and need `PRIVATE_KEY` (see `.env.example`).
It is loaded from `~/.config/pharos/testnet.env` (preferred) or a local `.env` that git ignores, and never committed.
Mainnet (chain 1672) is read-only here.

## Layout

| Path | What |
|---|---|
| `src/lib/mcp.ts` | Chain MCP client: hosted HTTP for mainnet, local stdio server for Atlantic |
| `src/lib/docs-mcp.ts` | Developer Docs MCP client: `tools/list`, `searchDocumentation`, `getPage`, `askQuestion`, with timeouts and retries |
| `src/lib/chain.ts` | viem clients for testnet + mainnet, signing wallet |
| `src/lib/networks.ts` | chain definitions + known token addresses (from SkillEngine `assets/`) |
| `src/guardian/` | Threshold Guardian: policy schema, MCP reader, evaluator, guard |
| `skills/<name>/` | agent skills in SkillEngine format (`SKILL.md` + `references/`), installable with `npx skills add` |
| `tasks/<slug>/` | one Arena task each: entry point + README + proof |
| `test/` | vitest unit tests |

## License

MIT
