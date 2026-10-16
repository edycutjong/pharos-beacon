# Security

- **Keys.** Beacon signs only on Pharos Atlantic testnet. Keys are read from `~/.config/pharos/testnet.env` or a local,
  git-ignored `.env`, and are never written to the repo, to logs or to proof files. The local Chain MCP child process
  gets a minimal environment (`PATH` and the other safe defaults the MCP SDK passes, plus the `PHAROS_*` settings),
  never `PRIVATE_KEY`.
- **Mainnet is read-only.** The signing wallet is bound to the Atlantic chain (688689), and the policy schema rejects
  an action on a mainnet policy.
- **Fail closed.** A condition whose read fails counts as failed, and the Guardian sends nothing.

Please report a vulnerability privately through GitHub's "Report a vulnerability" (Security tab), not in an issue.
