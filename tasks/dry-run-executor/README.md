# Dry-Run Executor — Medium

**Task:** [Dry-Run Executor](https://pharos-agent-arena.vercel.app/tasks/dry-run-executor) (SkillEngine · Medium · 100 pts):
simulates a transaction's outcome/cost before submitting for real.
**Run:** `npm run dry-run-executor -- (--to 0x… --value 0.0001 | --token USDC --to 0x… --amount 1.5 | --to 0x… --data 0x…) [--execute] [--proof name]`
(Atlantic needs the one-time `npm run setup:mcp`, keyless for simulation with `--from 0x…`; no key needed.) Without `--execute` nothing is ever signed or sent.
**Uses:** Chain MCP ✅ (`eth_call`, `estimate_gas`, `get_balance`, `get_block`, `get_gas_price`, and for `--execute` nonce, broadcast, receipt) ·
SkillEngine ✅ packaged as an agent skill, [`skills/dry-run-executor/`](../../skills/dry-run-executor/SKILL.md) · Docs MCP: not used

**Install as a skill:** `npx skills add https://github.com/edycutjong/pharos-beacon --skill dry-run-executor`.

## Requirements → evidence

| # | Arena requirement | How it is met | Evidence |
|---|---|---|---|
| 1 | "Uses a call or gas estimation to simulate the transaction without broadcasting it." | `simulate` in [`src/dryrun/simulate.ts`](../../src/dryrun/simulate.ts) calls `eth_call` and `estimate_gas` with the sender, target, value and data; the only code path that signs is `send`, which `dryRun` reaches only after a passing simulation and only with `--execute` | [`proof/blocked.json`](proof/blocked.json) (`mcp` + command), [`proof/executed.json`](proof/executed.json) |
| 2 | "Reports predicted success or revert, including the revert reason when available, and estimated gas cost." | `WOULD SUCCEED` / `WOULD FAIL — <reason>`; revert bytes are decoded (`Error(string)`, `Panic`, OpenZeppelin token errors); a node refusal and a failed estimate are reported as such; the fee is `gas × (base fee + priority fee)` in PHRS | [blocked.log](proof/blocked.log): `reverted: ERC20InsufficientBalance(0x317b…, 0, 1000000000000000)` · [executed.log](proof/executed.log): `gas 21000 × 1000000000 wei = 0.000021 PHRS fee` |
| 3 | "Shows the expected outcome, e.g. balances or state before and after where possible." | Sender and recipient balances before → after (PHRS; for an ERC-20 `transfer` also both token balances via `balanceOf`), labelled "predicted" | [executed.log](proof/executed.log): `sender 14.941825638999979 → 14.941704638999979 PHRS (predicted)` · `recipient 0 → 0.0001 PHRS (predicted)` |
| 4 | "Blocks execution automatically if the simulation fails." | A failed simulation returns status `blocked`, exit code 3, and `send` is never called. A test hands in a sender that throws and runs `--execute` against a revert | [`test/dryrun.test.ts`](../../test/dryrun.test.ts) "never calls the sender when the simulation fails" · live: [blocked.json](proof/blocked.json) (`status: blocked`, no tx) |

## Beyond the requirements: how accurate was the prediction?

After a real send the tool reads the receipt and the balances back and compares them with what it predicted:
gas predicted vs used, fee predicted vs paid, every balance predicted vs on-chain, with the difference. In the live run
the prediction was exact (21000 gas predicted, 21000 used; both balances matched to the wei). That is the easy case: a plain
PHRS transfer has no variable gas. For a contract call the gas used is usually lower than the estimate, and the report shows by how much.

## Proof (live runs on Atlantic, chain 688689)

| Run | Result | Files |
|---|---|---|
| Failing simulation, blocked: transfer of 1,000,000,000 USDC from a wallet that holds none | `WOULD FAIL — reverted: ERC20InsufficientBalance(…, 0, 1000000000000000)`, `BLOCKED`, exit 3, no transaction exists | [`proof/blocked.json`](proof/blocked.json) · [log](proof/blocked.log) |
| Passing simulation, then the real send to a fresh address `0x0Ef32f97…aD4B` | [tx `0x10e59880…0628`](https://atlantic.pharosscan.xyz/tx/0x10e5988d3fd55808cc71c5e136b31918eba9c9659dcc57f76baa4621218c0628), block 31564576, `success`, 21000 gas = the estimate | [`proof/executed.json`](proof/executed.json) · [log](proof/executed.log) |

A third run, simulation only (no `--execute`, the same fresh address, which by then held 0.0001 PHRS), is kept as a log: [`proof/simulate.log`](proof/simulate.log) (`not sent: pass --execute to send it`).
Both proof JSON files were produced by the commit they record, with `dirty: false`.

```text
$ npm run dry-run-executor -- --to 0x0Ef32f97565aDB7BDf3538b934F65877A848aD4B --value 0.0001 --execute --proof executed
simulation @ block 31564575: WOULD SUCCEED
  from 0x317bca01Bb101C0F1E86C21576a4e14D92B02975 → to 0x0Ef32f97565aDB7BDf3538b934F65877A848aD4B · value 0.0001 PHRS
  gas 21000 × 1000000000 wei = 0.000021 PHRS fee
  sender    14.941825638999979 → 14.941704638999979 PHRS (predicted)
  recipient 0 → 0.0001 PHRS (predicted)
SENT: https://atlantic.pharosscan.xyz/tx/0x10e5988d3fd55808cc71c5e136b31918eba9c9659dcc57f76baa4621218c0628 (block 31564576)
prediction vs receipt: gas 21000 → 21000 used (0.00%) · fee 0.000021 → 0.000021 PHRS
  sender    PHRS: predicted 14.941704638999979, chain says 14.941704638999979 (exact)
  recipient PHRS: predicted 0.0001, chain says 0.0001 (exact)
```

## Limits (honest)

- The "after" state is a prediction from the call itself: value moves and a decoded ERC-20 `transfer`. Other state a contract changes is not predicted.
- Simulation sees the chain at one block; another transaction can change the outcome before yours lands.
- The fee estimate uses base fee + priority fee at simulation time; Atlantic's fee is nearly flat, so the live run shows no error.
- Atlantic testnet only. 11 tests in `test/dryrun.test.ts`.
