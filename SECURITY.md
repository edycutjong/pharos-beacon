# Security

- **Keys.** Beacon signs only on Pharos Atlantic testnet. Keys are read from `~/.config/pharos/testnet.env` or a local,
  git-ignored `.env`, and are never written to the repo, to logs or to proof files. The local Chain MCP child process
  gets a minimal environment (`PATH` and the other safe defaults the MCP SDK passes, plus the `PHAROS_*` settings and
  the broadcast switch), never `PRIVATE_KEY`; it only ever receives transactions that are already signed.
- **Mainnet is read-only.** The signing wallet and the shared signer are bound to the Atlantic chain (688689), the
  signer refuses any client for another chain, and the policy schema rejects an action on a mainnet policy.
- **Right chain or nothing.** The Chain MCP client asks the endpoint which chain it serves when it connects and refuses
  to read from one that reports a different chain id.
- **Fail closed.** A condition whose read fails counts as failed, and the Guardian sends nothing.

Please report a vulnerability privately through GitHub's "Report a vulnerability" (Security tab), not in an issue.
