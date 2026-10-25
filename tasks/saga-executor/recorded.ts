// Recorded Atlantic runs of the Saga Executor, generated from tasks/saga-executor/proof/{success,forced-failure,crash-resume-1-killed,crash-resume-3-resumed}.txt
// (the journal lines minus the SIGNED/SENT noise). The page REPLAYS them and says so: a live run needs the saga wallet's key, which the page does not have.
export interface Recorded { time: string; step: string; event: string; detail: string; tx: string | null }
export const RECORDED: Record<string, Recorded[]> = {
 "success": [
  {
   "time": "13:31:43",
   "step": "saga",
   "event": "STARTED",
   "detail": "saga saga-ok: approve-in → swap → approve-out → deposit",
   "tx": null
  },
  {
   "time": "13:31:43",
   "step": "approve-in",
   "event": "RUNNING",
   "detail": "step 1/4 approve-in: approve the pool to pull 0.001 WPHRS",
   "tx": null
  },
  {
   "time": "13:31:47",
   "step": "approve-in",
   "event": "MINED",
   "detail": "0xc8e50c97d5d587d9900be127e85a1082979bf7ac6339c5fcb956b5f0204bf251 block 31824328 status 1 gas 46710",
   "tx": "0xc8e50c97d5d587d9900be127e85a1082979bf7ac6339c5fcb956b5f0204bf251"
  },
  {
   "time": "13:31:47",
   "step": "approve-in",
   "event": "VERIFIED",
   "detail": "allowance(WPHRS → pool) read back = 0.001 WPHRS",
   "tx": null
  },
  {
   "time": "13:31:47",
   "step": "swap",
   "event": "RUNNING",
   "detail": "step 2/4 swap: swap 0.001 WPHRS for USDC in the pool",
   "tx": null
  },
  {
   "time": "13:31:51",
   "step": "swap",
   "event": "MINED",
   "detail": "0xbb3d6df12d1b4335b88ae5d027ba0788745d28435aeaa5392e1b9d73cecfc0a7 block 31824332 status 1 gas 70289",
   "tx": "0xbb3d6df12d1b4335b88ae5d027ba0788745d28435aeaa5392e1b9d73cecfc0a7"
  },
  {
   "time": "13:31:51",
   "step": "swap",
   "event": "VERIFIED",
   "detail": "Swap event: 0.001 WPHRS → 0.1 USDC (quote 0.1, floor 0.0995); balances read back: WPHRS 0.0678, USDC 0.679",
   "tx": null
  },
  {
   "time": "13:31:51",
   "step": "approve-out",
   "event": "RUNNING",
   "detail": "step 3/4 approve-out: approve the vault to pull the swap output (USDC)",
   "tx": null
  },
  {
   "time": "13:31:54",
   "step": "approve-out",
   "event": "MINED",
   "detail": "0x63c0acd75e2cfa15f1c46c3001276e5535b4f498d1ef0cb78938d53870db064b block 31824336 status 1 gas 55437",
   "tx": "0x63c0acd75e2cfa15f1c46c3001276e5535b4f498d1ef0cb78938d53870db064b"
  },
  {
   "time": "13:31:55",
   "step": "approve-out",
   "event": "VERIFIED",
   "detail": "allowance(USDC → vault) read back = 0.1 USDC",
   "tx": null
  },
  {
   "time": "13:31:55",
   "step": "deposit",
   "event": "RUNNING",
   "detail": "step 4/4 deposit: deposit the swap output (USDC) into the vault",
   "tx": null
  },
  {
   "time": "13:31:58",
   "step": "deposit",
   "event": "MINED",
   "detail": "0x5d0cef391669db86b04bca8cd4ef44355ab97537033e8ba9f1d34dc8b1e41de8 block 31824341 status 1 gas 65791",
   "tx": "0x5d0cef391669db86b04bca8cd4ef44355ab97537033e8ba9f1d34dc8b1e41de8"
  },
  {
   "time": "13:31:58",
   "step": "deposit",
   "event": "VERIFIED",
   "detail": "Deposit event present; vault shares read back = 0.4 (was 0.3)",
   "tx": null
  },
  {
   "time": "13:31:58",
   "step": "saga",
   "event": "COMPLETED",
   "detail": "every step verified",
   "tx": null
  }
 ],
 "forced-failure": [
  {
   "time": "13:33:22",
   "step": "saga",
   "event": "STARTED",
   "detail": "saga saga-fail: approve-in → swap → approve-out → deposit",
   "tx": null
  },
  {
   "time": "13:33:22",
   "step": "approve-in",
   "event": "RUNNING",
   "detail": "step 1/4 approve-in: approve the pool to pull 0.001 WPHRS",
   "tx": null
  },
  {
   "time": "13:33:26",
   "step": "approve-in",
   "event": "MINED",
   "detail": "0x3655d451320b69b3688fb00275a061dd105d3b0b93b6d5c27d19258643b18cb6 block 31824405 status 1 gas 46710",
   "tx": "0x3655d451320b69b3688fb00275a061dd105d3b0b93b6d5c27d19258643b18cb6"
  },
  {
   "time": "13:33:26",
   "step": "approve-in",
   "event": "VERIFIED",
   "detail": "allowance(WPHRS → pool) read back = 0.001 WPHRS",
   "tx": null
  },
  {
   "time": "13:33:26",
   "step": "swap",
   "event": "RUNNING",
   "detail": "step 2/4 swap: swap 0.001 WPHRS for USDC in the pool",
   "tx": null
  },
  {
   "time": "13:33:30",
   "step": "swap",
   "event": "MINED",
   "detail": "0x72b3ccdcb958955803582695373471d06277a522834de3dc48ec49b4b296c2e4 block 31824410 status 1 gas 70289",
   "tx": "0x72b3ccdcb958955803582695373471d06277a522834de3dc48ec49b4b296c2e4"
  },
  {
   "time": "13:33:30",
   "step": "swap",
   "event": "VERIFIED",
   "detail": "Swap event: 0.001 WPHRS → 0.1 USDC (quote 0.1, floor 0.0995); balances read back: WPHRS 0.0658, USDC 0.679",
   "tx": null
  },
  {
   "time": "13:33:30",
   "step": "approve-out",
   "event": "RUNNING",
   "detail": "step 3/4 approve-out: approve the vault to pull the swap output (USDC)",
   "tx": null
  },
  {
   "time": "13:33:34",
   "step": "approve-out",
   "event": "MINED",
   "detail": "0x5204ac0b2b78731576a9ff26b7c36e29ad454627108878fd386114bb050fdcad block 31824414 status 1 gas 55437",
   "tx": "0x5204ac0b2b78731576a9ff26b7c36e29ad454627108878fd386114bb050fdcad"
  },
  {
   "time": "13:33:34",
   "step": "approve-out",
   "event": "VERIFIED",
   "detail": "allowance(USDC → vault) read back = 0.1 USDC",
   "tx": null
  },
  {
   "time": "13:33:34",
   "step": "deposit",
   "event": "RUNNING",
   "detail": "step 4/4 deposit: deposit the swap output (USDC) into the vault",
   "tx": null
  },
  {
   "time": "13:33:34",
   "step": "deposit",
   "event": "REFUSED",
   "detail": "attempt 1 could not be prepared: reverted: VaultClosed()",
   "tx": null
  },
  {
   "time": "13:33:34",
   "step": "deposit",
   "event": "FAILED",
   "detail": "revert: reverted: VaultClosed()",
   "tx": null
  },
  {
   "time": "13:33:34",
   "step": "saga",
   "event": "COMPENSATING",
   "detail": "step deposit failed permanently (revert): rolling back what landed",
   "tx": null
  },
  {
   "time": "13:33:34",
   "step": "saga",
   "event": "ROLLBACK-PLAN",
   "detail": "undo approve-out, swap, approve-in (newest first)",
   "tx": null
  },
  {
   "time": "13:33:34",
   "step": "undo-approve-out",
   "event": "RUNNING",
   "detail": "step 3/4 undo undo-approve-out: revoke the vault's USDC allowance",
   "tx": null
  },
  {
   "time": "13:33:38",
   "step": "undo-approve-out",
   "event": "MINED",
   "detail": "0xbc92db3289efdd9ac09d571d5e1d8b409987f5dd5b10ca75bcb46e4b55b7ccab block 31824419 status 1 gas 33501",
   "tx": "0xbc92db3289efdd9ac09d571d5e1d8b409987f5dd5b10ca75bcb46e4b55b7ccab"
  },
  {
   "time": "13:33:38",
   "step": "undo-approve-out",
   "event": "VERIFIED",
   "detail": "allowance(USDC → vault) read back = 0 USDC",
   "tx": null
  },
  {
   "time": "13:33:38",
   "step": "undo-swap-approve",
   "event": "RUNNING",
   "detail": "step 2/4 undo undo-swap-approve: approve the pool to take the USDC back",
   "tx": null
  },
  {
   "time": "13:33:42",
   "step": "undo-swap-approve",
   "event": "MINED",
   "detail": "0xebe13caa13c98b09202b3e9038846a896fd2b11ffe379287f7f4dbeb635b8b88 block 31824423 status 1 gas 55437",
   "tx": "0xebe13caa13c98b09202b3e9038846a896fd2b11ffe379287f7f4dbeb635b8b88"
  },
  {
   "time": "13:34:20",
   "step": "undo-swap-approve",
   "event": "VERIFIED",
   "detail": "allowance(USDC → pool) read back = 0.1 USDC",
   "tx": null
  },
  {
   "time": "13:34:20",
   "step": "undo-swap",
   "event": "RUNNING",
   "detail": "step 2/4 undo undo-swap: swap the USDC back to WPHRS",
   "tx": null
  },
  {
   "time": "13:34:24",
   "step": "undo-swap",
   "event": "MINED",
   "detail": "0xb0227f70fdcf5bd4227edd24537251705d610597f197738a4fad0c63b00af88d block 31824458 status 1 gas 70058",
   "tx": "0xb0227f70fdcf5bd4227edd24537251705d610597f197738a4fad0c63b00af88d"
  },
  {
   "time": "13:34:24",
   "step": "undo-swap",
   "event": "VERIFIED",
   "detail": "balances read back: WPHRS 0.0668 (before the swap 0.0668), USDC 0.579 (before 0.579)",
   "tx": null
  },
  {
   "time": "13:34:25",
   "step": "undo-swap-revoke",
   "event": "RUNNING",
   "detail": "step 2/4 undo undo-swap-revoke: revoke the pool's USDC allowance",
   "tx": null
  },
  {
   "time": "13:34:25",
   "step": "undo-swap-revoke",
   "event": "SKIPPED",
   "detail": "the state this would produce already holds",
   "tx": null
  },
  {
   "time": "13:34:25",
   "step": "undo-approve-in",
   "event": "RUNNING",
   "detail": "step 1/4 undo undo-approve-in: revoke the pool's WPHRS allowance",
   "tx": null
  },
  {
   "time": "13:34:25",
   "step": "undo-approve-in",
   "event": "SKIPPED",
   "detail": "the state this would produce already holds",
   "tx": null
  },
  {
   "time": "13:34:27",
   "step": "saga",
   "event": "ROLLED-BACK",
   "detail": "balance invariant holds for all 6 reads",
   "tx": null
  }
 ],
 "crash-resume": [
  {
   "time": "13:34:45",
   "step": "saga",
   "event": "STARTED",
   "detail": "saga saga-crash: approve-in → swap → approve-out → deposit",
   "tx": null
  },
  {
   "time": "13:34:45",
   "step": "approve-in",
   "event": "RUNNING",
   "detail": "step 1/4 approve-in: approve the pool to pull 0.001 WPHRS",
   "tx": null
  },
  {
   "time": "13:34:48",
   "step": "approve-in",
   "event": "MINED",
   "detail": "0x3c7c647f69c2a0c750d0c3f017bdafce9ec3040459ac97725501e1a894146f49 block 31824481 status 1 gas 46710",
   "tx": "0x3c7c647f69c2a0c750d0c3f017bdafce9ec3040459ac97725501e1a894146f49"
  },
  {
   "time": "13:34:49",
   "step": "approve-in",
   "event": "VERIFIED",
   "detail": "allowance(WPHRS → pool) read back = 0.001 WPHRS",
   "tx": null
  },
  {
   "time": "13:34:49",
   "step": "swap",
   "event": "RUNNING",
   "detail": "step 2/4 swap: swap 0.001 WPHRS for USDC in the pool",
   "tx": null
  },
  {
   "time": "13:34:50",
   "step": "swap",
   "event": "INJECTED-CRASH",
   "detail": "process killed at sent",
   "tx": null
  },
  {
   "time": "13:34:53",
   "step": "saga",
   "event": "RESUMED",
   "detail": "from the journal, status running",
   "tx": null
  },
  {
   "time": "13:34:53",
   "step": "swap",
   "event": "RUNNING",
   "detail": "step 2/4 swap: swap 0.001 WPHRS for USDC in the pool",
   "tx": null
  },
  {
   "time": "13:34:53",
   "step": "swap",
   "event": "RECOVERED",
   "detail": "journal says sent; the chain already has 0x1eb4d4e4c2b344aeb366002a4afe782334a35972ac291a082e07728900a197ab mined",
   "tx": "0x1eb4d4e4c2b344aeb366002a4afe782334a35972ac291a082e07728900a197ab"
  },
  {
   "time": "13:34:53",
   "step": "swap",
   "event": "MINED",
   "detail": "0x1eb4d4e4c2b344aeb366002a4afe782334a35972ac291a082e07728900a197ab block 31824487 status 1 gas 70289",
   "tx": "0x1eb4d4e4c2b344aeb366002a4afe782334a35972ac291a082e07728900a197ab"
  },
  {
   "time": "13:34:53",
   "step": "swap",
   "event": "VERIFIED",
   "detail": "Swap event: 0.001 WPHRS → 0.1 USDC (quote 0.1, floor 0.0995); balances read back: WPHRS 0.0658, USDC 0.679",
   "tx": null
  },
  {
   "time": "13:34:53",
   "step": "approve-out",
   "event": "RUNNING",
   "detail": "step 3/4 approve-out: approve the vault to pull the swap output (USDC)",
   "tx": null
  },
  {
   "time": "13:34:56",
   "step": "approve-out",
   "event": "MINED",
   "detail": "0xe5e8eba43c272be883bd0c3a8d1df14fd6b690f8f3476e052b20f509cfcf0798 block 31824491 status 1 gas 55437",
   "tx": "0xe5e8eba43c272be883bd0c3a8d1df14fd6b690f8f3476e052b20f509cfcf0798"
  },
  {
   "time": "13:34:57",
   "step": "approve-out",
   "event": "VERIFIED",
   "detail": "allowance(USDC → vault) read back = 0.1 USDC",
   "tx": null
  },
  {
   "time": "13:34:57",
   "step": "deposit",
   "event": "RUNNING",
   "detail": "step 4/4 deposit: deposit the swap output (USDC) into the vault",
   "tx": null
  },
  {
   "time": "13:35:00",
   "step": "deposit",
   "event": "MINED",
   "detail": "0x8b790cd33761e892dab88ec76592b88b9f54becc45beae3b3cebc934e9d82a2e block 31824496 status 1 gas 65791",
   "tx": "0x8b790cd33761e892dab88ec76592b88b9f54becc45beae3b3cebc934e9d82a2e"
  },
  {
   "time": "13:35:01",
   "step": "deposit",
   "event": "VERIFIED",
   "detail": "Deposit event present; vault shares read back = 0.6 (was 0.5)",
   "tx": null
  },
  {
   "time": "13:35:01",
   "step": "saga",
   "event": "COMPLETED",
   "detail": "every step verified",
   "tx": null
  }
 ]
};
