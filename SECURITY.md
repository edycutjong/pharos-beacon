# Security

- **Keys.** Beacon signs only on Pharos Atlantic testnet. Keys are read from `~/.config/pharos/testnet.env` or a local,
  git-ignored `.env` into the program and are never copied into its environment. They are never written to the repo,
  to logs or to proof files. The local Chain MCP child process and the git calls that stamp proofs get an explicit
  minimal environment, so neither receives `PRIVATE_KEY`, even if you export it: the child gets `PATH` and the other
  safe defaults the MCP SDK passes, plus the `PHAROS_*` settings and the broadcast switch. The only write the child can
  be asked to do is relay a transaction that is already signed, and only when the broadcast switch is on.
- **Mainnet is read-only.** The signing wallet and the shared signer are bound to the Atlantic chain (688689), the
  signer refuses any client for another chain, and the policy schema rejects an action on a mainnet policy.
- **Right chain or nothing.** The Chain MCP client asks the endpoint which chain it serves when it connects and refuses
  to read from one that reports a different chain id.
- **Fail closed.** A condition whose read fails counts as failed, and the Guardian sends nothing.

Please report a vulnerability privately through GitHub's "Report a vulnerability" (Security tab), not in an issue.
