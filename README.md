# Beacon

Agent tools for **Pharos**, built task by task for the Pharos Season of AI Agent Arena.
One shared toolkit — the Pharos Chain MCP, the Docs MCP, and SkillEngine skills — and one
folder per task under `tasks/`.

## Quick start

```bash
npm install
npm run smoke      # Chain MCP tools + mainnet chain info, testnet block, wallet balance
```

Write operations target **Pharos Atlantic testnet** (chain 688689) and need `PRIVATE_KEY`
(see `.env.example`). Chain MCP reads hit Pharos mainnet (chain 1672) via the hosted,
keyless, read-only endpoint `https://mcp.pharos.xyz/mcp`.

## Layout

| Path | What |
|---|---|
| `src/lib/mcp.ts` | Chain MCP client (`chainMcp()`, `callTool()`) |
| `src/lib/chain.ts` | viem clients for testnet + mainnet, signing wallet |
| `src/lib/networks.ts` | chain definitions + known token addresses |
| `tasks/<slug>/` | one Arena task each: code + README + proof |
| `skills/` | reusable SkillEngine skills |

## Tasks

| Task | Tier | Proof |
|---|---|---|
| _board opens 2026-10-12_ | | |
