# Docs MCP Onboarding — Easy

**Task:** [Docs MCP Onboarding](https://pharos-agent-arena.vercel.app/tasks/docs-mcp-onboarding) (Developer Docs MCP · Easy · 50 pts):
self-onboard using only the Developer Docs MCP and log where it broke down.
**Read:** [`ONBOARDING.md`](ONBOARDING.md) (every `>` quote in it is a verbatim substring of the committed transcript, and a test checks that) · **Raw transcript:** [`proof/transcript.md`](proof/transcript.md) ([jsonl](proof/transcript.jsonl))
**Uses:** Docs MCP ✅ (`askQuestion`, `searchDocumentation`; `sendFeedback` deliberately not called) · Chain MCP ✅ (what the log set up and used) · SkillEngine: could not be installed from the docs (gap 3)

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | A step-by-step log of what you tried to do, the questions you asked Docs MCP, and the answers you got | 9 steps, each with the exact query, a verbatim excerpt of the answer, and what happened | [`ONBOARDING.md`](ONBOARDING.md#step-log) · [`proof/transcript.md`](proof/transcript.md) |
| 2 | At least 3 concrete gaps or breakdowns (wrong, missing, or confusing answers), each with the exact query | 5 gaps (3 missing, 1 hard to find, 1 inconsistent), each with its exact query and call number | [`ONBOARDING.md`](ONBOARDING.md#gaps-and-suggested-fixes) |
| 3 | A suggested fix for each gap: what the docs should have said | the last column of the gap table | [`ONBOARDING.md`](ONBOARDING.md#gaps-and-suggested-fixes) |
| 4 | Ends with what you managed to build or run by the end | a real mainnet read through the hosted Chain MCP, a self-built Atlantic Chain MCP, one Atlantic transfer (tx below), and the Doc-Search CLI; what was not done is listed too | [`ONBOARDING.md`](ONBOARDING.md#what-was-built-and-run-by-the-end) · [`proof/first-read.json`](proof/first-read.json) · [`proof/first-tx.txt`](proof/first-tx.txt) |

Proof tx: [`0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88`](https://atlantic.pharosscan.xyz/tx/0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88) (Atlantic, success).

## Not done (needs a human: a person with a wallet and a browser login)

Logging in to ai.pharos.xyz and adding the network to a browser wallet need a person with a wallet; the faucet and the SkillEngine
package have no link in the docs. The log says so at each step; nothing is claimed as done that was not.

## Tests

`npm test` runs 7 tests for this task (`test/docs-onboarding.test.ts`): every `>` quote in `ONBOARDING.md` is a verbatim substring of the
committed transcript, every step query matches its call number, there are at least 3 gaps each with a query that was really asked and a fix,
`transcript.md` is the current render of `transcript.jsonl`, and the recorder keeps a tool error as an entry.
