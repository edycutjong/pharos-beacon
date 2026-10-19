# Batch Executor — Medium

**Live demo:** [pharos.edycu.dev/batch-executor](https://pharos.edycu.dev/batch-executor)

**Task:** [Batch Executor](https://pharos-agent-arena.vercel.app/tasks/batch-executor) (SkillEngine · Medium · 100 pts): a Skill that takes several independent actions and bundles them into one optimized execution.
**Run** (Atlantic testnet only; one-time `npm run setup:mcp`, keys in `~/.config/pharos/testnet.env`):
`npm run batch-executor -- --plan one-fails --from 0x317bca01Bb101C0F1E86C21576a4e14D92B02975` (keyless: simulates the batch as that sender, sends nothing; with `PRIVATE_KEY` set the sender is your own address) ·
`npm run batch-executor -- --plan <name|file.json> [--approve] [--drop-failing] [--execute] [--compact] [--proof name]`.
Without an allowance to Multicall3 the WPHRS actions simulate as WOULD FAIL (that is what a keyless run shows: the allowance is spent by each run), so the keyless `--plan one-fails` line above prints actions 2, 3 and 4 as WOULD FAIL (action 3 for the missing allowance, not for the missing USDC); `--approve --execute` gives it, and that is the run behind the partial-failure proof.
**Skill:** [`skills/batch-executor/SKILL.md`](../../skills/batch-executor/SKILL.md) · **Uses:** Chain MCP ✅ (`get_block_number`, `get_block`, `get_gas_price`, `eth_call`, `estimate_gas`, `get_balance`, `get_transaction_count`, `send_raw_transaction`, `get_transaction_receipt`); viem signs locally.

**In short:** four actions go out as **1 transaction instead of 4**, and the measured batch used **24.67% less gas** than sending the same four one by one. A token batch also needs a one-time `approve`; counted in, the first batch costs 1.50% more than sending alone (15.51% more when a PHRS recipient is a new account), and later batches skip it ([Gas, honestly](#gas-honestly)).

**Install as a skill:** `npx skills add https://github.com/edycutjong/pharos-beacon --skill batch-executor`.

## How it works

A **plan** ([`plans/all-success.json`](plans/all-success.json), [`plans/one-fails.json`](plans/one-fails.json)) lists at least 3 independent actions: a PHRS send (`native`) or an ERC-20 send (`erc20`: `WPHRS`, `USDC`, `USDT`, `WBTC`, `WETH`).
Each action needs its own asset-and-recipient pair (the same address may receive PHRS and WPHRS in one plan, but a pair that appears twice is refused with the action's number); a plan with fewer than 3 actions is refused with the count.

1. **Bundle.** All actions become calls of one transaction to Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`, already deployed on Atlantic; we did not deploy it): `aggregate3Value`, with `allowFailure = true` on every call, so one reverting action does not undo the others.
   Multicall3 is the caller, so an ERC-20 send is `transferFrom(you, recipient, amount)` against an allowance you give Multicall3; `--approve` raises it to exactly the plan's total per token (including an action that `--drop-failing` later removes).
2. **Simulate first.** One `eth_call` of the whole batch returns, per action, whether it would succeed (and its decoded revert reason if not). Each action is also estimated alone (`estimate_gas` of the plain send), and the batch itself is estimated.
3. **Send** (`--execute`): one signed transaction. Then every recipient's balance is read back, and each action is reported **APPLIED** (the recipient received exactly the amount) or **NOT APPLIED** with its reason.
4. **Report** the gas three ways, each labelled for what it is: the individual `estimate_gas` figures against the batch's `estimate_gas` (estimate vs estimate), the gas the batch's receipt says it used, and the saving once this run's one-time `approve` is counted; and the steps (N transactions → 1).

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Accepts a list of at least 3 independent actions." | The plan's `actions` list; fewer than 3, a repeated asset-and-recipient pair or a malformed action is refused (with the action's number, or the count) | [`plans/all-success.json`](plans/all-success.json) (4 actions), [`plans/one-fails.json`](plans/one-fails.json) (4) · `resolveActions` in [`src/batch/batch.ts`](../../src/batch/batch.ts) · tests "needs at least 3 actions", "rejects bad actions", "refuses a plan with fewer than 3 actions" |
| 2 | "Executes them as a batch: multicall, a single prepared transaction, or an equivalent." | One Multicall3 `aggregate3Value` transaction | all-success: tx [`0xd49fce…3bda`](https://atlantic.pharosscan.xyz/tx/0xd49fceaf08ce9f5d0fa5f25e10cdf562490b35f3833ed569a92ad0ae54e43bda), block 31571864, 4 actions in 1 tx · [`proof/all-success.json`](proof/all-success.json) |
| 3 | "Reports the gas saving or step reduction compared with running them individually." | The `gas, estimate vs estimate` line, the `gas used by the batch (receipt)` line, the line counting the approve, and the `steps:` line (N transactions → 1) | [`proof/all-success-mix.json`](proof/all-success-mix.json) ([log](proof/all-success-mix.log)): estimate vs estimate 221274 vs 175148 (20.84% less); the batch used 134401. **Measured one by one** (4 real sends, [dry-run proofs](../dry-run-executor/README.md)): 21000 + 3 × 52476 = 178428, so the batch saved 44027 gas, **24.67%**; counting its approve (46698) it used 181099, **1.50% more** than sending alone. See "Gas, honestly" |
| 4 | "Handles partial failure clearly: which action failed and what happened to the rest." | The failing action is named with its decoded reason; the rest are read back from the chain as APPLIED | tx [`0x15dfe6…8ec9`](https://atlantic.pharosscan.xyz/tx/0x15dfe684a92a9188e6ad68f0871f44cf930a35a788c9d0fcbffa9743deaa8ec9), block 31571884: action 3 (1 USDC from an address holding none) NOT APPLIED with `ERC20InsufficientBalance`; actions 1, 2 and 4 APPLIED · [`proof/one-fails.json`](proof/one-fails.json) |

## The live runs (Atlantic)

Sender: wallet 1 `0x317bca01Bb101C0F1E86C21576a4e14D92B02975`. Recipients: our second wallet `0x8D34…D91B` (`PRIVATE_KEY_2`, the one the other tasks use) and arbitrary addresses `0x1111…1111` … `0x6666…6666` (we hold no keys for them; testnet dust).
The tokens are WPHRS (wrapped PHRS, the Atlantic token registry's `WPHRS`) and USDC. The wallet already held some WPHRS; before the video runs we wrapped more PHRS (txs [`0xb5bfd4…a427`](https://atlantic.pharosscan.xyz/tx/0xb5bfd4b2325a0926f0c43c2d1b5ccc45460cf801786088cae3f13b74e351a427), block 31571942, and [`0xefae66…c57f`](https://atlantic.pharosscan.xyz/tx/0xefae660b4b6d3784fc129745ecf9b3398440222c0c06565f0a331638172ac57f), block 31572024: `deposit()` calldata sent with the [Dry-Run Executor](../dry-run-executor/README.md)'s `--data` option; that output is not committed as a proof).
The `USDC` action fails on purpose: that wallet holds 0 USDC.

Runs 1–3 were recorded with the first output format, which set the sum of the individual **estimates** against the batch's **receipt** (a mixed comparison that flatters the batch, see "Gas, honestly"); runs 4–5 use the current format.

| Run | What | Result | Proof |
|---|---|---|---|
| 1 | `--plan all-success --approve --execute` | 4 of 4 APPLIED in one tx; 4 alone ≈ 221288 gas (estimates) vs 134413 batched (receipt) | [`all-success`](proof/all-success.json) · tx [`0xd49fce…3bda`](https://atlantic.pharosscan.xyz/tx/0xd49fceaf08ce9f5d0fa5f25e10cdf562490b35f3833ed569a92ad0ae54e43bda) |
| 2 | `--plan one-fails --approve --execute` | action 3 NOT APPLIED, 3 of 4 APPLIED; 3 comparable ≈ 154530 vs 119240 batched | [`one-fails`](proof/one-fails.json) · tx [`0x15dfe6…8ec9`](https://atlantic.pharosscan.xyz/tx/0x15dfe684a92a9188e6ad68f0871f44cf930a35a788c9d0fcbffa9743deaa8ec9) |
| 3 | `--plan one-fails --approve --drop-failing --execute` (the extra) | the failing action is dropped before sending; 3 of 3 APPLIED; ≈ 112849 vs 69135 | [`drop-failing`](proof/drop-failing.json) · tx [`0x6b03fd…9362`](https://atlantic.pharosscan.xyz/tx/0x6b03fd8aa250cf76e89e9b2cd1a0d7aea358f47ab934da1f54b79ecdb2309362) |
| 4 | `--plan all-success-mix --approve --execute` (run 1's mix: PHRS to an existing wallet, three WPHRS sends to new addresses; plan recipients are random addresses we hold no keys for) | 4 of 4 APPLIED; estimate vs estimate 221274 vs 175148; batch used 134401 (run 1: 134413) | [`all-success-mix`](proof/all-success-mix.json) · [log](proof/all-success-mix.log) · tx [`0x180e4f…de27`](https://atlantic.pharosscan.xyz/tx/0x180e4f28c0f8354c885b473f655d87072574be594528ec01216d9ee1cef7de27), block 31580362 |
| 5 | `--plan all-success-fresh --approve --execute` (the same, but the PHRS recipient is also a new address) | 4 of 4 APPLIED; the batch used 159401, **25,000 more** than run 4: inside a batch the value call to an account that does not exist yet pays the new-account charge, which a plain top-level send does not (21000 either way, [executed.json](../dry-run-executor/proof/executed.json)) | [`all-success-fresh`](proof/all-success-fresh.json) · [log](proof/all-success-fresh.log) · tx [`0x16b33e…1d93`](https://atlantic.pharosscan.xyz/tx/0x16b33ee1a92751c3201dcd6ba1d2e0e16eef9018ad87ce253c3e63b9e1841d93), block 31580374 |

Output of the video's partial-failure run ([`proof/video-casts.log`](proof/video-casts.log), `--compact` layout; the default layout prints the full addresses and reasons):

```text
batch @ 31580419: 4 actions → 1 transaction via Multicall3
  1 0.0001 PHRS → 0x8D34…D91B      ok · alone 21000 gas
  2 0.0001 WPHRS → 0x4444…4444     ok · alone 45917 gas
  3 1 USDC → 0x5555…5555           WOULD FAIL: ERC20InsufficientBalance
  4 0.0003 WPHRS → 0x6666…6666     ok · alone 45932 gas
approved WPHRS for Multicall3: 0x7965…2cc1
approved USDC for Multicall3: 0x92c5…510d
SENT 0x68e1…6d98 · block 31580423 · gas used 85040
  1 APPLIED  0.0001 PHRS → 0x8D34…D91B
  2 APPLIED  0.0001 WPHRS → 0x4444…4444
  3 NOT APPLIED  1 USDC → 0x5555…5555 (ERC20InsufficientBalance)
  4 APPLIED  0.0003 WPHRS → 0x6666…6666
3 of 4 applied; the failure did not undo the rest
gas est.: alone 112849 vs batch 114050 → costs more by 1.06%
gas used by the batch (receipt): 85040
with approve (+93635): 178675 used
steps: 3 transactions alone → 1 (+2 approve tx this run)
```

The current format, run 4 (full layout, from [`proof/all-success-mix.log`](proof/all-success-mix.log)):

```text
$ npm run batch-executor -- --plan all-success-mix --approve --execute --proof all-success-mix
batch @ block 31580358: 4 action(s) → 1 transaction to Multicall3 0xcA11bde05977b3631167028862bE2a173976CA11
  1. send 0.0001 PHRS to 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B     would succeed · alone 21000 gas
  2. send 0.00001 WPHRS to 0xf8d18da5696e48931F67F5c781aAB88312D899FA   would succeed · alone 66758 gas
  3. send 0.00002 WPHRS to 0xcf324672aF13fE8C36c198Fd2a08379FE3c6D4B9   would succeed · alone 66758 gas
  4. send 0.00003 WPHRS to 0x608795D4fb4e2a1F78CED363d669bA98DA305d08   would succeed · alone 66758 gas
  batch gas estimate 175148 × 1000000000 wei = 0.000175148 PHRS
approved Multicall3 to move WPHRS: https://atlantic.pharosscan.xyz/tx/0x6f5217f2f304672fa3ddc74f67eef5265aefd0be3444634846066396c9608369
SENT: https://atlantic.pharosscan.xyz/tx/0x180e4f28c0f8354c885b473f655d87072574be594528ec01216d9ee1cef7de27 (block 31580362, gas used 134401)
per action, read back from the chain:
  1. APPLIED  send 0.0001 PHRS to 0x8D347c72431ed6E033d5f43E56c0987E97f5D91B — recipient received 0.0001 PHRS
  2. APPLIED  send 0.00001 WPHRS to 0xf8d18da5696e48931F67F5c781aAB88312D899FA — recipient received 0.00001 WPHRS
  3. APPLIED  send 0.00002 WPHRS to 0xcf324672aF13fE8C36c198Fd2a08379FE3c6D4B9 — recipient received 0.00002 WPHRS
  4. APPLIED  send 0.00003 WPHRS to 0x608795D4fb4e2a1F78CED363d669bA98DA305d08 — recipient received 0.00003 WPHRS
  all 4 applied
gas, estimate vs estimate (like for like): 4 action(s) sent one by one ≈ 221274 vs the batch ≈ 175148 → saves 20.84%
gas used by the batch (receipt): 134401 (its own estimate was 175148; estimates run high on token transfers, so the one-by-one figures above are probably high too: README "Gas, honestly")
counting this run's approve transaction(s) (46698 gas used): the batch used 181099 gas in all, for 4 actions that cost ≈ 221274 one by one by estimate
steps: 4 transactions to sign and send alone → 1 batch transaction (+1 one-time approve transaction this run: the allowance Multicall3 needs; see "Gas, honestly" in the README)
```

### The video's own runs

The video shows three more real runs, recorded again after the gas lines were reworded (the first recordings carried the mixed estimate-against-receipt line): [`video-all-success`](proof/video-all-success.json) (plan `video-all-success`: run 4's mix with new recipients; tx [`0x2ff703…4680`](https://atlantic.pharosscan.xyz/tx/0x2ff703bec4a23bbf8976a19848e398a7b889a9d662bef6a958c62ab58dc14680)), [`video-one-fails`](proof/video-one-fails.json) (tx [`0x68e15d…6d98`](https://atlantic.pharosscan.xyz/tx/0x68e15d5cd6afdda7d0d403746e4d57578ebdf76c26df19b37349d5ba48d66d98), the one on the explorer shot) and [`video-drop-failing`](proof/video-drop-failing.json) (tx [`0xf473d3…363a`](https://atlantic.pharosscan.xyz/tx/0xf473d37417dfe22a97a2a61dd4f3484c2a07c5ff0f59f5993a965eeff46e363a)). Same plans as runs 2–3, the narrow `--compact` layout ([`proof/video-casts.log`](proof/video-casts.log)). The partial-failure run's `gas est.` line says "costs more by 1.06%" because the one-by-one sum leaves out the failing USDC action while the batch estimate includes trying it (see below); runs 2–3's recipients are no longer new addresses, so their estimates are lower than run 1's.

## Gas, honestly

- **The first version of the saving was too good.** Runs 1–3 set the sum of the individual `estimate_gas` figures against the batch's receipt. `estimate_gas` runs high on token transfers: the Dry-Run Executor sent a WPHRS transfer to a new address four times, each time estimated at 66758 gas and used 52476 gas (−21.39%: [`alone-cold-wphrs-1`](../dry-run-executor/proof/alone-cold-wphrs-1.json), [`-2`](../dry-run-executor/proof/alone-cold-wphrs-2.json), [`-3`](../dry-run-executor/proof/alone-cold-wphrs-3.json) and [`token-transfer`](../dry-run-executor/proof/token-transfer.json)), while a plain PHRS send is exactly 21000 ([`executed`](../dry-run-executor/proof/executed.json)). So run 1's "saved 39.25%" is not what sending the four actions separately would have cost.
- **Measured against measured, run 1's mix** (run 4 is the same mix again and used 134401 against run 1's 134413): sending the four actions one by one costs 21000 + 3 × 52476 = **178428** gas; the batch used **134401**, a saving of 44027 gas (**24.67%**). Estimate against estimate (what the CLI now prints first) gives 221274 vs 175148, 20.84% less.
- **Counting the one-time `approve`** (46698 gas, because the token actions need an allowance to Multicall3): 134401 + 46698 = 181099, which is **1.50% more** than the 178428 of sending alone. The first batch only pays off if the allowance is reused; once it exists, later batches skip the approve. Runs 2 and 3 (which had a failing action or two approvals) cost more with their approves counted, as recorded before.
- **The saving depends on the recipients.** With a new PHRS recipient as well (run 5) the batch used 159401 gas, so against 21000 + 3 × 52476 the saving falls to 19027 gas, **10.66%**, and with the approve (46698) the batch is 206099, **15.51% more** than sending alone. Native value to an account that does not exist yet costs 25,000 extra inside Multicall3 (run 5 against run 4, same everything else).
- Of the figures above only the measured sends (the four dry-run proofs and the run receipts) are transactions; "alone" for the runs themselves is never re-measured per plan, it is derived here from those sends because the actions are the same kind (a plain PHRS send; a WPHRS transfer to an address with no balance yet). A WPHRS transfer to an address that already holds the token costs less (the video runs estimated 45917), so the percentages are for these plans, not a constant. We did not measure a batch of PHRS sends only.
- An action that would fail alone (run 2's USDC) has no individual estimate and is left out of the "alone" sum (`3 sent alone`), while the batch still paid for trying it. The comparison counts the batch's cost against the actions that could have run separately.
- The step reduction is exact for the batch itself: N transactions to sign and send, versus 1. The approve is an extra transaction in the run that needs it (about 46.7k gas: 1 in runs 1, 3, 4 and 5, 2 in run 2 because of the USDC action).

## Beyond the requirements: dry-run each action first, drop the ones that would fail

With `--drop-failing` the tool looks at the simulation first (the same `eth_call` and `estimate_gas` approach as the [Dry-Run Executor](../dry-run-executor/README.md), applied to the whole batch), removes every action that would fail, rebuilds the batch from the rest and simulates it again before anything is signed.
Run 3 above is that: the USDC action is listed as dropped with its reason, and the 3 remaining actions all apply (`proof/drop-failing.json` → `dropped`). If no action would succeed, no batch is sent (exit 3). With `--approve`, the approvals for the whole plan are sent before the simulation, since the simulation needs the allowance to pass.
Without the flag a failing token action stays inside the batch (run 2), which is what requirement 4 asks to see.

## Limits

- **A failing PHRS action is never sent on purpose.** `aggregate3Value` keeps the PHRS of a call that failed inside Multicall3, so such a batch is BLOCKED ("its PHRS would stay stuck in Multicall3") unless `--drop-failing` removes the action. Token actions have no such problem.
- **Multicall3's own README warns against this design:** its Security section says "Never approve Multicall3 to spend your tokens. If you do, anyone can steal your tokens." ([mds1/multicall](https://github.com/mds1/multicall#security), read 2026-10-18). Our token path needs exactly that allowance. What limits the exposure here: Atlantic testnet only, an allowance of exactly the plan's total, and demo-dust balances. A production version should use a batch contract that only the owner can call (not built here: it would be a contract of ours to deploy and audit).
- **An allowance to Multicall3 is an allowance anyone can route through Multicall3.** `--approve` raises it to exactly the plan's total, and a run spends the allowance of the actions that apply (the allowance of an action that fails stays open: run 2 left 1 USDC approved on the demo wallet, which we revoked afterwards in tx [`0x0027ad…55c3`](https://atlantic.pharosscan.xyz/tx/0x0027ad9c7d5ba711647da8ac9c1ae3ab0e03fa174eef69909286bba08e7b55c3), and the video's partial-failure recording did the same and was revoked in tx [`0xe6f324…1262`](https://atlantic.pharosscan.xyz/tx/0xe6f324f00dc2d1934bd4642d9760ae2d04ce168d60aaf5c8b453f19c1b911262)); on a real wallet with real funds that is a risk you should weigh. This tool is Atlantic testnet only (the signer refuses any other chain).
- Multicall3 emits no per-action events, so "what happened to each action" is read from the recipients' balances (the received amount must equal the planned one). A recipient who also receives funds from someone else in the same block would confuse that check.
- `--proof <name>` writes `tasks/batch-executor/proof/<name>.json`, the only file any variant of the command writes (the keyless simulation writes nothing).
- Only PHRS and the five registry ERC-20s, only sends. Claims and arbitrary contract calls are not in the plan format.
- We did not deploy a batch contract; the spike found Multicall3 live on Atlantic (`get_code` returned its code), so there is no bytecode of ours in this task.

## Tests

`npm test` — 23 tests in [`test/batch.test.ts`](../../test/batch.test.ts): plan validation (minimum 3, repeated recipient, bad type / address / token / amount), the simulation per action and alone, a failing action named with its reason, a batch that reverts as a whole,
no send without `--execute`, an all-success batch with the gas comparison, a partial failure (named, the rest applied), `--drop-failing` (including the position fix for a trimmed batch), nothing sent when everything would fail, a failing PHRS action blocked,
a mined revert, a negative saving worded as "cost more", the gas lines (estimate vs estimate, the receipt, the approve counted), the compact layout, and the CLI's usage errors (including `--from`).
