# Beacon

Agent tools for **Pharos**, built task by task for the Pharos Season of AI Agent Arena.
The tasks share one toolkit in `src/lib/`: a Pharos Chain MCP client that checks which chain it is talking to,
paces itself under the hosted server's rate limit and retries only safe reads; a testnet signer for which the Chain MCP
prepares, broadcasts and confirms every transaction while viem only signs; a proof writer, a CLI runner and crash-safe
state files; and chain constants copied from SkillEngine's `assets/`. The repo also ships a tested client for the
Developer Docs MCP (`src/lib/docs-mcp.ts`); no task depends on it yet. Each task lives in its own folder under
`tasks/`; tasks that ship as agent skills also have a folder under `skills/`.

## Tasks

| Task | Tier | What | Proof |
|---|---|---|---|
| [Threshold Guardian](tasks/threshold-guardian/) | Medium | Checks N onchain conditions through Chain MCP and acts only if all pass. Fails closed and re-checks before sending. Also packaged as a [SkillEngine-format skill](skills/threshold-guardian/SKILL.md) | [Atlantic tx](https://atlantic.pharosscan.xyz/tx/0xd567073eaa5d89eb5e30c3e3efa2948818851648fe628d93ff6fa29074dfbf39) · [proof/](tasks/threshold-guardian/proof/) |

## Quick start

```bash
npm install
npm test            # 169 tests: guardian (policy, reader, guard), Chain MCP and Docs MCP clients, signer, shared helpers
npm run guard -- tasks/threshold-guardian/policies/wpros-watch.json   # mainnet via hosted Chain MCP, read-only, no key needed
npm run setup:mcp   # builds the sponsor Chain MCP server locally for Atlantic testnet reads (pinned commit)
npm run smoke       # hosted Chain MCP tool list + chain info, Atlantic block (+ wallet balance if PRIVATE_KEY is set)
npm run smoke:docs  # live Developer Docs MCP check: tools/list, a search, a page fetch, a question (keyless)
npm run ping        # Atlantic signer check: prepare via Chain MCP + sign locally; --execute sends 0 PHRS to itself
```

Write operations target **Pharos Atlantic testnet** (chain 688689) and need `PRIVATE_KEY` (see `.env.example`).
It is loaded from `~/.config/pharos/testnet.env` (preferred) or a local `.env` that git ignores, and never committed.
Mainnet (chain 1672) is read-only here.

## Layout

| Path | What |
|---|---|
| `src/lib/mcp.ts` | Chain MCP client: hosted HTTP for mainnet, local stdio server for Atlantic. Checks the chain id at connect, paces tool calls at 100 per minute (the hosted server allows 120 requests per minute per IP), waits out a 429, retries only reads, reconnects a lost session, ends the session on close. Typed tool results; `getLogsRange` for any block range |
| `src/lib/signer.ts` | Atlantic-only signer: nonce, gas and fees read through the Chain MCP, signed locally with viem, broadcast through the Chain MCP, receipt read back through it. The hash is known before sending |
| `src/lib/proof.ts` · `cli.ts` · `state.ts` | proof files stamped with chain, endpoint, server version and commit · task CLI runner (flags, exit codes, cleanup) · atomic JSON state with a run lock |
| `src/lib/docs-mcp.ts` | Developer Docs MCP client: `tools/list`, `searchDocumentation`, `getPage`, `askQuestion`, with timeouts and retries |
| `src/lib/env.ts` · `net.ts` | loads keys once (`~/.config/pharos/testnet.env`, then the repo `.env`) · retry, rate-limit and error helpers both MCP clients share |
| `src/lib/chain.ts` | viem wallet bound to Atlantic (used by Threshold Guardian) and a raw testnet client for scripts |
| `src/lib/networks.ts` | chain definitions + known token addresses (from SkillEngine `assets/`), explorer links |
| `src/guardian/` | Threshold Guardian: policy schema, MCP reader, evaluator, guard |
| `skills/<name>/` | agent skills in SkillEngine format (`SKILL.md` + `references/`), installable with `npx skills add` |
| `tasks/<slug>/` | one Arena task each: entry point + README + proof (start from `tasks/_template/`) |
| `test/` | vitest tests; a task's own tests can also live in `tasks/<slug>/*.test.ts` |

## License

MIT
