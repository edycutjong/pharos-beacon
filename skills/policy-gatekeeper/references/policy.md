# Policy file reference

```json
{
  "name": "treasury-agent",
  "network": "atlantic",
  "spendLimit": { "perTx": "0.005", "perWindow": "0.008", "windowSeconds": 3600 },
  "allowlist": ["0x8D347c72431ed6E033d5f43E56c0987E97f5D91B"],
  "timeWindow": { "start": "00:00", "end": "12:00", "days": [1, 2, 3, 4, 5] }
}
```

- `name` (string) and `network` (`"atlantic"` only) are required. At least one of `spendLimit`, `allowlist`, `timeWindow`.
- Unknown fields are an error (a typo like `perTX` must not silently drop a limit).
- Amounts: decimal strings in PHRS, at most 18 decimals, never numbers.
- `spendLimit`: `perTx` and/or `perWindow`; `perWindow` needs `windowSeconds` (positive integer). The window is rolling and
  counts only transfers this gatekeeper sent (`state/spend.json`), recorded before the broadcast.
- `allowlist`: non-empty array of addresses, compared case-insensitively. An empty list is rejected (it would deny everything;
  omit the rule instead).
- `timeWindow`: `start`/`end` as `HH:MM` UTC, start inclusive, end exclusive, `start` > `end` wraps midnight; `days` = UTC
  weekdays 0–6 (0 = Sunday), for a wrapping window the day it started.
- Request: `{ "to": "0x…", "amount": "0.001", "at"?: ISO time (simulated, never sent), "label"?: text }`.

Order of evaluation: request validity → allowlist → time window → per-tx → per-window; the first failure decides.

Audit log (`audit/audit.jsonl`): one JSON line per decision (`event: "decision"`, rule, reason, request) and per execution result
(`event: "result"`, tx, status). Each line has `seq` and `prev` = sha256 of the previous line.
