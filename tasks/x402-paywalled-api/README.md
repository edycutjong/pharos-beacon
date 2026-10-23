# x402 Paywalled API — Medium

**Task:** [x402 Paywalled API](https://pharos-agent-arena.vercel.app/tasks/x402-paywalled-api) (Payments · Medium · 100 pts): an API that charges per request with x402 on Pharos Atlantic.
**Live demo:** [pharos.edycu.dev/x402-paywalled-api](https://pharos.edycu.dev/x402-paywalled-api). Press *Run live*. No wallet is needed: a demo buyer on the server pays with test USDC.
**Run** (Atlantic testnet only; keys in `~/.config/pharos/x402.env` and `testnet.env`):
`npm run x402-paywalled-api -- pay a|b|under|replay|free [--base https://pharos.edycu.dev] [--json] [--proof name]` ·
`npm run x402-paywalled-api -- serve [--port 4021]` (the same API on your machine; then `pay … --base http://localhost:4021`).
**Uses:** x402 SDK 2.28 (`@x402/core` resource server + facilitator, `@x402/evm` exact scheme, EIP-3009), viem; Pharos Chain MCP ✅ (`get_block_number`, `get_logs`, hosted mainnet) for the whale brief.

## Routes

All under `/api/x402-paywalled-api/`. One Vercel Function ([`api/x402-paywalled-api.ts`](../../api/x402-paywalled-api.ts)) runs the router in [`app.ts`](app.ts); `serve` runs the same router locally.

| Route | Price | What it returns |
|---|---|---|
| `GET health` | free | network, token, payee, facilitator signer, price list, deployed commit |
| `GET gas-snapshot` | **0.001 USDC** | Atlantic gas price, priority fee, base fee and latest block (Atlantic RPC) |
| `GET whale-brief` | **0.01 USDC** | the 5 largest USDC transfers on Pharos mainnet in the latest 1,000 blocks (Chain MCP `get_logs`, read-only) |
| `GET whale-range?blocks=N` | **quoted**: 0.005 USDC per started 1,000 blocks (1–3 windows, so 0.005–0.015) | the same brief over N blocks of Pharos mainnet history (Chain MCP `get_logs`, one call per 1,000-block window) |
| `GET quote?blocks=N` | free | the price of `whale-range` for N blocks, before asking for the 402 |
| `POST verify` · `POST settle` · `GET supported` | — | **our facilitator** ([`facilitator.ts`](facilitator.ts)) |
| `GET demo-run?scenario=a\|b\|under\|replay\|free` | — | a server-side demo buyer that calls the paid route over real HTTP and streams each step as NDJSON with measured ms |
| `GET runs` | — | the last 10 payments, read back from the chain (USDC Transfer logs to the payee); no database |

Token: the Pharos registry USDC on Atlantic `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B` (EIP-712 name `USDC`, version `2`, 6 decimals, EIP-3009).
The `0xE0BE…` USDC that the other tasks use has no `transferWithAuthorization`, so an x402 "exact" payment cannot settle in it.

## How it works

1. **402.** A request without payment gets `402` with a `PAYMENT-REQUIRED` header (scheme `exact`, `eip155:688689`, amount, asset, payee) and a JSON body that says the same in plain words.
2. **Sign.** The buyer signs an EIP-3009 `transferWithAuthorization` for exactly the price, off chain, and retries with `PAYMENT-SIGNATURE`.
3. **Verify.** The resource server ([`resource.ts`](resource.ts), the SDK's `x402HTTPResourceServer` behind a small Request → Response adapter) sends it to our facilitator's `/verify` over HTTP.
4. **Run, then settle.** Only after a valid verify does the route run; then `/settle` sends `transferWithAuthorization` from the facilitator's own key (it pays the gas) and waits for the receipt.
5. **200.** The data, with a `PAYMENT-RESPONSE` header carrying the settle tx hash, and `Server-Timing` with the verify and settle times.
6. **Receipt check.** The buyer ([`buyer.ts`](buyer.ts)) reads the receipt and accepts the data only if it has status 1 and a USDC `Transfer` of the price from the payer to the payee.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Runs on Atlantic Testnet (eip155:688689), priced in test USDC." | `NETWORK = eip155:688689`; prices are exact amounts of the registry test USDC | [`config.ts`](config.ts) · `GET health` · test "is priced on Atlantic…" |
| 2 | "Has at least 2 paid routes at different prices and 1 free route, such as /health." | `gas-snapshot` 0.001, `whale-brief` 0.01, `health` free | [`config.ts`](config.ts) · test "has two paid routes at different prices and one free route" |
| 3 | "Runs its own facilitator with /verify, /settle and /supported." | x402 SDK `x402Facilitator` + `ExactEvmScheme` with our own signer key, served at `POST verify`, `POST settle`, `GET supported`; the resource server reaches it over HTTP | [`facilitator.ts`](facilitator.ts) · [`/supported`](https://pharos.edycu.dev/api/x402-paywalled-api/supported) · tests under "our facilitator" |
| 4 | "Shows the full flow in the demo: a 402, then a signed payment, then a 200 with a PAYMENT-RESPONSE header and its tx hash, linked on the explorer." | The demo page's Sequence strip lights request → 402 → sign → verify → settle → 200 + receipt from the real NDJSON stream; Evidence links the settle tx on atlantic.pharosscan.xyz; the Raw HTTP tab shows both headers | [live page](https://pharos.edycu.dev/x402-paywalled-api) · `pay a` / `pay b` proofs (`proof/`) |
| 5 | "Rejects a bad or underpaid payment with another 402." | `under`: the buyer signs half the price → `/verify` answers `invalid_exact_evm_payload_authorization_value_mismatch` → 402, nothing settled. `replay`: the same signature again → 402 `invalid_exact_evm_nonce_already_used` | *Send an underpaid payment* / *Replay a payment* on the page · `pay under`, `pay replay` · tests "refuses an underpaid payment…", "refuses a replayed PAYMENT-SIGNATURE…" |
| 6 | "Keeps private keys in env vars or a file, never in code or prompts." | Keys are read only from env vars (Vercel) or `~/.config/pharos/x402.env` / `testnet.env`, never copied into `process.env`, never printed; CI runs gitleaks | [`settings.ts`](settings.ts) · [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) |

## Beyond the requirements

- **Receipt check.** The buyer does not trust `PAYMENT-RESPONSE` alone: no status-1 receipt with the matching USDC Transfer, no data accepted (`matchReceipt` in [`buyer.ts`](buyer.ts)).
- **Replay refused before the SDK looks.** Before verify and before settle, the facilitator reads `authorizationState(payer, nonce)` on the token; a used nonce is refused at once, so a re-sent `PAYMENT-SIGNATURE` gets 402 and the facilitator spends no gas on it.
- **Price in plain words.** Every 402 body states price, asset and payee as a sentence, also on the refusals.
- **A quoted route.** `whale-range` costs what the request costs to serve: `?blocks=2500` needs 3 windows of 1,000 blocks, so the 402 asks 0.015 USDC and says why in `message` and in a `quote` object (`windows`, `perWindow`, `rule`, `why`); `?blocks=1000` asks 0.005. A buyer can also read the price first from the free `GET quote?blocks=N`. A bad `?blocks=` (0, 3001, 1.5, text) is refused with 400 before any 402, so nobody signs for a request that cannot be served. `pay quote` runs the whole flow on it (see `proof/quote.json`).
- **Scoped facilitator.** It verifies and settles only payments to our payee, in our USDC, on Atlantic, so a stranger cannot use its gas for their own transfers.

## Limits

- The Atlantic reads (gas snapshot, settle receipt, run log) use the Atlantic JSON-RPC, not the Chain MCP: the hosted Chain MCP serves mainnet only, and the local stdio Atlantic server that the CLI tasks use cannot run inside a Vercel Function. The whale brief (mainnet) is read through the hosted Chain MCP.
- The run log is read from the chain, so it shows settled payments only (refused runs move nothing). The public RPC answers one 1,000-block log query at a time, so it looks back about 12 hours (24 windows).
- The demo rate limit (one paid run every 10 s) and the facilitator's pending-settlement memory are per server instance; Vercel may run more than one.
- The demo buyer is a server-side wallet holding test USDC; anyone pressing *Run live* spends it (0.001–0.01 test USDC per run).

## Tests

`npm test` — 18 tests in [`test/x402.test.ts`](../../test/x402.test.ts), offline (a stand-in chain that really checks the EIP-712 signatures): the price table, the 402's requirements and plain-words body, a paid run's NDJSON event shape and order, the dearer route's price, underpay and replay refused with nothing settled twice, the free route, the facilitator's scope and nonce checks and `/supported`, the receipt matcher (revert, wrong amount, payee, token), Server-Timing parsing, the rate gate, the whale ranking and the run-log scan.
