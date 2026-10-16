# <Task name> — <Easy|Medium|Hard>

**Task:** [<Task name>](https://pharos-agent-arena.vercel.app/tasks/<slug>) (<Category> · <Tier> · <points> pts):
<one line from the Arena board>.
**Run:** `npm run <slug> -- <args> [--proof]`
**Uses:** Chain MCP ✅ (<tools>) · Docs MCP <✅ (<tools>) | not used by this task> · SkillEngine <✅ (<what>) | not used by this task>

## Requirements → evidence

One row per requirement on the task page, in its order and in its words. Every row links a file or a proof.

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | <requirement, verbatim> | <one line> | [`proof/<run>.json`](proof/<run>.json) · [`index.ts`](index.ts) |

## What it does

<3–6 sentences: the input, what it reads (which tools), how it decides, what it prints or sends. Say what fails closed.>

## Chain MCP tools

| Tool | Used for |
|---|---|
| `get_chain_info` | chain check at connect (every run) |
| `<tool>` | <what> |

## Proof (live runs)

| Run | Network · block | Result | File |
|---|---|---|---|
| <what it shows> | <pharos 1672 · block N> | <outcome; tx link when it sends> | [`proof/<run>.json`](proof/<run>.json) |

```text
<the real output of one run, pasted verbatim>
```

## Tests

`npm test` runs <N> tests for this task (`<file>.test.ts`): <what they pin, including the failure path>.

## Limits

- <what it does not do, said plainly>
