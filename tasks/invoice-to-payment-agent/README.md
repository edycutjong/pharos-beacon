# Invoice-to-Payment Agent — Medium

**Task:** [Invoice-to-Payment Agent](https://pharos-agent-arena.vercel.app/tasks/invoice-to-payment-agent) (Payments · Medium · 100 pts): read an invoice or payment request and prepare the matching on-chain payment.
**Run** (Atlantic testnet; one-time `npm run setup:mcp`; the sender is `--from 0x…`, or the address derived from `PRIVATE_KEY` (the key is read only to derive that address; it signs nothing until `--execute`)). The three valid samples are already paid on Atlantic, so try them against a scratch ledger:
`npm run invoice-to-payment-agent -- tasks/invoice-to-payment-agent/samples/acme-0042.json --parser rules --state "$(mktemp)"` · four of the five `bad-*` samples are flagged before any ledger is read (pass `--state "$(mktemp)"` with `bad-payee.txt`, which reads it) · `--pay-in USDC` settles a USD invoice · `--execute` signs and sends.
**Uses:** Chain MCP ✅ (`get_balance`, `eth_call` `decimals()` / `balanceOf`, `get_transaction_count`, `estimate_gas`, `get_block`, `get_gas_price`, `send_raw_transaction`, `get_transaction_receipt`); SkillEngine `tokens.json`; `pdftotext` (poppler) for PDFs; a Gemini model only to fill fields the labelled lines did not give (key read from `~/.config/gemini/`, optional).

## How it works

1. **Read three formats** (`src/pay/invoice.ts`): structured **JSON** (field aliases such as `invoice_number`, `pay_to`, `total`), **plain text** (labelled lines in English or Bahasa Indonesia: `Total due:`, `Total tagihan:`, `Bayar ke:`, `Nomor Faktur:`) and **PDF** (text pulled with `pdftotext -layout`, then the same text reader). The reader takes payee, amount, currency and reference. If a field is missing and an LLM key exists, the model may fill the gap, but only with a value that appears verbatim in the document.
2. **Flag, never guess.** The agent prepares nothing and prints `FLAGGED` when: a field is missing (number/reference, payee, amount, currency); the totals disagree (`25 vs 30`; a `Subtotal` line is not a competing total); the line items of a JSON invoice do not add up to its total; the currency line and the amount's own currency disagree; two JSON fields or two payee addresses name different values; a file holds several invoices; the amount is ambiguous (`1.000`); the currency is not a token on Atlantic (`USD`) unless the human passes `--pay-in <token>` (then the 1:1 assumption is printed as a note, not hidden).
3. **Same preparer as the Natural-Language Payment Agent** (`src/pay/prepare.ts`): EIP-55 checksum, token from the SkillEngine list, `decimals()` read on chain, balance, then the summary and the **unsigned** transaction plus a wallet signing request.
4. **The invoice reference travels inside the transaction.** For a native payment the reference is the transaction `data`; for an ERC-20 payment it is appended after the `transfer(...)` calldata (WPHRS ignored the extra bytes: the estimate and the live send both succeed; a token that rejects them would fail the estimate and be refused). Anyone can read it back from the transaction input (`eth_getTransactionByHash`).
5. **Signs only with `--execute`**, and only the sender the transaction was prepared for.

Extra (U1): a **duplicate-invoice guard**. Each invoice gets a fingerprint (invoice number, issuer, amount, currency; case-insensitive, extra spaces ignored, `100` equals `100.00`). A paid invoice is recorded in `state/paid.json` with its tx hash; reading it again, with or without `--execute`, is refused and names the first payment. The **PDF** input (an Indonesian *faktur*) is part of the same extra.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Extracts payee, amount, token or currency, and reference from at least 2 invoice formats." | Three formats: JSON, text, PDF; each prints number, issuer, payee, amount, currency | [`prepared-json.log`](proof/prepared-json.log) (JSON), [`prepared-text.log`](proof/prepared-text.log) (text), [`prepared-pdf.log`](proof/prepared-pdf.log) (PDF, from [`faktur-bumi.pdf`](samples/faktur-bumi.pdf)) |
| 2 | "Flags mismatches or missing fields instead of guessing." | `FLAGGED` with one line per problem (a bad payee checksum is `REFUSED` by the preparer), nothing prepared | [`flagged-totals.log`](proof/flagged-totals.log), [`flagged-no-reference.log`](proof/flagged-no-reference.log), [`flagged-usd.log`](proof/flagged-usd.log), [`flagged-line-items.log`](proof/flagged-line-items.log), [`refused-payee-checksum.log`](proof/refused-payee-checksum.log) (a `REFUSED` run from the shared preparer, not `FLAGGED`) |
| 3 | "Produces a payment summary and an unsigned transaction that includes the invoice reference." | `Send … / reference <number>` summary, then the unsigned transaction whose `data` carries the reference | `unsignedTx.data` in [`prepared-json.json`](proof/prepared-json.json); on chain in every `sent-*` tx input |
| 4 | "Includes a demo with sample invoices." | Nine files in [`samples/`](samples/) (three valid invoices: JSON, text and PDF, with the PDF's text twin `faktur-bumi.txt`; and five that must be flagged or refused) in [`samples/`](samples/) and the proofs above, three of them paid live | the live table below |

## Output (pasted from `proof/sent-text.log`)

```text
invoice: tasks/invoice-to-payment-agent/samples/nova-17.txt (text) · read by labelled lines
  number    NV-17
  issuer    Nova Audio Labs
  payee     0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
  amount    0.001 WPHRS
fingerprint a874a23658eb412d (invoice number + issuer + amount + currency)

checks
  PASS  recipient 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B (valid, checksum ok)
  PASS  token     WPHRS at 0x838800b758277CC111B2d48Ab01e5E164f8E9471 (SkillEngine tokens.json)
  PASS  decimals  decimals() = 18 read on chain
  PASS  amount    0.001 WPHRS = 1000000000000000 base units
  PASS  reference "NV-17" appended to the transaction data (5 bytes)
  PASS  balance   0x317b…2975 holds 0.00181 WPHRS, needs 0.001

Send 0.001 WPHRS
  from      0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  to        0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
  network   Pharos Atlantic Testnet (chain 688689)
  contract  0x838800b758277CC111B2d48Ab01e5E164f8E9471 (WPHRS.transfer)
  reference NV-17
  max fee   0.000092058 PHRS (gas 46029)
  status    UNSIGNED: nothing is signed or sent until you approve it

...
SENT success in block 31804831
https://atlantic.pharosscan.xyz/tx/0xa4612b1cb1506989f8ff4dfcd1926fddcdb58b52ed9c0aaae4be8474c4c8ee31
```

The middle of the run (the unsigned transaction and the wallet request) is in the log.

A disagreeing invoice is flagged, not guessed (`proof/flagged-totals.log`):

```text
invoice: tasks/invoice-to-payment-agent/samples/bad-totals.txt (text) · read by labelled lines
  number    QX-9
  issuer    Quick Print Co
  payee     0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
  amount    — USDC

FLAGGED: nothing was prepared. The invoice needs a human:
  ! the invoice states different totals (25 vs 30): refusing to pick one
```

The same invoice is never paid twice (`proof/duplicate-refused.log`, the acme invoice run again):

```text
invoice: tasks/invoice-to-payment-agent/samples/acme-0042.json (json) · read by json fields
  number    INV-2026-0042
  issuer    Acme Design Studio
  payee     0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
  amount    0.005 PHRS
fingerprint ee44523cd8494c8b (invoice number + issuer + amount + currency)

DUPLICATE: invoice INV-2026-0042 was already paid (0.005 PHRS) in 0xc966df7cf33505b8848c7024e95b5c87fa5525dbf8cdd1fe80129f47986780d6
https://atlantic.pharosscan.xyz/tx/0xc966df7cf33505b8848c7024e95b5c87fa5525dbf8cdd1fe80129f47986780d6
refused: it would be paid twice.
```

## Live payments (Atlantic, `--execute`)

Payer wallet 1 `0x317b…2975` → our wallet 2 `0x8D34…D91B` (`PRIVATE_KEY_2`, a distinct address).

| Format | Command | Reference | Result | Proof |
|---|---|---|---|---|
| JSON | `--execute samples/acme-0042.json` | `INV-2026-0042` | success, block 31804824 | [tx 0xc966df7c…](https://atlantic.pharosscan.xyz/tx/0xc966df7cf33505b8848c7024e95b5c87fa5525dbf8cdd1fe80129f47986780d6) · [`proof/sent-json.json`](proof/sent-json.json) |
| text (WPHRS, ERC-20) | `--execute samples/nova-17.txt` | `NV-17` | success, block 31804831 | [tx 0xa4612b1c…](https://atlantic.pharosscan.xyz/tx/0xa4612b1cb1506989f8ff4dfcd1926fddcdb58b52ed9c0aaae4be8474c4c8ee31) · [`proof/sent-text.json`](proof/sent-text.json) |
| PDF | `--execute samples/faktur-bumi.pdf` | `BM/2026/10/088` | success, block 31804836 | [tx 0xdafd31be…](https://atlantic.pharosscan.xyz/tx/0xdafd31be9b3254f061a224c3174612853eac695cb543d983709548173abedd44) · [`proof/sent-pdf.json`](proof/sent-pdf.json) |

## Limits, stated plainly

- Atlantic testnet only. The sample payee is our own second wallet; the invoices are written by us for the demo.
- Currencies are the six Atlantic symbols (PHRS, USDC, USDT, WBTC, WETH, WPHRS). A fiat invoice needs the human's `--pay-in` choice: there is no price feed and the agent does not guess an exchange rate.
- The PDF reader needs `pdftotext` and a text PDF. Layouts it knows are labelled lines; the LLM only fills gaps. Not tested: scanned PDFs.
- The duplicate guard is a local file keyed by invoice fingerprint. It records a payment only after a confirmed success, and `--state` points at another ledger; an invoice that is only prepared (unsigned) and signed elsewhere is not recorded.
- The three `sent-*.log` files were captured before the fingerprint rule was made case/number-insensitive, so the `fingerprint` line in them differs from the one in `state/paid.json` (recomputed from the same invoices). The payments themselves are unchanged.
- The text reader is label-based and narrow on purpose: an unusual layout is flagged as missing fields rather than guessed.
- The reference is limited to 64 bytes. A token that rejects the extra calldata would fail `estimate_gas` and the agent would refuse (not tested with such a token).
- The proofs ran with `--parser auto`; none of the three sample invoices needed the LLM (`read by labelled lines` / `json fields` in the logs).

## Tests

8 tests in [`test/invoice.test.ts`](../../test/invoice.test.ts) (the three readers; the main flags: missing reference, totals, line items, ambiguous amount, two payees, bad JSON, non-token currency, field and currency conflicts, several invoices; `--pay-in`; the LLM gap-filler that may not invent; the fingerprint and ledger; the duplicate refusal through the CLI). The shared preparer has its own 8 tests in `test/pay.test.ts`. `npm test` and `npm run typecheck` are green.
