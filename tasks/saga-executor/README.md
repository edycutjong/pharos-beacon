# Saga Executor — Hard

**Task:** [Saga Executor](https://pharos-agent-arena.vercel.app/tasks/saga-executor) (SkillEngine · Hard · 200 pts): a multi-step, dependent on-chain workflow (approve → swap → deposit) that retries or rolls back cleanly instead of leaving funds stranded halfway.

**Read this first: the pool and the vault are ours.** Pharos Atlantic has no DEX or vault to run a swap and a deposit against, so we deployed two small test contracts ([`contracts/src/SagaTest.sol`](contracts/src/SagaTest.sol), Foundry, not audited): `SagaPool`, a fixed-rate pool (1 WPHRS = 100 USDC, no fee, so a swap is exactly reversible) at [`0x88176Fb0…Fdac8`](https://atlantic.pharosscan.xyz/address/0x88176Fb095C178446816F5a1D7C32E35af1Fdac8) (deploy tx [`0x7027250b…05bd`](https://atlantic.pharosscan.xyz/tx/0x7027250bc69190d64c6422d64b9b28fcbf14fc4768fc60896fecca24178a05bd)), and `SagaVault`, which takes USDC 1:1 for shares and can be closed by its owner, at [`0xEAd78727…2671`](https://atlantic.pharosscan.xyz/address/0xEAd78727Ab9523622C4fE706D15059A551502671) (deploy tx [`0x80ba12b6…9441`](https://atlantic.pharosscan.xyz/tx/0x80ba12b667c8e5cf7b8866415a6f284f2b5b1239846327a09ceeda6b4f949441)). They move the real Atlantic test tokens (the registry USDC `0xcfC8…Fc8B` and WPHRS `0x8388…9471`). The saga logic is the product; the contracts only give it something to run against. Addresses and seed transactions: [`deployments.json`](deployments.json).

**Run** (Atlantic testnet only; keys in `~/.config/pharos/testnet.env`, never printed):
`npm run saga-executor -- plan|run|resume|status|vault [--id name] [--amount 0.001] [--inject drop:swap,underpriced:swap,crash:swap:sent] [--retries 3] [--backoff-ms 2000] [--receipt-timeout-s 30] [--execute] [--proof name]`.
`plan` (needs no key) and `status` send nothing; `run` and `resume` need `--execute`. Exit codes: 0 completed · 3 rolled back cleanly · 1 stuck or error · 2 bad usage.
**Uses:** Pharos Chain MCP (local stdio server for Atlantic) for every read and the broadcast, viem for local signing and ABI encoding, a SkillEngine-format [`SKILL.md`](../../skills/saga-executor/SKILL.md).

## What the saga does

Four dependent steps, each a transaction that is signed, journaled, sent, waited for and **verified by reading the chain back** before the next starts:

| # | Step | Verified by |
|---|---|---|
| 1 | `approve-in`: approve the pool to pull 0.001 WPHRS | the allowance read back equals the amount |
| 2 | `swap`: swap it for USDC in the pool | the pool's `Swap` event, the output at least the pool's quote less 0.5%, and both token balances read back |
| 3 | `approve-out`: approve the vault to pull the swap output | the allowance read back equals the output |
| 4 | `deposit`: deposit the output into the vault | the `Deposit` event and the vault shares read back |

Step 3 reads the swap output the journal recorded in step 2, so the steps really depend on each other. **Retry:** a transient failure is retried up to 3 sends, waiting 2 s then 4 s, on the **same nonce** with the max fee raised by 25% (or to the current fee if that is higher), so at most one of the sends can land. **Rollback:** a permanent failure (a revert, a receipt with status 0, a read-back that does not match, anything unrecognised) stops the saga and undoes every step that landed, newest first; each undo is also a verified transaction. At the end a **balance-invariant table** re-reads six values and compares them with their pre-saga values.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "At least 3 dependent steps, each verified (receipt checked) before the next starts." | 4 steps. `runAction` waits for the receipt, rejects status 0, then runs the step's `verify` (a chain read-back) before the next action is touched; step 3 and 4 build their calldata from step 2's recorded output. | [`engine.ts:332`](../../src/saga/engine.ts), verifiers in [`defi.ts:93-150`](../../src/saga/defi.ts); log lines `MINED` then `VERIFIED` for each step in [`proof/success.txt`](proof/success.txt); [`success.json`](proof/success.json) |
| 2 | "A defined retry policy for transient failures, e.g. a gas spike or dropped transaction." | `DEFAULT_POLICY`: 3 sends, backoff 2 s × 2ⁿ⁻¹, +25% fee, same nonce. `classify()` marks fee refusals, timeouts and throttling transient and fails closed on anything else. The proof shows both examples: a swap sent with a 1 wei fee (the node answers "effective gas price less than base fee") and a dropped `approve-out` (signed, never sent, no receipt in 15 s). | [`engine.ts:151`](../../src/saga/engine.ts), [`:180`](../../src/saga/engine.ts); [`proof/retry.json`](proof/retry.json): swap attempt 1 (fee 1 wei) refused, attempt 2 (fee 2000000000 wei) mined, same nonce 43; `approve-out` attempt 2 fee 2500000000 wei after 2000000000 wei |
| 3 | "A defined compensation/rollback path when a step permanently fails, and a demo of it." | `undo(step)` per step (revoke approval, swap back, withdraw), run newest first, each verified. Demo: the vault owner closes the vault; the deposit is refused (`VaultClosed()`); the saga undoes `approve-out`, the swap (approve, swap back) and finds the `approve-in` allowance already spent. | [`engine.ts:304`](../../src/saga/engine.ts); [`proof/forced-failure.json`](proof/forced-failure.json); vault closed by [`0x0d4fa68a…9ef7`](https://atlantic.pharosscan.xyz/tx/0x0d4fa68ae9ef7b61d02406b1078db5bd675f67ce92ffe0ea77e7b53163439ef7) |
| 4 | "A state log showing exactly which step the saga is in at any time." | Every transition (RUNNING, SIGNED, SENT, MINED, VERIFIED, TRANSIENT, RETRY, FAILED, COMPENSATING, …) is appended to the journal with the step number and printed live; `status --id` shows the current step from the journal at any time, also after a crash. | `journal.log` in every proof JSON; [`proof/crash-resume-2-status.txt`](proof/crash-resume-2-status.txt) (`now at swap (2/4)` after the process was killed) |
| 5 | "Shows one fully successful run and one forced-failure run with recovery." | `success` and `forced-failure` runs on Atlantic. The failed run ends `ROLLED-BACK` with all 6 invariant reads PASS. | [`proof/success.json`](proof/success.json), [`proof/forced-failure.json`](proof/forced-failure.json) |

## Proof (Atlantic testnet, all status 1)

| Run | Command | Result | Transactions |
|---|---|---|---|
| Success | `run --id saga-ok --execute --proof success` | COMPLETED, 6/6 invariant reads PASS | approve-in [`0xc8e50c97…f251`](https://atlantic.pharosscan.xyz/tx/0xc8e50c97d5d587d9900be127e85a1082979bf7ac6339c5fcb956b5f0204bf251) · swap [`0xbb3d6df1…c0a7`](https://atlantic.pharosscan.xyz/tx/0xbb3d6df12d1b4335b88ae5d027ba0788745d28435aeaa5392e1b9d73cecfc0a7) · approve-out [`0x63c0acd7…064b`](https://atlantic.pharosscan.xyz/tx/0x63c0acd75e2cfa15f1c46c3001276e5535b4f498d1ef0cb78938d53870db064b) · deposit [`0x5d0cef39…1de8`](https://atlantic.pharosscan.xyz/tx/0x5d0cef391669db86b04bca8cd4ef44355ab97537033e8ba9f1d34dc8b1e41de8) |
| Retries | `run --id saga-retry --execute --inject underpriced:swap,drop:approve-out --backoff-ms 1000 --receipt-timeout-s 15 --proof retry` | COMPLETED; swap 2 sends, approve-out 2 sends | approve-in [`0x6390b7dc…2145`](https://atlantic.pharosscan.xyz/tx/0x6390b7dcfe27384df320bb79b2f5fe5578bb5dbba1dc9ffeea9eb4f4afdd2145) · swap [`0xebd6b215…4a7e`](https://atlantic.pharosscan.xyz/tx/0xebd6b21529a70f4e0460318722fde327e8ba9783767fbe0073b6f44fd9254a7e) · approve-out [`0x455d593e…62be`](https://atlantic.pharosscan.xyz/tx/0x455d593e7f11d92f810500dc6a090a0df7a8b6f66dbacae11d93818d210662be) · deposit [`0xa9e25b82…da5c`](https://atlantic.pharosscan.xyz/tx/0xa9e25b82ae711b60e1ff08a04fcd2e4f242fcff713fa29d313cf7ea7a536da5c) |
| Forced failure | `vault close --execute`, then `run --id saga-fail --execute --proof forced-failure` | deposit FAILED (`VaultClosed()`), ROLLED-BACK, 6/6 PASS | approve-in [`0x3655d451…8cb6`](https://atlantic.pharosscan.xyz/tx/0x3655d451320b69b3688fb00275a061dd105d3b0b93b6d5c27d19258643b18cb6) · swap [`0x72b3ccdc…c2e4`](https://atlantic.pharosscan.xyz/tx/0x72b3ccdcb958955803582695373471d06277a522834de3dc48ec49b4b296c2e4) · approve-out [`0x5204ac0b…dcad`](https://atlantic.pharosscan.xyz/tx/0x5204ac0b2b78731576a9ff26b7c36e29ad454627108878fd386114bb050fdcad) · undo-approve-out [`0xbc92db32…ccab`](https://atlantic.pharosscan.xyz/tx/0xbc92db3289efdd9ac09d571d5e1d8b409987f5dd5b10ca75bcb46e4b55b7ccab) · undo-swap-approve [`0xebe13caa…8b88`](https://atlantic.pharosscan.xyz/tx/0xebe13caa13c98b09202b3e9038846a896fd2b11ffe379287f7f4dbeb635b8b88) · undo-swap [`0xb0227f70…f88d`](https://atlantic.pharosscan.xyz/tx/0xb0227f70fdcf5bd4227edd24537251705d610597f197738a4fad0c63b00af88d); vault closed [`0x0d4fa68a…9ef7`](https://atlantic.pharosscan.xyz/tx/0x0d4fa68ae9ef7b61d02406b1078db5bd675f67ce92ffe0ea77e7b53163439ef7), reopened [`0x687faad0…faae`](https://atlantic.pharosscan.xyz/tx/0x687faad07b6093188d43e1f0a31cd9fcd67e2484ef6d8b2d702a719b32b2faae) |
| Crash-resume | `run --id saga-crash --execute --inject crash:swap:sent` (process SIGKILLed), then `resume --id saga-crash --execute --proof crash-resume` | COMPLETED, 6/6 PASS, the swap sent once | approve-in [`0x3c7c647f…6f49`](https://atlantic.pharosscan.xyz/tx/0x3c7c647f69c2a0c750d0c3f017bdafce9ec3040459ac97725501e1a894146f49) · swap [`0x1eb4d4e4…97ab`](https://atlantic.pharosscan.xyz/tx/0x1eb4d4e4c2b344aeb366002a4afe782334a35972ac291a082e07728900a197ab) · approve-out [`0xe5e8eba4…0798`](https://atlantic.pharosscan.xyz/tx/0xe5e8eba43c272be883bd0c3a8d1df14fd6b690f8f3476e052b20f509cfcf0798) · deposit [`0x8b790cd3…2a2e`](https://atlantic.pharosscan.xyz/tx/0x8b790cd33761e892dab88ec76592b88b9f54becc45beae3b3cebc934e9d82a2e) |

Commit and clean tree: each proof JSON records `git.dirty: false`. The forced failure also shows `undo-swap-revoke` and `undo-approve-in` as `skipped`: the swap and the swap-back consumed those allowances exactly, so there was nothing to revoke (the engine reads the allowance first and sends nothing when it already is 0).

### Forced failure (output of the run, abridged to the failure and the rollback)

```text
13:33:34  deposit           REFUSED        attempt 1 could not be prepared: reverted: VaultClosed()
13:33:34  deposit           FAILED         revert: reverted: VaultClosed()
13:33:34  saga              COMPENSATING   step deposit failed permanently (revert): rolling back what landed
13:33:34  saga              ROLLBACK-PLAN  undo approve-out, swap, approve-in (newest first)
13:33:38  undo-approve-out  MINED          0xbc92db3289efdd9ac09d571d5e1d8b409987f5dd5b10ca75bcb46e4b55b7ccab block 31824419 status 1 gas 33501
13:34:24  undo-swap         MINED          0xb0227f70fdcf5bd4227edd24537251705d610597f197738a4fad0c63b00af88d block 31824458 status 1 gas 70058
13:34:24  undo-swap         VERIFIED       balances read back: WPHRS 0.0668 (before the swap 0.0668), USDC 0.579 (before 0.579)
13:34:25  undo-swap-revoke  SKIPPED        the state this would produce already holds
13:34:25  undo-approve-in   SKIPPED        the state this would produce already holds
13:34:27  saga              ROLLED-BACK    balance invariant holds for all 6 reads

balance invariant (every touched balance must equal its pre-saga value):
PASS  WPHRS balance            0.0668    expected 0.0668
PASS  USDC balance             0.579     expected 0.579
PASS  WPHRS allowance to pool  0         expected 0
PASS  USDC allowance to pool   0         expected 0
PASS  USDC allowance to vault  0         expected 0
PASS  vault shares             0.5       expected 0.5
```

### Retries (output of the run, swap and approve-out only)

```text
13:32:12  swap              SIGNED         attempt 1/3 nonce 43 0xc63d103b1dd1a598160c2c56cb8907368e79b2fd64740ad411beb8d7d4fdefdb maxFee 1 wei
13:32:15  swap              TRANSIENT      attempt 1 refused by the node (send_raw_transaction: INVALID_PARAMS: effective gas price less than base fee (code -32602))
13:32:15  swap              RETRY          backing off 1000 ms, then attempt 2/3 on the same nonce with a higher fee
13:32:16  swap              SIGNED         attempt 2/3 nonce 43 0xebd6b21529a70f4e0460318722fde327e8ba9783767fbe0073b6f44fd9254a7e maxFee 2000000000 wei (bumped from 1)
13:32:19  swap              MINED          0xebd6b21529a70f4e0460318722fde327e8ba9783767fbe0073b6f44fd9254a7e block 31824357 status 1 gas 70289
13:32:20  approve-out       SIGNED         attempt 1/3 nonce 44 0x1a086d0d4412a4df46e792158bf1ae923709fd6a73ca74a5ad476a66bc85508e maxFee 2000000000 wei
13:32:20  approve-out       INJECTED-DROP  signed but never sent: the receipt wait must time out and the retry recover
13:32:33  approve-out       TRANSIENT      attempt 1: no receipt for 0x1a086d0d4412a4df46e792158bf1ae923709fd6a73ca74a5ad476a66bc85508e within 15 s (dropped, or the fee was too low)
13:32:33  approve-out       RETRY          backing off 1000 ms, then attempt 2/3 on the same nonce with a higher fee
13:32:34  approve-out       SIGNED         attempt 2/3 nonce 44 0x455d593e7f11d92f810500dc6a090a0df7a8b6f66dbacae11d93818d210662be maxFee 2500000000 wei (bumped from 2000000000)
13:32:36  approve-out       MINED          0x455d593e7f11d92f810500dc6a090a0df7a8b6f66dbacae11d93818d210662be block 31824369 status 1 gas 55437
```

## Beyond the requirements: crash-resume

The journal is written before every send. Kill the process mid-saga and the next run continues from it: a step that is verified is never repeated; an attempt whose receipt already exists is verified; one the node no longer knows is sent again as the **same signed bytes** (same nonce, same hash, so at most one effect). Real run: the process was killed with SIGKILL right after the swap was sent.

```text
13:34:50  swap              INJECTED-CRASH process killed at sent
exit=137
saga saga-crash: RUNNING · now at swap (2/4)
action                    state     tries       tx
approve-in                verified  1 attempt   0x3c7c647f69c2a0c750d0c3f017bdafce9ec3040459ac97725501e1a894146f49
swap                      running   1 attempt   0x1eb4d4e4c2b344aeb366002a4afe782334a35972ac291a082e07728900a197ab
approve-out               pending               
deposit                   pending               
...
13:34:53  saga              RESUMED        from the journal, status running
13:34:53  swap              RECOVERED      journal says sent; the chain already has 0x1eb4d4e4c2b344aeb366002a4afe782334a35972ac291a082e07728900a197ab mined
13:34:53  swap              VERIFIED       Swap event: 0.001 WPHRS → 0.1 USDC (quote 0.1, floor 0.0995); balances read back: WPHRS 0.0658, USDC 0.679
```

The swap was sent once ([`0x1eb4d4e4…97ab`](https://atlantic.pharosscan.xyz/tx/0x1eb4d4e4c2b344aeb366002a4afe782334a35972ac291a082e07728900a197ab)); the other three steps run after the resume. The tests kill the process at `signed`, `sent` and `mined`, and also in the middle of a rollback ([`test/saga-executor.test.ts`](../../test/saga-executor.test.ts)).

## Limits

- The pool and the vault are our own test contracts on Atlantic, with a fixed rate and no fee; a real DEX would need slippage to be set from a live quote and a swap-back would not be exact. The saga checks the swap output against the pool's quote (0.5% floor), and the rollback checks that balances are exactly restored, which only holds because this pool has no fee.
- The forced failure is the deposit being refused in the pre-flight simulation (`estimate_gas` reverts with `VaultClosed()`), so no failed transaction is mined for it. A transaction mined with status 0 is also treated as permanent (test `a transaction mined with status 0 is permanent`).
- The "gas spike" and the "dropped transaction" are injected (`--inject`): a 1 wei fee that the node really refuses, and a signed transaction that is really never sent. The recovery path is the real one; the trigger is ours.
- Rollback costs gas that is not refunded (the run prints it). A rollback that itself fails permanently leaves the saga `stuck` with the action named; it does not guess.
- Atlantic testnet only; the signer refuses any other chain. One wallet (`PRIVATE_KEY_2`) runs the saga; the vault owner (`PRIVATE_KEY`) is a different party.
- Earlier runs of this saga on the same wallet (two scratch runs and two proofs discarded for a dirty tree) left USDC in the vault; the vault-shares row of the invariant table is relative to each run's own start.

## Tests

`npm test`: 23 tests in [`test/saga-executor.test.ts`](../../test/saga-executor.test.ts) (an in-memory chain; success, every retry path, the rollback paths, a stuck rollback, crash-resume at three points and mid-rollback, CLI usage errors), 870 in the repo. `npm run typecheck` is clean.
