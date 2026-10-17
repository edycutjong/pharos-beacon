---
name: policy-gatekeeper
description: >
  Gate an agent's payment on Pharos behind a policy before it executes. Use when the user wants spend limits (per
  transaction and per time window), a recipient allowlist, an allowed UTC time window, an audit trail of every decision,
  or asks "is this transfer allowed?" / "put guardrails on my agent's payments" on Pharos Atlantic testnet. Every request
  returns ALLOW or DENY plus the specific rule that decided; a denied request is never sent; every decision is appended to a
  tamper-evident audit log.
version: 0.1.0
requires:
  anyBins:
  - node
  - npm
---

# Policy Gatekeeper

A request (`to`, `amount` in PHRS) is checked against a JSON policy before anything is signed. The answer is ALLOW or DENY
and names the rule that decided: `allowlist`, `time_window`, `spend_limit_per_tx`, `spend_limit_per_window`, or `request`
(a malformed request, which is denied, never guessed at). Only an ALLOW with `--execute` is sent, on Atlantic testnet.

## Setup (once)

```bash
git clone https://github.com/edycutjong/pharos-beacon && cd pharos-beacon && npm ci
npm run setup:mcp        # only to execute: builds the open-source pharos-mcp server for Atlantic
```

Checking a request needs no network and no key. Sending needs `PRIVATE_KEY` in `~/.config/pharos/testnet.env` (loaded
automatically) or exported in the session. Never type a key into a command or put it in a tracked file.

## Workflow

1. **Collect the rules.** Ask for any missing value rather than guessing: the per-transaction limit, the window budget and its
   length, the allowed recipients, the UTC hours (and weekdays). If the user gives a local time zone, convert to UTC and say so.
2. **Write the policy** to `tasks/policy-gatekeeper/policies/<name>.json` (schema: `references/policy.md`). Give it its own file name.
3. **Check the request first, always** (never sends):
   ```bash
   npm run policy-gatekeeper -- tasks/policy-gatekeeper/policies/<name>.json --to <0x…> --amount <PHRS>
   ```
   Several requests: `--requests file.json` with `[{"label": "...", "to": "0x…", "amount": "0.001"}]`.
4. **Explain the result:** each rule's PASS/FAIL, the deciding rule, and what would have changed it.
5. **Send only on explicit confirmation** of that exact recipient and amount, only after a check returned ALLOW:
   ```bash
   npm run policy-gatekeeper -- tasks/policy-gatekeeper/policies/<name>.json --to <0x…> --amount <PHRS> --execute --proof
   ```
   Report the tx link and receipt status. The window budget is updated; the decision and the result are in
   `tasks/policy-gatekeeper/audit/audit.jsonl`.

## Rules

| Policy field | Rule | Deny rule name |
|---|---|---|
| `allowlist` | recipient must be listed (addresses, EOAs or contracts) | `allowlist` |
| `timeWindow` `{start, end, days?}` | request time must be inside it (UTC, end exclusive, wraps midnight) | `time_window` |
| `spendLimit.perTx` | amount ≤ limit | `spend_limit_per_tx` |
| `spendLimit.perWindow` + `windowSeconds` | amount + what this gatekeeper already sent in the window ≤ limit | `spend_limit_per_window` |

## Guardrails

- A deny is a correct answer, not an error. Do not retry with a different recipient or a split amount to get around a
  deny, and do not edit `state/spend.json` or the audit log. Tell the user which rule decided and let them change the policy.
- Never pass `--execute` without the user confirming that exact policy, recipient and amount.
- Sending is Atlantic testnet only; the policy's `network` must be `"atlantic"`.
- `--at <ISO time>` evaluates against a simulated clock and never sends: use it to show how a policy behaves at another hour.
- If the Chain MCP cannot be reached while executing, the run ends with `error: …` and exit 1. The spend is already counted in
  the window (it errs on the side of having spent); check the explorer link in the message before retrying.

## Example

`policies/treasury.json` (limit 0.005 PHRS per tx, 0.008 per hour, two allowlisted wallets, 00:00–12:00 UTC) with
`policies/requests-demo.json` shows two allows and one deny per rule type. See `tasks/policy-gatekeeper/README.md`.

Complements `pharos-skill-engine` (one-off cast/forge commands) and `threshold-guardian` (gate on on-chain conditions rather
than on who, when and how much).
