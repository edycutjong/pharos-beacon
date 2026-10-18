# Batch Executor — Medium

**Task:** [Batch Executor](https://pharos-agent-arena.vercel.app/tasks/batch-executor) (SkillEngine · Medium · 100 pts): a Skill that takes several independent actions and bundles them into one optimized execution.
**Run** (Atlantic testnet only; one-time `npm run setup:mcp`, keys in `~/.config/pharos/testnet.env`):
`npm run batch-executor -- --plan one-fails` (keyless: simulates the batch, sends nothing) ·
`npm run batch-executor -- --plan <name|file.json> [--approve] [--drop-failing] [--execute] [--compact] [--proof name]`.
**Skill:** [`skills/batch-executor/SKILL.md`](../../skills/batch-executor/SKILL.md) · **Uses:** Chain MCP ✅ (`get_block_number`, `get_block`, `get_gas_price`, `eth_call`, `estimate_gas`, `get_balance`, `get_transaction_count`, `send_raw_transaction`, `get_transaction_receipt`); viem signs locally.

## How it works

A **plan** ([`plans/all-success.json`](plans/all-success.json), [`plans/one-fails.json`](plans/one-fails.json)) lists at least 3 independent actions: a PHRS send (`native`) or an ERC-20 send (`erc20`: `WPHRS`, `USDC`, `USDT`, `WBTC`, `WETH`).
Each action needs its own recipient (otherwise they would not be independent).

1. **Bundle.** All actions become calls of one transaction to Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`, already deployed on Atlantic; we did not deploy it): `aggregate3Value`, with `allowFailure = true` on every call, so one reverting action does not undo the others.
   Multicall3 is the caller, so an ERC-20 send is `transferFrom(you, recipient, amount)` against an allowance you give Multicall3; `--approve` raises it to exactly what the batch spends.
2. **Simulate first.** One `eth_call` of the whole batch returns, per action, whether it would succeed (and its decoded revert reason if not). Each action is also estimated alone (`estimate_gas` of the plain send), and the batch itself is estimated.
3. **Send** (`--execute`): one signed transaction. Then every recipient's balance is read back, and each action is reported **APPLIED** (the recipient received exactly the amount) or **NOT APPLIED** with its reason.
4. **Report** the gas of the sent batch against the sum of the individual estimates, and the steps (N transactions → 1).

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Accepts a list of at least 3 independent actions." | The plan's `actions` list; fewer than 3, a repeated recipient or a malformed action is refused with the action's number | [`plans/all-success.json`](plans/all-success.json) (4 actions), [`plans/one-fails.json`](plans/one-fails.json) (4) · `resolveActions` in [`src/batch/batch.ts`](../../src/batch/batch.ts) · tests "needs at least 3 actions", "rejects bad actions", "refuses a plan with fewer than 3 actions" |
| 2 | "Executes them as a batch: multicall, a single prepared transaction, or an equivalent." | One Multicall3 `aggregate3Value` transaction | all-success: tx [`0xd49fce…3bda`](https://atlantic.pharosscan.xyz/tx/0xd49fceaf08ce9f5d0fa5f25e10cdf562490b35f3833ed569a92ad0ae54e43bda), block 31571864, 4 actions in 1 tx · [`proof/all-success.json`](proof/all-success.json) |
| 3 | "Reports the gas saving or step reduction compared with running them individually." | `gas:` line (sum of the actions' individual estimates vs gas used by the batch) and `steps:` line (N transactions → 1) | [`proof/all-success.json`](proof/all-success.json): 4 alone ≈ 221288 vs 134413 batched, saved 39.25% · see "Gas, honestly" below |
| 4 | "Handles partial failure clearly: which action failed and what happened to the rest." | The failing action is named with its decoded reason; the rest are read back from the chain as APPLIED | tx [`0x15dfe6…8ec9`](https://atlantic.pharosscan.xyz/tx/0x15dfe684a92a9188e6ad68f0871f44cf930a35a788c9d0fcbffa9743deaa8ec9), block 31571884: action 3 (1 USDC from an address holding none) NOT APPLIED with `ERC20InsufficientBalance`; actions 1, 2 and 4 APPLIED · [`proof/one-fails.json`](proof/one-fails.json) |

## The live runs (Atlantic)

Sender: wallet 1 `0x317bca01Bb101C0F1E86C21576a4e14D92B02975`. Recipients: our wallet 2 `0x8D34…D91B` and arbitrary addresses `0x1111…1111` … `0x6666…6666` (no one holds their keys; testnet dust).
The tokens are WPHRS (wrapped PHRS, the Atlantic token registry's `WPHRS`): we wrapped 0.003 PHRS ourselves first (tx [`0xb5bfd4…a427`](https://atlantic.pharosscan.xyz/tx/0xb5bfd4b2325a0926f0c43c2d1b5ccc45460cf801786088cae3f13b74e351a427), made with the [Dry-Run Executor](../dry-run-executor/README.md), calldata `deposit()`).
The `USDC` action fails on purpose: that wallet holds 0 USDC.

| Run | What | Result | Proof |
|---|---|---|---|
| 1 | `--plan all-success --approve --execute` | 4 of 4 APPLIED in one tx; 4 alone ≈ 221288 gas vs 134413 batched | [`all-success`](proof/all-success.json) · tx [`0xd49fce…3bda`](https://atlantic.pharosscan.xyz/tx/0xd49fceaf08ce9f5d0fa5f25e10cdf562490b35f3833ed569a92ad0ae54e43bda) |
| 2 | `--plan one-fails --approve --execute` | action 3 NOT APPLIED, 3 of 4 APPLIED; 3 comparable ≈ 154530 vs 119240 batched | [`one-fails`](proof/one-fails.json) · tx [`0x15dfe6…8ec9`](https://atlantic.pharosscan.xyz/tx/0x15dfe684a92a9188e6ad68f0871f44cf930a35a788c9d0fcbffa9743deaa8ec9) |
| 3 | `--plan one-fails --approve --drop-failing --execute` (the extra) | the failing action is dropped before sending; 3 of 3 APPLIED; ≈ 112849 vs 69135 | [`drop-failing`](proof/drop-failing.json) · tx [`0x6b03fd…9362`](https://atlantic.pharosscan.xyz/tx/0x6b03fd8aa250cf76e89e9b2cd1a0d7aea358f47ab934da1f54b79ecdb2309362) |

Output of the video's partial-failure run ([`proof/video-casts.log`](proof/video-casts.log), `--compact` layout; the default layout prints the full addresses and reasons):

```text
batch @ 31572054: 4 actions → 1 transaction via Multicall3
  1 0.0001 PHRS → 0x8D34…D91B      ok · alone 21000 gas
  2 0.0001 WPHRS → 0x4444…4444     ok · alone 45917 gas
  3 1 USDC → 0x5555…5555           WOULD FAIL: ERC20InsufficientBalance
  4 0.0003 WPHRS → 0x6666…6666     ok · alone 45932 gas
approved WPHRS for Multicall3: 0x0d1a…d062
SENT 0x29f6…604b · block 31572058 · gas used 85040
  1 APPLIED  0.0001 PHRS → 0x8D34…D91B
  2 APPLIED  0.0001 WPHRS → 0x4444…4444
  3 NOT APPLIED  1 USDC → 0x5555…5555 (ERC20InsufficientBalance)
  4 APPLIED  0.0003 WPHRS → 0x6666…6666
3 of 4 applied; the failure did not undo the rest
gas: 3 sent alone ≈ 112849 vs 85040 batched → saved 24.64%
steps: 3 transactions alone → 1
```

### The video's own runs

The video shows three more real runs, recorded while their proofs were written: [`video-all-success`](proof/video-all-success.json) (tx [`0xbb0912…e53f`](https://atlantic.pharosscan.xyz/tx/0xbb09121a18152298b12fb3ba18345daf40c133df12a1a010890a4a8beaefe53f)),
[`video-one-fails`](proof/video-one-fails.json) (tx [`0x29f65e…604b`](https://atlantic.pharosscan.xyz/tx/0x29f65e3194afca62c244ca4b2367da2ec29980ef65a3d1f41f6f14cbb39a604b), the one on the explorer shot) and
[`video-drop-failing`](proof/video-drop-failing.json) (tx [`0x5b6698…5906`](https://atlantic.pharosscan.xyz/tx/0x5b6698fbd658c3e5238483b3bc84e45771be1c83a274222d9310315dbff95906)).
Same plans, the narrow `--compact` layout, so their numbers differ slightly from runs 1–3 (gas estimates move with chain state).

## Gas, honestly

- "Alone" is `estimate_gas` of the plain send (`transfer` for a token, a plain value send for PHRS) at simulation time, **not** a measured transaction; "batched" is the gas the receipt says the batch used. The individual estimates move with chain state: the same WPHRS send was estimated at 66758 gas in run 1 and 45917 in the video runs (a recipient's first token balance costs more).
  So the percentages are for these plans on those blocks, not a constant. We measured only ERC-20 sends mixed with one PHRS send; we did not measure a batch of PHRS sends only.
- An action that would fail alone (run 2's USDC) has no individual estimate and is left out of the "alone" sum (`3 sent alone`), while the batch still paid for trying it. The comparison counts the batch's cost against the actions that could have run separately.
- The step reduction is exact: N transactions to sign and send, versus 1.

## Beyond the requirements: dry-run each action first, drop the ones that would fail

With `--drop-failing` the tool looks at the simulation first (the same `eth_call` and `estimate_gas` approach as the [Dry-Run Executor](../dry-run-executor/README.md), applied to the whole batch), removes every action that would fail, rebuilds the batch from the rest and simulates it again before anything is signed.
Run 3 above is that: the USDC action is listed as dropped with its reason, and the 3 remaining actions all apply (`proof/drop-failing.json` → `dropped`). If no action would succeed, nothing is sent (exit 3).
Without the flag a failing token action stays inside the batch (run 2), which is what requirement 4 asks to see.

## Limits

- **A failing PHRS action is never sent on purpose.** `aggregate3Value` keeps the PHRS of a call that failed inside Multicall3, so such a batch is BLOCKED ("its PHRS would stay stuck in Multicall3") unless `--drop-failing` removes the action. Token actions have no such problem.
- **An allowance to Multicall3 is an allowance anyone can route through Multicall3.** `--approve` raises it to exactly the batch total, and a run spends it; on a real wallet with real funds that is a risk you should weigh. This tool is Atlantic testnet only (the signer refuses any other chain).
- Multicall3 emits no per-action events, so "what happened to each action" is read from the recipients' balances (the received amount must equal the planned one). A recipient who also receives funds from someone else in the same block would confuse that check.
- Only PHRS and the five registry ERC-20s, only sends. Claims and arbitrary contract calls are not in the plan format.
- We did not deploy a batch contract; the spike found Multicall3 live on Atlantic (`get_code` returned its code), so there is no bytecode of ours in this task.

## Tests

`npm test` — 20 tests in [`test/batch.test.ts`](../../test/batch.test.ts): plan validation (minimum 3, repeated recipient, bad type / address / token / amount), the simulation per action and alone, a failing action named with its reason, a batch that reverts as a whole,
no send without `--execute`, an all-success batch with the gas comparison, a partial failure (named, the rest applied), `--drop-failing` (including the position fix for a trimmed batch), nothing sent when everything would fail, a failing PHRS action blocked,
a mined revert, a negative saving worded as "cost more", the compact layout, and the CLI's usage errors.
