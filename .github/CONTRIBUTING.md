# Contributing

Thanks for your interest in Beacon.

## Getting started
1. Fork the repo and branch from `main`: `git checkout -b feat/your-change`
2. Install: `npm ci` (Node version in `.nvmrc`)
3. Copy the settings template: `cp .env.example .env` — testnet keys only, never mainnet keys
4. For Atlantic runs, build the local Chain MCP once: `npm run setup:mcp`
5. Run a task with the command at the top of its folder's README

## Before you open a PR
- `npm run typecheck` and `npm test` pass.
- Add or update tests for any behavior change.
- Proof files under `tasks/*/proof/` are evidence: regenerate them from committed code, never edit them by hand.
- Keep keys out of the tree; CI scans the full history with gitleaks.
