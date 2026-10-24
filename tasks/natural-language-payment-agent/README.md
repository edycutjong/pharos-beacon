# Natural-Language Payment Agent — Medium

**Task:** [Natural-Language Payment Agent](https://pharos-agent-arena.vercel.app/tasks/natural-language-payment-agent) (Payments · Medium · 100 pts): turn "send 100 USDC to X" into a fully prepared transaction for the user to review and sign.
**Run** (Atlantic testnet; one-time `npm run setup:mcp`; the sender address comes from `--from 0x…` or from `PRIVATE_KEY` in `~/.config/pharos/testnet.env`, and the key is not used until `--execute`):
`npm run natural-language-payment-agent -- "send 0.01 PHRS to 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B"` · add `--followup "WPHRS"` to answer a question · `--parser rules` runs without any LLM key · `--execute` signs and sends.
**Uses:** Chain MCP ✅ (`get_balance`, `eth_call` `decimals()` / `balanceOf`, `get_transaction_count`, `estimate_gas`, `get_block`, `get_gas_price`, `send_raw_transaction`, `get_transaction_receipt`); SkillEngine `tokens.json` for the token list; a free-tier Gemini model (key read from `~/.config/gemini/` at run time) for the language step; viem signs locally.

## How it works

1. **Parse.** The LLM extracts `amount`, `token`, `recipient` from free text (English or Bahasa Indonesia). It only *extracts*: its answer is cross-checked against the user's own words by deterministic code. A recipient the user never typed is dropped; an amount that disagrees with the rule parser's reading becomes a question; a number like `1.000` / `1,000` (one thousand, or one point zero?) is **always asked**, never decided. If the LLM is down, the rule parser takes over and says so.
2. **Ask.** Anything missing or ambiguous (no token, "50 dollars", two payments in one message, `1.000`) prints a follow-up question and exits 2. `--followup "<answer>"` adds a turn; later turns fill the gaps. Questions come in the language of the request.
3. **Validate, deterministically** (`src/pay/prepare.ts`): recipient is a 42-character address with a valid EIP-55 checksum, not the zero address, not the sender (names like `alice.eth` are refused: Pharos has no name service); token is in the SkillEngine Atlantic list; `decimals()` is **read on chain** and must match the list; the amount has no more decimals than the token and is not zero; the sender's **balance** covers it (plus the fee for PHRS), checked before the gas estimate.
4. **Summarise, then prepare.** A human-readable summary, then the **unsigned** transaction (EIP-1559, chain 688689) and the same transaction as an `eth_sendTransaction` wallet signing request.
5. **Never signs on its own.** Without `--execute` the program ends with `NOT SIGNED. Nothing was sent.` The key is only touched inside `--execute`, and only if it belongs to the prepared sender.

Extra (U1): **Bahasa Indonesia** requests work end to end (`kirim 0,005 PHRS ke 0x…`), and ambiguity is asked about in the user's language.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Parses amount, token and recipient from free text, and asks a follow-up when anything is ambiguous." | LLM + rule parser; missing token, a fiat word, two payments, or `1.000` → a follow-up question (exit 2), answered with `--followup` | [`proof/prepared-en.log`](proof/prepared-en.log), [`prepared-id.log`](proof/prepared-id.log), [`asks-token.log`](proof/asks-token.log), [`asks-thousands-id.log`](proof/asks-thousands-id.log), [`followup-prepared-erc20.log`](proof/followup-prepared-erc20.log); `test/pay.test.ts` |
| 2 | "Validates the request: recipient format, token contract, sufficient balance." | The three checks above, each printed as PASS/FAIL with the detail; a failure prepares nothing | refused: [`refused-name.log`](proof/refused-name.log) (recipient), [`refused-checksum.log`](proof/refused-checksum.log) (checksum), [`refused-balance.log`](proof/refused-balance.log) (balance); token contract + `decimals()` on chain in every PASS block |
| 3 | "Shows a human-readable summary before producing the unsigned transaction." | `Send <amount> <token> / from / to / network / max fee / status UNSIGNED` is printed first, the transaction JSON after it | the output block below |
| 4 | "Never signs or sends on its own. Output is an unsigned transaction or a wallet signing request." | Both are printed; `--execute` is the only path to the key | `NOT SIGNED` in every non-`--execute` log; `src/pay/run.ts` `maybeExecute` |

## Output (pasted from `proof/followup-prepared-erc20.log`)

```text
you: send 0.001 to 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
you (follow-up): WPHRS
parser: gemini-3.5-flash · language: en
understood: {"amount":"0.001","token":"WPHRS","recipient":"0x8D347c72431ed6E033d5f43E56c0987E97f5D91B"}

checks
  PASS  recipient 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B (valid, checksum ok)
  PASS  token     WPHRS at 0x838800b758277CC111B2d48Ab01e5E164f8E9471 (SkillEngine tokens.json)
  PASS  decimals  decimals() = 18 read on chain
  PASS  amount    0.001 WPHRS = 1000000000000000 base units
  PASS  balance   0x317b…2975 holds 0.00231 WPHRS, needs 0.001

Send 0.001 WPHRS
  from      0x317bca01Bb101C0F1E86C21576a4e14D92B02975
  to        0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
  network   Pharos Atlantic Testnet (chain 688689)
  contract  0x838800b758277CC111B2d48Ab01e5E164f8E9471 (WPHRS.transfer)
  max fee   0.000091864 PHRS (gas 45932)
  status    UNSIGNED: nothing is signed or sent until you approve it

```

The same run continues with the unsigned transaction and the wallet signing request (see the log).

An ambiguous number is asked about, not guessed (`proof/asks-thousands-id.log`):

```text
you: kirim 1.000 WPHRS ke 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B
parser: gemini-3.5-flash · language: id
understood: {"token":"WPHRS","recipient":"0x8D347c72431ed6E033d5f43E56c0987E97f5D91B"}

I need one more thing before I prepare anything:
  ? "1.000" itu seribu atau satu koma nol? Tulis 1000 atau 1.0 supaya saya tidak menebak.

Answer with: --followup "<your answer>"
```

A bad checksum is refused (`proof/refused-checksum.log`):

```text
you: send 5 WPHRS to 0x8d347c72431ed6E033d5f43E56c0987E97f5D91B
parser: gemini-3.5-flash · language: en
understood: {"amount":"5","token":"WPHRS","recipient":"0x8d347c72431ed6E033d5f43E56c0987E97f5D91B"}

checks
  FAIL  recipient 0x8d347c72431ed6E033d5f43E56c0987E97f5D91B has mixed-case letters that fail the EIP-55 checksum (a typo?): refusing
  PASS  token     WPHRS at 0x838800b758277CC111B2d48Ab01e5E164f8E9471 (SkillEngine tokens.json)
  PASS  decimals  decimals() = 18 read on chain
  PASS  amount    5 WPHRS = 5000000000000000000 base units

REFUSED: no transaction was prepared.
```

## Live sends (Atlantic, `--execute`)

Both pay a distinct recipient: wallet 1 `0x317b…2975` → our wallet 2 `0x8D34…D91B` (`PRIVATE_KEY_2`).

| Instruction | Result | Proof |
|---|---|---|
| `send 0.002 PHRS to 0x8D34…D91B --execute` | success, block 31804775 | [tx 0x5584496d…](https://atlantic.pharosscan.xyz/tx/0x5584496d21f7dafbd6e79aa5046a0415c443bcedae49ac589bd231f1fb7e84f5) · [`proof/sent-native.json`](proof/sent-native.json) |
| `send 0.0005 WPHRS to 0x8D34…D91B --execute` (ERC-20 `transfer`) | success, block 31804785 | [tx 0xc66ac21f…](https://atlantic.pharosscan.xyz/tx/0xc66ac21fd5c25a48d7a58914876125cb5536241f512eae7dafa04b9fbe49bf7b) · [`proof/sent-erc20.json`](proof/sent-erc20.json) |

## Limits, stated plainly

- Atlantic testnet only; signing is refused for any other chain. Mainnet is not reachable from this task.
- Tokens are the five in the SkillEngine Atlantic list plus native PHRS. Wallet 1 holds no Atlantic USDC, so the live ERC-20 send uses WPHRS; the same code path serves every listed token.
- Name resolution (`alice.eth`) is not supported because Pharos has no name service; the agent says so instead of guessing an address.
- The LLM step needs a key in `~/.config/gemini/credentials.json`. Without one, or with `--parser rules`, a deterministic rule parser handles the same instructions (English and Bahasa). The proofs were produced with `gemini-3.5-flash`.
- Proofs are one run each; the model is not deterministic, but its output is validated the same way every time.

## Tests

18 tests in [`test/pay.test.ts`](../../test/pay.test.ts) (amount parsing, both languages, the follow-up turn, LLM output cross-checks, key rotation, the preparer's refusals, ERC-20 calldata). `npm test` and `npm run typecheck` are green.
