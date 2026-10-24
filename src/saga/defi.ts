import { decodeEventLog, decodeFunctionResult, encodeFunctionData, formatUnits, getAddress, parseAbi, type Hex } from "viem";
import type { ActionDef, Ctx, Journal, Rcpt, SagaDef } from "./engine.js";

// approve → swap → approve → deposit against the repo's own test pool and vault on Atlantic (tasks/saga-executor/contracts).
// Every action has an `intent` (the transaction, or null when the state it would produce already holds), a `verify` that
// reads the chain AFTER the receipt, and an undo. Amounts are bigints in the token's own units.

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const poolAbi = parseAbi([
  "function quote(address tokenIn, uint256 amountIn) view returns (uint256)",
  "function swap(address tokenIn, uint256 amountIn) returns (uint256)",
  "event Swap(address indexed user, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut)",
  "error UnknownToken()",
  "error NotEnoughLiquidity(uint256 wanted, uint256 have)",
  "error TransferFailed()",
]);

export const vaultAbi = parseAbi([
  "function deposit(uint256 assets)",
  "function withdraw(uint256 assets)",
  "function sharesOf(address) view returns (uint256)",
  "function open() view returns (bool)",
  "function cap() view returns (uint256)",
  "function setStatus(bool open_, uint256 cap_)",
  "event Deposit(address indexed user, uint256 assets)",
  "error VaultClosed()",
  "error CapExceeded(uint256 cap, uint256 wouldBe)",
  "error NotOwner()",
  "error TransferFailed()",
  "error NotEnoughShares()",
]);

/** Every custom error the two contracts can raise, for decoding revert bytes into a name. */
export const errorsAbi = [...poolAbi, ...vaultAbi].filter((x) => x.type === "error");

export interface SagaParams {
  wallet: Hex;
  pool: Hex;
  vault: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  symbolIn: string;
  symbolOut: string;
  decimalsIn: number;
  decimalsOut: number;
  amountIn: bigint;
  /** The swap output may fall at most this many basis points below the pool's own quote. */
  slippageBps: number;
}

export function paramsToRecord(p: SagaParams): Record<string, string> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));
}

export function paramsFromRecord(r: Record<string, string>): SagaParams {
  return {
    wallet: r.wallet as Hex, pool: r.pool as Hex, vault: r.vault as Hex, tokenIn: r.tokenIn as Hex, tokenOut: r.tokenOut as Hex,
    symbolIn: r.symbolIn!, symbolOut: r.symbolOut!, decimalsIn: Number(r.decimalsIn), decimalsOut: Number(r.decimalsOut),
    amountIn: BigInt(r.amountIn!), slippageBps: Number(r.slippageBps),
  };
}

const fmt = (v: bigint, d: number) => formatUnits(v, d);

async function readUint(c: Ctx, to: Hex, abi: readonly unknown[], fn: string, args: unknown[]): Promise<bigint> {
  const data = encodeFunctionData({ abi, functionName: fn, args } as never);
  const out = await c.port.call(to, data);
  return decodeFunctionResult({ abi, functionName: fn, data: out } as never) as bigint;
}

export function defiSaga(p: SagaParams): SagaDef {
  const bal = (c: Ctx, token: Hex) => readUint(c, token, erc20Abi, "balanceOf", [p.wallet]);
  const allow = (c: Ctx, token: Hex, spender: Hex) => readUint(c, token, erc20Abi, "allowance", [p.wallet, spender]);
  const shares = (c: Ctx) => readUint(c, p.vault, vaultAbi, "sharesOf", [p.wallet]);
  const big = (c: Ctx, k: string) => BigInt(c.data(k) ?? (() => { throw new Error(`journal has no ${k}: the step before it did not record it`); })());
  const approveData = (spender: Hex, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  const sym = (token: Hex) => (token === p.tokenIn ? p.symbolIn : p.symbolOut);
  const dec = (token: Hex) => (token === p.tokenIn ? p.decimalsIn : p.decimalsOut);

  const approve = (o: { id: string; phase: "forward" | "undo"; step: string; title: string; token: Hex; spender: Hex; amount: (c: Ctx) => bigint; skipIfEnough: boolean }): ActionDef => ({
    id: o.id, phase: o.phase, step: o.step, title: o.title,
    async intent(c) {
      const want = o.amount(c);
      const have = await allow(c, o.token, o.spender);
      if (o.skipIfEnough ? have >= want : have === want) return null;
      return { to: o.token, value: 0n, data: approveData(o.spender, want) };
    },
    async verify(c) {
      const want = o.amount(c);
      const have = await allow(c, o.token, o.spender);
      return { ok: have === want, detail: `allowance(${sym(o.token)} → ${o.spender === p.pool ? "pool" : "vault"}) read back = ${fmt(have, dec(o.token))} ${sym(o.token)}${have === want ? "" : `, wanted ${fmt(want, dec(o.token))}`}` };
    },
  });

  const swapLog = (r: Rcpt) => {
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== p.pool.toLowerCase()) continue;
      try {
        const e = decodeEventLog({ abi: poolAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (e.eventName === "Swap") return e.args;
      } catch { /* another event */ }
    }
    return undefined;
  };

  const forward: ActionDef[] = [
    approve({ id: "approve-in", phase: "forward", step: "approve-in", title: `approve the pool to pull ${fmt(p.amountIn, p.decimalsIn)} ${p.symbolIn}`, token: p.tokenIn, spender: p.pool, amount: () => p.amountIn, skipIfEnough: true }),
    {
      id: "swap", phase: "forward", step: "swap", title: `swap ${fmt(p.amountIn, p.decimalsIn)} ${p.symbolIn} for ${p.symbolOut} in the pool`,
      async before(c) {
        c.setData("swap.balIn0", String(await bal(c, p.tokenIn)));
        c.setData("swap.balOut0", String(await bal(c, p.tokenOut)));
        c.setData("swap.quote", String(await readUint(c, p.pool, poolAbi, "quote", [p.tokenIn, p.amountIn])));
      },
      async intent() { return { to: p.pool, value: 0n, data: encodeFunctionData({ abi: poolAbi, functionName: "swap", args: [p.tokenIn, p.amountIn] }) }; },
      async verify(c, r) {
        const ev = swapLog(r);
        if (!ev) return { ok: false, detail: "no Swap event from the pool in the receipt" };
        const quote = big(c, "swap.quote");
        const floor = (quote * BigInt(10_000 - p.slippageBps)) / 10_000n;
        const nowIn = await bal(c, p.tokenIn);
        const nowOut = await bal(c, p.tokenOut);
        const inOk = nowIn === big(c, "swap.balIn0") - p.amountIn;
        const outOk = nowOut === big(c, "swap.balOut0") + ev.amountOut;
        c.setData("swap.out", String(ev.amountOut));
        const slipOk = ev.amountOut >= floor;
        return {
          ok: inOk && outOk && slipOk,
          detail: `Swap event: ${fmt(ev.amountIn, p.decimalsIn)} ${p.symbolIn} → ${fmt(ev.amountOut, p.decimalsOut)} ${p.symbolOut} (quote ${fmt(quote, p.decimalsOut)}, floor ${fmt(floor, p.decimalsOut)}); balances read back: ${p.symbolIn} ${fmt(nowIn, p.decimalsIn)}, ${p.symbolOut} ${fmt(nowOut, p.decimalsOut)}${inOk && outOk && slipOk ? "" : " — MISMATCH"}`,
        };
      },
    },
    approve({ id: "approve-out", phase: "forward", step: "approve-out", title: `approve the vault to pull the swap output (${p.symbolOut})`, token: p.tokenOut, spender: p.vault, amount: (c) => big(c, "swap.out"), skipIfEnough: true }),
    {
      id: "deposit", phase: "forward", step: "deposit", title: `deposit the swap output (${p.symbolOut}) into the vault`,
      async before(c) { c.setData("deposit.shares0", String(await shares(c))); },
      async intent(c) { return { to: p.vault, value: 0n, data: encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [big(c, "swap.out")] }) }; },
      async verify(c, r) {
        const out = big(c, "swap.out");
        const now = await shares(c);
        const ev = r.logs.some((l) => {
          if (l.address.toLowerCase() !== p.vault.toLowerCase()) return false;
          try { return decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).eventName === "Deposit"; } catch { return false; }
        });
        const ok = ev && now === big(c, "deposit.shares0") + out;
        return { ok, detail: `Deposit event ${ev ? "present" : "MISSING"}; vault shares read back = ${fmt(now, p.decimalsOut)} (was ${fmt(big(c, "deposit.shares0"), p.decimalsOut)})` };
      },
    },
  ];

  const undo = (step: string): ActionDef[] => {
    switch (step) {
      case "approve-in":
        return [approve({ id: "undo-approve-in", phase: "undo", step, title: `revoke the pool's ${p.symbolIn} allowance`, token: p.tokenIn, spender: p.pool, amount: () => 0n, skipIfEnough: false })];
      case "swap":
        return [
          approve({ id: "undo-swap-approve", phase: "undo", step, title: `approve the pool to take the ${p.symbolOut} back`, token: p.tokenOut, spender: p.pool, amount: (c) => big(c, "swap.out"), skipIfEnough: true }),
          {
            id: "undo-swap", phase: "undo", step, title: `swap the ${p.symbolOut} back to ${p.symbolIn}`,
            async intent(c) { return { to: p.pool, value: 0n, data: encodeFunctionData({ abi: poolAbi, functionName: "swap", args: [p.tokenOut, big(c, "swap.out")] }) }; },
            async verify(c) {
              const nowIn = await bal(c, p.tokenIn);
              const nowOut = await bal(c, p.tokenOut);
              const ok = nowIn === big(c, "swap.balIn0") && nowOut === big(c, "swap.balOut0");
              return { ok, detail: `balances read back: ${p.symbolIn} ${fmt(nowIn, p.decimalsIn)} (before the swap ${fmt(big(c, "swap.balIn0"), p.decimalsIn)}), ${p.symbolOut} ${fmt(nowOut, p.decimalsOut)} (before ${fmt(big(c, "swap.balOut0"), p.decimalsOut)})${ok ? "" : " — NOT RESTORED"}` };
            },
          },
          approve({ id: "undo-swap-revoke", phase: "undo", step, title: `revoke the pool's ${p.symbolOut} allowance`, token: p.tokenOut, spender: p.pool, amount: () => 0n, skipIfEnough: false }),
        ];
      case "approve-out":
        return [approve({ id: "undo-approve-out", phase: "undo", step, title: `revoke the vault's ${p.symbolOut} allowance`, token: p.tokenOut, spender: p.vault, amount: () => 0n, skipIfEnough: false })];
      case "deposit":
        return [{
          id: "undo-deposit", phase: "undo", step, title: `withdraw the deposit from the vault`,
          async intent(c) { return { to: p.vault, value: 0n, data: encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args: [big(c, "swap.out")] }) }; },
          async verify(c) {
            const now = await shares(c);
            return { ok: now === big(c, "deposit.shares0"), detail: `vault shares read back = ${fmt(now, p.decimalsOut)} (before the deposit ${fmt(big(c, "deposit.shares0"), p.decimalsOut)})` };
          },
        }];
      default:
        return [];
    }
  };

  const reads = async (c: Ctx): Promise<Record<string, bigint>> => ({
    balIn: await bal(c, p.tokenIn),
    balOut: await bal(c, p.tokenOut),
    allowInPool: await allow(c, p.tokenIn, p.pool),
    allowOutPool: await allow(c, p.tokenOut, p.pool),
    allowOutVault: await allow(c, p.tokenOut, p.vault),
    shares: await shares(c),
  });
  const LABEL: Record<string, string> = {
    balIn: `${p.symbolIn} balance`, balOut: `${p.symbolOut} balance`, allowInPool: `${p.symbolIn} allowance to pool`,
    allowOutPool: `${p.symbolOut} allowance to pool`, allowOutVault: `${p.symbolOut} allowance to vault`, shares: "vault shares",
  };
  const unit = (k: string) => (k === "balIn" || k === "allowInPool" ? p.decimalsIn : p.decimalsOut);

  return {
    forward,
    undo,
    async snapshot(c) {
      return Object.fromEntries(Object.entries(await reads(c)).map(([k, v]) => [k, String(v)]));
    },
    async check(c, outcome): Promise<NonNullable<Journal["checks"]>> {
      const now = await reads(c);
      const snap = Object.fromEntries(Object.entries(c.j.snapshot).map(([k, v]) => [k, BigInt(v)]));
      const out = c.data("swap.out") ? BigInt(c.data("swap.out")!) : 0n;
      // Rolled back: every read equals the snapshot. Completed: the input is spent, the output sits in the vault as shares, no allowance is left over.
      const expected: Record<string, bigint> =
        outcome === "rolled-back"
          ? snap
          : { balIn: snap.balIn! - p.amountIn, balOut: snap.balOut!, allowInPool: 0n, allowOutPool: snap.allowOutPool!, allowOutVault: 0n, shares: snap.shares! + out };
      return Object.keys(now).map((k) => ({
        name: LABEL[k]!,
        before: `${fmt(snap[k]!, unit(k))} (${outcome === "rolled-back" ? "pre-saga" : "expected"} ${fmt(expected[k]!, unit(k))})`,
        after: fmt(now[k]!, unit(k)),
        ok: now[k] === expected[k],
      }));
    },
  };
}

export const checksTable = (checks: NonNullable<Journal["checks"]>): string => {
  const w = Math.max(...checks.map((c) => c.name.length)) + 2;
  return checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(w)}${c.after.padEnd(14)}pre-saga ${c.before}`).join("\n");
};

export { getAddress };
