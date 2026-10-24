import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, parseAbi, type Hex } from "viem";
import { defiSaga, erc20Abi, poolAbi, vaultAbi, type SagaParams } from "../src/saga/defi.js";
import { classify, CrashInjected, DEFAULT_POLICY, loadJournal, newJournal, Saga, statusTable, type EngineOptions, type Inject, type Journal, type Port, type Rcpt, type RetryPolicy, type SignedFields, type TxFields } from "../src/saga/engine.js";
import { main, parseInject } from "../tasks/saga-executor/index.js";
import { UsageError } from "../src/lib/cli.js";

const ME = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B" as Hex;
const POOL = "0x88176Fb095C178446816F5a1D7C32E35af1Fdac8" as Hex;
const VAULT = "0xEAd78727Ab9523622C4fE706D15059A551502671" as Hex;
const WPHRS = "0x838800b758277CC111B2d48Ab01e5E164f8E9471" as Hex;
const USDC = "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B" as Hex;
const P: SagaParams = { wallet: ME, pool: POOL, vault: VAULT, tokenIn: WPHRS, tokenOut: USDC, symbolIn: "WPHRS", symbolOut: "USDC", decimalsIn: 18, decimalsOut: 6, amountIn: 10n ** 15n, slippageBps: 50 };
const RATE = 100n * 10n ** 6n; // USDC per 1e18 WPHRS
const POLICY: RetryPolicy = { maxAttempts: 3, backoffMs: 10, bumpPercent: 25, receiptTimeoutMs: 50 };
const ABI = [...erc20Abi, ...poolAbi, ...vaultAbi] as const;

/** An in-memory chain: balances, allowances, vault shares, a mempool. `faults` decide what the node does with the Nth send of an action. */
class FakeChain {
  bal: Record<string, bigint> = { [`${WPHRS}`]: 5n * 10n ** 15n, [`${USDC}`]: 579_000n };
  poolBal: Record<string, bigint> = { [`${WPHRS}`]: 0n, [`${USDC}`]: 3_000_000n };
  allow = new Map<string, bigint>();
  shares = 0n;
  vaultOpen = true;
  nonce = 7;
  block = 100n;
  mined = new Map<string, Rcpt>();
  pool = new Map<string, { to: Hex; data: Hex }>(); // hash → tx waiting in the mempool
  sent: string[] = []; // every broadcast, by hash
  inPool = new Set<string>(); // accepted by the node, not mined
  signs: { to: Hex; nonce: number; maxFee: bigint }[] = [];
  /** Hooks per call index (1-based) of broadcast. */
  broadcastError: ((n: number, to: Hex, data: Hex) => string | undefined) | undefined;
  /** If it returns false, a broadcast tx is accepted by the node but never mined (dropped). */
  mines: ((to: Hex, data: Hex, n: number) => boolean) | undefined;
  /** If it returns "revert", the tx is mined with status 0. */
  mineRevert: ((to: Hex, data: Hex) => boolean) | undefined;
  /** If it returns a value, verify-time reads of this key are wrong (state does not match the receipt). */
  skewShares = 0n;
  private bcast = 0;
  raws = new Map<string, { to: Hex; data: Hex; nonce: number; maxFee: bigint }>();

  /** The node mines a transaction it was holding. */
  mineNow(hash: string): void {
    const r = this.raws.get(hash)!;
    this.inPool.delete(hash);
    this.block += 1n;
    this.mined.set(hash, { status: "success", blockNumber: this.block, gasUsed: 50_000n, logs: this.apply(r.to, r.data) });
  }

  key = (a: string, b: string) => `${a.toLowerCase()}|${b.toLowerCase()}`;

  read(to: Hex, data: Hex): Hex {
    const d = decodeFunctionData({ abi: ABI, data });
    const enc = (abi: readonly unknown[], fn: string, v: bigint | boolean) => encodeFunctionResult({ abi, functionName: fn, result: v } as never);
    if (d.functionName === "balanceOf") return enc(erc20Abi, "balanceOf", this.bal[to]!);
    if (d.functionName === "allowance") return enc(erc20Abi, "allowance", this.allow.get(this.key(to, String(d.args![1]))) ?? 0n);
    if (d.functionName === "sharesOf") return enc(vaultAbi, "sharesOf", this.shares + this.skewShares);
    if (d.functionName === "quote") return enc(poolAbi, "quote", this.quote(d.args![0] as Hex, d.args![1] as bigint));
    throw new Error(`fake chain: unsupported read ${d.functionName}`);
  }
  quote(tokenIn: Hex, amt: bigint): bigint {
    return tokenIn.toLowerCase() === WPHRS.toLowerCase() ? (amt * RATE) / 10n ** 18n : (amt * 10n ** 18n) / RATE;
  }
  preflight(to: Hex, data: Hex): void {
    const d = decodeFunctionData({ abi: ABI, data });
    if (d.functionName === "deposit" && !this.vaultOpen) throw Object.assign(new Error("reverted: VaultClosed()"), { code: 3 });
  }
  apply(to: Hex, data: Hex): Rcpt["logs"] {
    const d = decodeFunctionData({ abi: ABI, data });
    const logs: Rcpt["logs"] = [];
    if (d.functionName === "approve") this.allow.set(this.key(to, String(d.args![0])), d.args![1] as bigint);
    if (d.functionName === "swap") {
      const tin = d.args![0] as Hex, amt = d.args![1] as bigint, out = this.quote(tin, amt);
      const tout = tin.toLowerCase() === WPHRS.toLowerCase() ? USDC : WPHRS;
      const k = this.key(tin, POOL);
      this.allow.set(k, (this.allow.get(k) ?? 0n) - amt);
      this.bal[tin] = this.bal[tin]! - amt;
      this.bal[tout] = this.bal[tout]! + out;
      logs.push({
        address: POOL,
        topics: encodeEventTopics({ abi: poolAbi, eventName: "Swap", args: { user: ME } }) as Hex[],
        data: encodeAbiParameters(parseAbi(["function f(address,uint256,address,uint256)"])[0]!.inputs, [tin, amt, tout, out]),
      });
    }
    if (d.functionName === "deposit") {
      const amt = d.args![0] as bigint;
      const k = this.key(USDC, VAULT);
      this.allow.set(k, (this.allow.get(k) ?? 0n) - amt);
      this.bal[USDC] = this.bal[USDC]! - amt;
      this.shares += amt;
      logs.push({ address: VAULT, topics: encodeEventTopics({ abi: vaultAbi, eventName: "Deposit", args: { user: ME } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [amt]) });
    }
    if (d.functionName === "withdraw") {
      const amt = d.args![0] as bigint;
      this.bal[USDC] = this.bal[USDC]! + amt;
      this.shares -= amt;
    }
    return logs;
  }
}

function portFor(c: FakeChain): Port {
  return {
    async sign(tx: TxFields, o): Promise<SignedFields> {
      if (o.gas === undefined) c.preflight(tx.to, tx.data);
      const nonce = o.nonce ?? c.nonce++;
      let maxFee = 1_000n;
      if (o.minMaxFee !== undefined && maxFee < o.minMaxFee) maxFee = o.minMaxFee;
      if (o.maxFeeOverride !== undefined) maxFee = o.maxFeeOverride;
      const raw = `0x${Buffer.from(`${tx.to}|${tx.data}|${nonce}|${maxFee}`).toString("hex")}` as Hex;
      const hash = keccak256(raw);
      c.raws.set(hash, { to: tx.to, data: tx.data, nonce, maxFee });
      c.signs.push({ to: tx.to, nonce, maxFee });
      return { hash, raw, nonce, maxFeePerGas: maxFee, maxPriorityFeePerGas: 0n, gas: 100_000n };
    },
    async broadcast(s) {
      c.sent.push(s.hash);
      const n = c.sent.length;
      const r = c.raws.get(s.hash) ?? (() => { throw new Error("fake chain: unknown bytes"); })();
      const err = c.broadcastError?.(n, r.to, r.data);
      if (err) throw new Error(err);
      if (r.maxFee < 100n) throw new Error("transaction underpriced");
      if (c.mines && !c.mines(r.to, r.data, n)) {
        c.inPool.add(s.hash); // accepted, not mined (yet)
        return;
      }
      if (c.mined.has(s.hash)) return;
      const rev = c.mineRevert?.(r.to, r.data);
      c.block += 1n;
      c.mined.set(s.hash, { status: rev ? "reverted" : "success", blockNumber: c.block, gasUsed: 50_000n, logs: rev ? [] : c.apply(r.to, r.data) });
    },
    async receipt(h) { return c.mined.get(h) ?? null; },
    async known(h) { return c.mined.has(h) || c.inPool.has(h); },
    async waitReceipt(h) { return c.mined.get(h) ?? null; },
    async call(to, data) { return c.read(to, data); },
    async sleep() {},
    now: () => new Date("2026-10-24T12:00:00Z"),
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "saga-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(c: FakeChain, o: EngineOptions = {}, j?: Journal) {
  const def = defiSaga(P);
  const file = join(dir, "s.json");
  const journal = j ?? newJournal({ id: "t", wallet: ME, params: {} }, def.forward, new Date("2026-10-24T12:00:00Z"));
  return { saga: new Saga(def, journal, portFor(c), file, { policy: POLICY, ...o }), file, journal };
}
const ids = (j: Journal, phase: "forward" | "undo") => j.actions.filter((a) => a.phase === phase).map((a) => `${a.id}:${a.state}`);
const OUT = 100_000n; // 0.001 WPHRS × 100 = 0.1 USDC

describe("success path", () => {
  it("runs four dependent steps, each verified, and the end state checks", async () => {
    const c = new FakeChain();
    const { saga } = make(c);
    const j = await saga.run();
    expect(j.status).toBe("completed");
    expect(ids(j, "forward")).toEqual(["approve-in:verified", "swap:verified", "approve-out:verified", "deposit:verified"]);
    expect(c.shares).toBe(OUT);
    expect(j.checks!.every((x) => x.ok)).toBe(true);
    expect(j.data["swap.out"]).toBe(String(OUT));
    // dependency order: each tx was sent only after the one before was mined
    expect(c.sent).toHaveLength(4);
    expect(j.log.map((l) => l.event)).toContain("COMPLETED");
  });

  it("logs every state transition in order, with the step number", async () => {
    const c = new FakeChain();
    const { saga } = make(c);
    const j = await saga.run();
    const swapEvents = j.log.filter((l) => l.action === "swap").map((l) => l.event);
    expect(swapEvents).toEqual(["RUNNING", "SIGNED", "SENT", "MINED", "VERIFIED"]);
    expect(j.log.find((l) => l.action === "swap" && l.event === "RUNNING")!.detail).toContain("step 2/4");
  });
});

describe("retry policy (transient failures)", () => {
  it("a refused underpriced broadcast is retried on the SAME nonce with a higher fee", async () => {
    const c = new FakeChain();
    const { saga } = make(c, { inject: [{ kind: "underpriced", action: "swap" }] });
    const j = await saga.run();
    expect(j.status).toBe("completed");
    const swap = j.actions.find((a) => a.id === "swap")!;
    expect(swap.attempts.map((a) => a.state)).toEqual(["refused", "mined"]);
    expect(swap.attempts[0]!.nonce).toBe(swap.attempts[1]!.nonce);
    expect(BigInt(swap.attempts[1]!.maxFeePerGas)).toBeGreaterThan(BigInt(swap.attempts[0]!.maxFeePerGas));
    expect(j.log.some((l) => l.event === "RETRY" && l.action === "swap")).toBe(true);
  });

  it("a dropped transaction (never mined) times out and is replaced, one effect only", async () => {
    const c = new FakeChain();
    const { saga } = make(c, { inject: [{ kind: "drop", action: "swap" }] });
    const j = await saga.run();
    expect(j.status).toBe("completed");
    const swap = j.actions.find((a) => a.id === "swap")!;
    expect(swap.attempts.map((a) => a.state)).toEqual(["replaced", "mined"]); // attempt 1 timed out (see the TRANSIENT log line), attempt 2 replaced it
    expect(j.log.some((l) => l.action === "swap" && l.event === "TRANSIENT" && /no receipt/.test(l.detail ?? ""))).toBe(true);
    expect(c.shares).toBe(OUT); // swapped once
    expect(c.bal[WPHRS]).toBe(5n * 10n ** 15n - P.amountIn);
  });

  it("backs off 2× longer each time and gives up after maxAttempts, then rolls back what landed", async () => {
    const c = new FakeChain();
    const slept: number[] = [];
    const base = portFor(c);
    const port: Port = { ...base, sleep: async (ms) => void slept.push(ms) };
    c.broadcastError = (_n, _to, data) => (decodeFunctionData({ abi: ABI, data }).functionName === "swap" ? "503 service unavailable" : undefined);
    const def = defiSaga(P);
    const j0 = newJournal({ id: "t", wallet: ME, params: {} }, def.forward, new Date());
    const saga = new Saga(def, j0, port, join(dir, "s.json"), { policy: { ...POLICY, backoffMs: 100 } });
    const j = await saga.run();
    expect(slept).toEqual([100, 200]);
    expect(j.actions.find((a) => a.id === "swap")!.failure!.kind).toBe("transient-exhausted");
    expect(j.status).toBe("rolled-back");
    expect(c.sent.filter((h) => c.raws.get(h)!.nonce === j.actions.find((a) => a.id === "swap")!.attempts[0]!.nonce)).toHaveLength(3);
  });
});

describe("compensation (permanent failures)", () => {
  it("a deposit refused by the closed vault rolls back swap and approvals, newest first, and the invariant holds", async () => {
    const c = new FakeChain();
    c.vaultOpen = false;
    const { saga } = make(c);
    const j = await saga.run();
    expect(j.status).toBe("rolled-back");
    expect(j.failedAt).toBe("deposit");
    expect(j.actions.find((a) => a.id === "deposit")!.failure!.reason).toContain("VaultClosed");
    expect(j.actions.find((a) => a.id === "deposit")!.attempts).toHaveLength(1); // permanent: not retried
    expect(ids(j, "undo")).toEqual(["undo-approve-out:verified", "undo-swap-approve:verified", "undo-swap:verified", "undo-swap-revoke:skipped", "undo-approve-in:skipped"]);
    expect(c.bal[WPHRS]).toBe(5n * 10n ** 15n);
    expect(c.bal[USDC]).toBe(579_000n);
    expect(j.checks!.map((x) => x.ok)).toEqual([true, true, true, true, true, true]);
    expect(j.log.at(-1)!.event).toBe("ROLLED-BACK");
  });

  it("a transaction mined with status 0 is permanent: never retried", async () => {
    const c = new FakeChain();
    c.mineRevert = (_to, data) => decodeFunctionData({ abi: ABI, data }).functionName === "swap" && c.mined.size < 20 && c.sent.length < 3;
    const { saga } = make(c);
    const j = await saga.run();
    const swap = j.actions.find((a) => a.id === "swap")!;
    expect(swap.attempts).toHaveLength(1);
    expect(swap.attempts[0]!.state).toBe("reverted");
    expect(swap.failure!.kind).toBe("revert");
    expect(j.status).toBe("rolled-back");
    expect(ids(j, "undo")).toEqual(["undo-approve-in:verified"]); // only the approval had landed
  });

  it("a step whose receipt is fine but whose state read-back is wrong fails verification and is undone too", async () => {
    const c = new FakeChain();
    const { saga } = make(c);
    // after the deposit lands the vault reports a wrong share count
    const orig = c.apply.bind(c);
    c.apply = (to, data) => {
      const logs = orig(to, data);
      if (decodeFunctionData({ abi: ABI, data }).functionName === "deposit") c.skewShares = 1n;
      return logs;
    };
    const j = await saga.run();
    expect(j.actions.find((a) => a.id === "deposit")!.failure!.kind).toBe("verify");
    expect(j.actions.find((a) => a.id === "deposit")!.landed).toBe(true);
    expect(ids(j, "undo")[0]).toBe("undo-deposit:verified".replace("verified", "failed")); // the withdraw read-back is skewed by the same fault
    expect(j.status).toBe("stuck");
  });

  it("an undo that fails permanently leaves the saga STUCK and says so", async () => {
    const c = new FakeChain();
    c.vaultOpen = false;
    c.mineRevert = (_to, data) => decodeFunctionData({ abi: ABI, data }).functionName === "swap" && c.bal[USDC]! > 579_000n; // the swap-back reverts
    const { saga } = make(c);
    const j = await saga.run();
    expect(j.status).toBe("stuck");
    expect(j.log.at(-1)!.event).toBe("STUCK");
  });

  it("a swap-back that does not restore the balance is caught by its read-back: STUCK, mismatch in the log", async () => {
    const c = new FakeChain();
    c.vaultOpen = false;
    const orig = c.apply.bind(c);
    c.apply = (to, data) => {
      const logs = orig(to, data);
      const d = decodeFunctionData({ abi: ABI, data });
      if (d.functionName === "swap" && String(d.args![0]).toLowerCase() === USDC.toLowerCase()) c.bal[WPHRS] = c.bal[WPHRS]! - 1n; // leak 1 wei on the way back
      return logs;
    };
    const { saga } = make(c);
    const j = await saga.run();
    expect(j.status).toBe("stuck");
    expect(j.log.some((l) => l.action === "undo-swap" && l.event === "VERIFY-FAILED" && /NOT RESTORED/.test(l.detail ?? ""))).toBe(true);
  });
});

describe("crash-resume", () => {
  async function crashAndResume(point: "signed" | "sent" | "mined") {
    const c = new FakeChain();
    const inject: Inject[] = [{ kind: "crash", action: "swap", point }];
    const first = make(c, { inject });
    await expect(first.saga.run()).rejects.toBeInstanceOf(CrashInjected);
    const sentAtCrash = [...c.sent];
    const onDisk = loadJournal(first.file)!;
    expect(onDisk.status).toBe("running");
    expect(onDisk.actions.find((a) => a.id === "approve-in")!.state).toBe("verified");
    // a NEW process: fresh Saga from the journal on disk, no injection
    const second = make(c, {}, onDisk);
    const j = await second.saga.run();
    return { c, j, sentAtCrash, first };
  }

  it.each(["signed", "sent", "mined"] as const)("killed at %s: the next run finishes the saga and never repeats a done step", async (point) => {
    const { c, j, sentAtCrash } = await crashAndResume(point);
    expect(j.status).toBe("completed");
    expect(c.shares).toBe(OUT);
    expect(c.bal[WPHRS]).toBe(5n * 10n ** 15n - P.amountIn); // swapped exactly once
    const approveIn = j.actions.find((a) => a.id === "approve-in")!;
    expect(approveIn.attempts).toHaveLength(1);
    // approve-in was sent once in total
    expect(c.sent.filter((h) => h === approveIn.attempts[0]!.hash)).toHaveLength(1);
    // the swap was signed once; at "signed" it is sent for the first time on resume, otherwise it is not sent again
    const swap = j.actions.find((a) => a.id === "swap")!;
    expect(swap.attempts).toHaveLength(1);
    expect(c.sent.filter((h) => h === swap.attempts[0]!.hash)).toHaveLength(point === "signed" ? 1 : 1);
    if (point !== "signed") expect(sentAtCrash).toContain(swap.attempts[0]!.hash);
    expect(j.log.some((l) => l.event === "RESUMED")).toBe(true);
  });

  it("killed with the swap tx unknown to the node: the SAME signed bytes are sent again", async () => {
    const c = new FakeChain();
    c.mines = (_to, data) => decodeFunctionData({ abi: ABI, data }).functionName !== "swap"; // the swap send is accepted by the node and lost
    const first = make(c, { inject: [{ kind: "crash", action: "swap", point: "sent" }] });
    await expect(first.saga.run()).rejects.toBeInstanceOf(CrashInjected);
    c.mines = undefined; // from now on the node mines what it is sent
    const lost = loadJournal(first.file)!.actions.find((a) => a.id === "swap")!.attempts[0]!;
    c.sent = c.sent.filter((h) => h !== lost.hash);
    c.inPool.delete(lost.hash);
    const second = make(c, {}, loadJournal(first.file)!);
    const j = await second.saga.run();
    expect(j.status).toBe("completed");
    expect(j.actions.find((a) => a.id === "swap")!.attempts).toHaveLength(1); // same attempt, same bytes
    expect(c.bal[WPHRS]).toBe(5n * 10n ** 15n - P.amountIn);
  });

  it("a crash during rollback resumes the rollback, not the saga", async () => {
    const c = new FakeChain();
    c.vaultOpen = false;
    const first = make(c, { inject: [{ kind: "crash", action: "undo-swap", point: "sent" }] });
    await expect(first.saga.run()).rejects.toBeInstanceOf(CrashInjected);
    const mid = loadJournal(first.file)!;
    expect(mid.status).toBe("compensating");
    const second = make(c, {}, mid);
    const j = await second.saga.run();
    expect(j.status).toBe("rolled-back");
    expect(j.checks!.every((x) => x.ok)).toBe(true);
    expect(c.bal[WPHRS]).toBe(5n * 10n ** 15n);
  });

  it("a finished saga is returned as is: running it again sends nothing", async () => {
    const c = new FakeChain();
    const a = make(c);
    await a.saga.run();
    const sent = c.sent.length;
    const again = make(c, {}, loadJournal(a.file)!);
    const j = await again.saga.run();
    expect(j.status).toBe("completed");
    expect(c.sent).toHaveLength(sent);
  });
});

describe("state log + status", () => {
  it("statusTable names the step the saga is in", async () => {
    const c = new FakeChain();
    const first = make(c, { inject: [{ kind: "crash", action: "swap", point: "sent" }] });
    await expect(first.saga.run()).rejects.toBeInstanceOf(CrashInjected);
    const t = statusTable(loadJournal(first.file)!);
    expect(t).toContain("RUNNING · now at swap (2/4)");
    expect(t).toMatch(/approve-in\s+verified/);
  });
});

describe("classify + CLI flags", () => {
  it("transient texts are retried, reverts and unknowns fail closed", () => {
    for (const m of ["transaction underpriced", "replacement transaction underpriced", "fetch failed", "429 Too Many Requests", "timeout: no answer", "503 service unavailable", "send_raw_transaction: INVALID_PARAMS: effective gas price less than base fee (code -32602)"]) expect(classify(new Error(m))).toBe("transient");
    for (const m of ["reverted: VaultClosed()", "execution reverted", "insufficient funds for gas", "something nobody has seen"]) expect(classify(new Error(m))).toBe("permanent");
    expect(classify(Object.assign(new Error("odd"), { code: 3 }))).toBe("permanent");
  });

  it("--inject parses and refuses garbage", () => {
    expect(parseInject("drop:swap,crash:deposit:sent")).toEqual([{ kind: "drop", action: "swap" }, { kind: "crash", action: "deposit", point: "sent" }]);
    expect(parseInject(undefined)).toEqual([]);
    expect(() => parseInject("explode:swap")).toThrow(/use drop/);
    expect(() => parseInject("crash:swap")).toThrow(/use drop/);
  });

  it("default policy: 3 attempts, doubling backoff, +25% fee", () => {
    expect(DEFAULT_POLICY).toMatchObject({ maxAttempts: 3, backoffMs: 2000, bumpPercent: 25 });
  });
});

describe("CLI usage (no network: these fail before any chain is opened)", () => {
  const ctx = { onExit() {}, signal: new AbortController().signal };
  it("status of a saga that does not exist", async () => {
    await expect(main(ctx, ["status", "--id", "no-such-saga"])).rejects.toThrow(/no saga journal named no-such-saga/);
  });
  it("a missing or malformed --id", async () => {
    await expect(main(ctx, ["status"])).rejects.toThrow(/--id <name> is required/);
    await expect(main(ctx, ["status", "--id", "../etc"])).rejects.toBeInstanceOf(UsageError);
  });
  it("an unknown command and a bad retry count", async () => {
    await expect(main(ctx, ["explode"])).rejects.toThrow(/unknown command explode/);
    await expect(main(ctx, ["plan", "--retries", "0"])).rejects.toThrow(/--retries must be a number ≥ 1/);
  });
});

describe("races and give-up (review round 1)", () => {
  it("a send that lands while the retry is backing off is found; nothing is sent twice", async () => {
    const c = new FakeChain();
    c.mines = (_to, data) => decodeFunctionData({ abi: ABI, data }).functionName !== "swap"; // the first swap send waits in the pool
    const base = portFor(c);
    // the node mines the held swap during the backoff
    const port: Port = { ...base, sleep: async () => { for (const h of [...c.inPool]) c.mineNow(h); c.mines = undefined; } };
    const def = defiSaga(P);
    const j0 = newJournal({ id: "t", wallet: ME, params: {} }, def.forward, new Date());
    const j = await new Saga(def, j0, port, join(dir, "s.json"), { policy: POLICY }).run();
    expect(j.status).toBe("completed");
    const swap = j.actions.find((a) => a.id === "swap")!;
    expect(swap.attempts).toHaveLength(1);
    expect(c.bal[WPHRS]).toBe(5n * 10n ** 15n - P.amountIn); // swapped once
    expect(j.log.some((l) => l.action === "swap" && l.event === "RECOVERED" && /not sending again/.test(l.detail ?? ""))).toBe(true);
  });

  it("'nonce too low' is retried (an earlier send may have landed), not failed at once", () => {
    expect(classify(new Error("nonce too low: next nonce 8, tx nonce 7"))).toBe("transient");
  });

  it("all sends used up but one still in the pool: STUCK, no rollback; a resume finishes when it lands", async () => {
    const c = new FakeChain();
    c.mines = (_to, data) => decodeFunctionData({ abi: ABI, data }).functionName !== "swap"; // every swap send waits in the pool
    const first = make(c);
    const j = await first.saga.run();
    expect(j.status).toBe("stuck");
    expect(j.stuckFrom).toBe("running");
    expect(j.actions.find((a) => a.id === "swap")!.failure!.kind).toBe("pending-unresolved");
    expect(j.actions.some((a) => a.phase === "undo")).toBe(false); // nothing rolled back while a send may still land
    expect(c.bal[WPHRS]).toBe(5n * 10n ** 15n); // swap not applied yet
    // the node mines the last send, then the saga is resumed
    c.mineNow(c.sent[c.sent.length - 1]!);
    const second = make(c, {}, loadJournal(first.file)!);
    const done = await second.saga.run();
    expect(done.status).toBe("completed");
    expect(c.bal[WPHRS]).toBe(5n * 10n ** 15n - P.amountIn);
    expect(c.shares).toBe(OUT);
  });

  it("killed after the journal knows the approve is mined but before it was verified: the resume verifies it, never skips it", async () => {
    const c = new FakeChain();
    const first = make(c, { inject: [{ kind: "crash", action: "approve-in", point: "mined" }] });
    await expect(first.saga.run()).rejects.toBeInstanceOf(CrashInjected);
    const mid = loadJournal(first.file)!;
    expect(mid.actions.find((a) => a.id === "approve-in")!.attempts[0]!.state).toBe("mined");
    expect(mid.actions.find((a) => a.id === "approve-in")!.state).toBe("running");
    const j = await make(c, {}, mid).saga.run();
    const a = j.actions.find((x) => x.id === "approve-in")!;
    expect(a.state).toBe("verified");
    expect(a.detail).toContain("read back");
    expect(a.attempts).toHaveLength(1);
    expect(j.status).toBe("completed");
  });

  it("a stuck rollback can be resumed once the cause is gone", async () => {
    const c = new FakeChain();
    c.vaultOpen = false;
    let swapBacks = 0;
    c.mineRevert = (_to, data) => {
      const d = decodeFunctionData({ abi: ABI, data });
      return d.functionName === "swap" && String(d.args![0]).toLowerCase() === USDC.toLowerCase() && ++swapBacks === 1; // the first swap-back reverts
    };
    const first = make(c);
    const j = await first.saga.run();
    expect(j.status).toBe("stuck");
    expect(j.stuckFrom).toBe("compensating");
    const second = make(c, {}, loadJournal(first.file)!);
    const done = await second.saga.run();
    expect(done.status).toBe("rolled-back");
    expect(done.checks!.every((x) => x.ok)).toBe(true);
    expect(c.bal[WPHRS]).toBe(5n * 10n ** 15n);
    expect(done.actions.find((a) => a.id === "undo-swap")!.earlier).toHaveLength(1);
  });

  it("with the pre-flight simulation off, the closed vault gives a MINED status-0 deposit: permanent, rolled back", async () => {
    const c = new FakeChain();
    c.vaultOpen = false;
    c.mineRevert = (_to, data) => decodeFunctionData({ abi: ABI, data }).functionName === "deposit";
    const { saga } = make(c, { fixedGas: 400_000n });
    const j = await saga.run();
    const dep = j.actions.find((a) => a.id === "deposit")!;
    expect(dep.attempts).toHaveLength(1);
    expect(dep.attempts[0]!.state).toBe("reverted");
    expect(dep.failure!.kind).toBe("revert");
    expect(j.status).toBe("rolled-back");
    expect(j.checks!.every((x) => x.ok)).toBe(true);
  });

  it("an undo that cannot be built (no recorded swap output) ends STUCK, not as an exception", async () => {
    const c = new FakeChain();
    c.vaultOpen = false;
    const { journal } = make(c);
    const port = portFor(c);
    // when the deposit is about to be refused, lose the recorded swap output: the rollback cannot build the swap-back
    const wrapped: Port = { ...port, sign: async (tx, o) => { if (tx.to === VAULT) delete journal.data["swap.out"]; return port.sign(tx, o); } };
    const j = await new Saga(defiSaga(P), journal, wrapped, join(dir, "s2.json"), { policy: POLICY }).run();
    expect(j.status).toBe("stuck");
    expect(j.actions.find((a) => a.id === "undo-swap-approve")!.failure!.reason).toContain("could not build");
  });

  it("a stuck rollback whose sends were all unmined resumes on the SAME nonce: one effect, never a fresh nonce", async () => {
    const c = new FakeChain();
    c.vaultOpen = false;
    let swapBacks = 0;
    // the first three swap-back sends are accepted by the node and not mined; later ones mine
    c.mines = (_to, data) => {
      const d = decodeFunctionData({ abi: ABI, data });
      return !(d.functionName === "swap" && String(d.args![0]).toLowerCase() === USDC.toLowerCase() && ++swapBacks <= 3);
    };
    const first = make(c);
    const j = await first.saga.run();
    expect(j.status).toBe("stuck");
    expect(j.stuckFrom).toBe("compensating");
    const back = j.actions.find((a) => a.id === "undo-swap")!;
    expect(back.failure!.kind).toBe("pending-unresolved");
    expect(back.attempts).toHaveLength(3);
    const second = make(c, {}, loadJournal(first.file)!);
    const done = await second.saga.run();
    expect(done.status).toBe("rolled-back");
    const after = done.actions.find((a) => a.id === "undo-swap")!;
    expect(new Set(after.attempts.map((a) => a.nonce)).size).toBe(1); // every send on one nonce
    expect(after.attempts.length).toBeGreaterThan(3);
    expect(after.earlier).toBeUndefined();
    expect(c.bal[WPHRS]).toBe(5n * 10n ** 15n); // swapped back exactly once
    expect(done.checks!.every((x) => x.ok)).toBe(true);
  });

  it("when the node cannot be asked, the engine stops instead of reading 'no receipt' and rolling back", async () => {
    const c = new FakeChain();
    c.mines = (_to, data) => decodeFunctionData({ abi: ABI, data }).functionName !== "swap"; // the swap send is not mined in time
    const base = portFor(c);
    const port: Port = { ...base, receipt: async (h) => { if (c.inPool.has(h)) throw new Error("fetch failed"); return base.receipt(h); } };
    const def = defiSaga(P);
    const journal = newJournal({ id: "t", wallet: ME, params: {} }, def.forward, new Date());
    const file = join(dir, "s3.json");
    await expect(new Saga(def, journal, port, file, { policy: POLICY }).run()).rejects.toThrow(/fetch failed/);
    const saved = loadJournal(file)!;
    expect(saved.status).toBe("running"); // not rolled back
    expect(saved.actions.some((a) => a.phase === "undo")).toBe(false);
  });

  it("a swap-back that was refused once, bumped and then MINED with status 0 is stuck, and a resume restarts it on a fresh nonce", async () => {
    const c = new FakeChain();
    c.vaultOpen = false;
    let backs = 0;
    const isBack = (data: Hex) => {
      const d = decodeFunctionData({ abi: ABI, data });
      return d.functionName === "swap" && String(d.args![0]).toLowerCase() === USDC.toLowerCase();
    };
    c.broadcastError = (_n, _to, data) => (isBack(data) && ++backs === 1 ? "503 service unavailable" : undefined);
    c.mineRevert = (_to, data) => isBack(data) && backs === 2; // the bumped second send reverts
    const first = make(c);
    const j = await first.saga.run();
    expect(j.status).toBe("stuck");
    const back = j.actions.find((a) => a.id === "undo-swap")!;
    expect(back.attempts.map((a) => a.state)).toEqual(["refused", "reverted"]);
    c.mineRevert = undefined;
    const done = await make(c, {}, loadJournal(first.file)!).saga.run();
    expect(done.status).toBe("rolled-back");
    const after = done.actions.find((a) => a.id === "undo-swap")!;
    expect(after.earlier).toHaveLength(2);
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]!.nonce).not.toBe(back.attempts[1]!.nonce); // the reverted send used its nonce up
    expect(c.bal[WPHRS]).toBe(5n * 10n ** 15n);
  });

  it("a transient failure while SIGNING is retried and the second sign succeeds (no crash on the missing previous send)", async () => {
    const c = new FakeChain();
    const base = portFor(c);
    let n = 0;
    const port: Port = { ...base, sign: async (tx, o) => { if (tx.to === POOL && ++n === 1) throw new Error("timeout: node did not answer"); return base.sign(tx, o); } };
    const def = defiSaga(P);
    const journal = newJournal({ id: "t", wallet: ME, params: {} }, def.forward, new Date());
    const j = await new Saga(def, journal, port, join(dir, "s4.json"), { policy: POLICY }).run();
    expect(j.status).toBe("completed");
    expect(j.actions.find((a) => a.id === "swap")!.attempts.map((a) => a.state)).toEqual(["refused", "mined"]);
  });
});
