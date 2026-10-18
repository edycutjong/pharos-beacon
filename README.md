# Beacon

Agent tools for **Pharos**, built task by task for the Pharos Season of AI Agent Arena.
The tasks share one toolkit in `src/lib/`: a Pharos Chain MCP client that checks which chain it is talking to,
paces itself under the hosted server's rate limit and retries only safe reads; a testnet signer (`npm run ping`
exercises it) for which the Chain MCP prepares, broadcasts and confirms each transaction while viem only signs; a proof
writer, a CLI runner and crash-safe state files; and chain constants copied from SkillEngine's `assets/`. Threshold
Guardian predates the signer, the proof writer, the CLI runner and the state helpers: it has its own CLI, sends with a
viem wallet, confirms the receipt through the Chain MCP, and its proof files hold the policy and the outcome. The repo also ships a tested client for the Developer Docs
MCP (`src/lib/docs-mcp.ts`), which the two Docs MCP tasks use. Each task lives in its own folder under `tasks/`; tasks that
ship as agent skills also have a folder under `skills/`.

**How it is built.** Written with AI assistance (Claude Code). The feature choices, the design decisions and the
review and merge of each task's pull request are by [@edycutjong](https://github.com/edycutjong).

## Tasks

| Task | Tier | What | Proof |
|---|---|---|---|
| [Threshold Guardian](tasks/threshold-guardian/) | Medium | Checks N onchain conditions through Chain MCP and acts only if all pass. Fails closed and re-checks before sending. Also packaged as a [SkillEngine-format skill](skills/threshold-guardian/SKILL.md) | [Atlantic tx](https://atlantic.pharosscan.xyz/tx/0xd567073eaa5d89eb5e30c3e3efa2948818851648fe628d93ff6fa29074dfbf39) · [proof/](tasks/threshold-guardian/proof/) |
| [Policy Gatekeeper](tasks/policy-gatekeeper/) | Medium | Checks a request against a spend limit (per tx and per window), a recipient allowlist and a UTC time window, names the rule that decided, never sends a denied request, and keeps a hash-chained audit log. Also a [SkillEngine-format skill](skills/policy-gatekeeper/SKILL.md) | [Atlantic tx](https://atlantic.pharosscan.xyz/tx/0x801160985556a2888c927db0109469d17f3a80b9b395baa5c30e49a060e969cd) · [proof/](tasks/policy-gatekeeper/proof/) · [audit log](tasks/policy-gatekeeper/audit/audit.jsonl) |
| [Dry-Run Executor](tasks/dry-run-executor/) | Medium | Simulates a transaction with `eth_call` + `estimate_gas`, reports success or the decoded revert reason, the fee and balances before/after, blocks a failing one (exit 3, nothing signed), and compares the prediction with the receipt after a real send. Also a [SkillEngine-format skill](skills/dry-run-executor/SKILL.md) | [proof/](tasks/dry-run-executor/proof/) |
| [Gas Fee Optimizer](tasks/gas-fee-optimizer/) | Medium | Samples Atlantic gas over time, holds a transaction until gas is at or below a target (fixed price or percentile of history) and always sends at the deadline. Atlantic gas is flat, so the live runs show the mechanics, not a saving. Also a [SkillEngine-format skill](skills/gas-fee-optimizer/SKILL.md) | [proof/](tasks/gas-fee-optimizer/proof/) |
| [Read Contract State](tasks/read-contract-state/) | Easy | Reads name, symbol, decimals, totalSupply, balances, owner and paused from Pharos mainnet USDC through the Chain MCP, pinned to one block, decimals applied, addresses labelled | [proof JSON](tasks/read-contract-state/proof/0xc879c018db60520f4355c26ed1a6d572cdac1815.json) (read-only, no tx) |
| [Doc-Search CLI](tasks/doc-search-cli/) | Easy | `pharos-docs "<question>"`: a concise answer with source links from the Developer Docs MCP; says "not found" with the closest pages instead of inventing an answer | [proof/](tasks/doc-search-cli/proof/) (read-only, no tx) |
| [dApp Support Agent](tasks/dapp-support-agent/) | Easy | `npm run dapp-support-agent -- 0x<txHash>`: replays a failed transaction one block earlier and explains the cause (balance, allowance, out of gas, revert reason) in plain words with a fix | [proof/](tasks/dapp-support-agent/proof/) (4 real failed Atlantic txs) |
| [Docs MCP + Chain MCP Agent](tasks/docs-chain-mcp-agent/) | Medium | `npm run docs-chain-mcp-agent`: explains a contract function from the Docs MCP (cited pages must name it), calls it via the Chain MCP, and reads the result against the explanation; says so when the docs do not describe it | [proof/](tasks/docs-chain-mcp-agent/proof/usdc-balanceof.json) |
| [Docs MCP Onboarding](tasks/docs-mcp-onboarding/) | Easy | An honest step-by-step log of onboarding with only the Docs MCP: 9 steps, 5 gaps with exact queries and suggested fixes, raw transcript | [Atlantic tx](https://atlantic.pharosscan.xyz/tx/0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88) · [transcript](tasks/docs-mcp-onboarding/proof/transcript.md) |

## Quick start

```bash
npm ci
npm test            # 410 tests: guardian, gatekeeper, read-contract-state, watcher, doc-search CLI, onboarding log, dApp support agent, docs + chain agent, Chain MCP and Docs MCP clients, signer, shared helpers
npm run guard -- tasks/threshold-guardian/policies/wpros-watch.json   # mainnet via hosted Chain MCP, read-only, no key needed
npm run read-contract-state   # USDC on mainnet: name, symbol, decimals, supply, balances at one block, no key needed
npm run setup:mcp   # builds the sponsor Chain MCP server locally for Atlantic testnet reads (pinned commit)
npm run smoke       # hosted Chain MCP tool list + chain info, Atlantic block (+ wallet balance if PRIVATE_KEY is set)
npm run smoke:docs  # live Developer Docs MCP check: tools/list, a search, a page fetch, a question (keyless)
npm run ping        # Atlantic signer check: prepare via Chain MCP + sign locally; --execute sends 0 PHRS to itself
```

Write operations target **Pharos Atlantic testnet** (chain 688689) and need `PRIVATE_KEY` (see `.env.example`).
It is read from `~/.config/pharos/testnet.env` (preferred) or a local `.env` that git ignores (an exported variable wins
over both), and never committed. Keys from those two files are read into the program and never copied into its
environment; the local Chain MCP server and the git calls that stamp proofs get a minimal environment, so neither
receives `PRIVATE_KEY`, even an exported one.
Mainnet (chain 1672) is read-only here.

## Layout

| Path | What |
|---|---|
| `src/lib/mcp.ts` | Chain MCP client: hosted HTTP for mainnet, local stdio server for Atlantic. Checks the chain id at connect, paces itself (per process) at 100 requests per minute against the hosted server, counting the 4 a connect costs (the server allows 120 per minute per IP), and at 60 per minute against the local Atlantic server, waits as long as a 429's Retry-After asks (up to 65 s), retries only reads, reconnects a lost session, ends the session on close. Typed tool results; `getLogsRange` for any block range |
| `src/lib/signer.ts` | Atlantic-only signer: nonce, gas and fees read through the Chain MCP, signed locally with viem, broadcast through the Chain MCP, receipt read back through it. The hash is known before sending |
| `src/lib/proof.ts` · `cli.ts` · `state.ts` | proof files stamped with chain, endpoint, server version and commit (for new tasks; Threshold Guardian's proofs predate it) · task CLI runner (flags, exit codes, cleanup, Ctrl-C) · atomic JSON state with a run lock |
| `src/lib/docs-mcp.ts` | Developer Docs MCP client: `tools/list`, `searchDocumentation`, `getPage`, `askQuestion`, with timeouts and retries |
| `src/lib/env.ts` · `net.ts` | reads settings and keys once (shell, then `~/.config/pharos/testnet.env`, then the repo `.env`), keeping keys out of the environment · retry, error and client-identity helpers both MCP clients share, plus the rate limiter and throttle-aware fetch the Chain MCP client uses |
| `src/lib/chain.ts` | viem wallet bound to Atlantic (used by Threshold Guardian) and a raw testnet client for scripts |
| `src/lib/networks.ts` | chain definitions + known token addresses (from SkillEngine `assets/`), explorer links |
| `src/guardian/` | Threshold Guardian: policy schema, MCP reader, evaluator, guard |
| `src/gatekeeper/` | Policy Gatekeeper: policy schema, pure evaluator, hash-chained audit log, request runner |
| `skills/<name>/` | agent skills in SkillEngine format (`SKILL.md` + `references/`), installable with `npx skills add` |
| `tasks/<slug>/` | one Arena task each: entry point + README + proof (start from `tasks/_template/`) |
| `test/` | vitest tests; a task's own tests can also live in `tasks/<slug>/*.test.ts` |

## License

MIT
