# Policy schema

Source of truth: `src/guardian/policy.ts` (validation runs before any chain read; a missing, unreadable or invalid policy exits 2).

```jsonc
{
  "name": "pay-when-safe",          // printed in the trace (a proof file is named after the policy file, not this field)
  "network": "atlantic",            // "pharos" (mainnet) | "atlantic" (testnet)
  "conditions": [ /* one or more, all must pass */ ],
  "action": {                       // optional; omit for a pure check. Atlantic only.
    "type": "native_transfer",
    "to": "0x…",                    // address or "$SELF"
    "amount": "0.001"               // whole PHRS as a decimal string, > 0, ≤ 18 decimals
  }
}
```

## Conditions

Every condition takes an optional `label` (plain words, printed in the trace).
Addresses: `0x` + 40 hex; mixed-case addresses must have a valid checksum. `"$SELF"` is allowed where noted. It resolves
to the signing wallet, which exists only on Atlantic, so a condition that uses it fails on mainnet.
`op` is one of `gte gt lte lt eq`.

| `kind` | Fields | Notes |
|---|---|---|
| `native_balance` | `address` ($SELF ok), `op`, `value` | `value` in whole PROS/PHRS, ≤ 18 decimals |
| `erc20_balance` | `token`, `address` ($SELF ok), `op`, `value` | `value` in whole tokens; decimals read via `decimals()` when the token is read, and a finer `value` fails the check |
| `gas_price` | `op`, `gwei` | ≤ 9 decimals |
| `is_contract` | `address` ($SELF ok), `expect` (boolean) | `true` = must have code, `false` = must be a plain wallet |
| `nonce_settled` | `address` ($SELF ok) | passes when latest nonce == pending nonce |
| `log_activity` | `address`, `blocks` (1–1000), `op`, `count`, `topic0` (optional, 32-byte hex) | counts logs in the last `blocks` blocks |

## Example: mainnet check, no key needed

This is `tasks/threshold-guardian/policies/wpros-watch.json`, the policy behind `tasks/threshold-guardian/proof/wpros-watch.dry-run.json`.

```json
{
  "name": "wpros-watch",
  "network": "pharos",
  "conditions": [
    { "kind": "is_contract", "address": "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0", "expect": true, "label": "WPROS is a deployed contract" },
    { "kind": "native_balance", "address": "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0", "op": "gte", "value": "1000000", "label": "WPROS is backed by at least 1M PROS" },
    { "kind": "log_activity", "address": "0xc879c018db60520f4355c26ed1a6d572cdac1815", "topic0": "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "blocks": 1000, "op": "gte", "count": 10, "label": "USDC had at least 10 transfers in the last 1000 blocks" },
    { "kind": "gas_price", "op": "lte", "gwei": "20", "label": "mainnet gas at or under 20 gwei" }
  ]
}
```
