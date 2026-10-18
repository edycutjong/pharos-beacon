import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, maxUint256, pad, type Hex, type RpcLog } from "viem";
import { describe, expect, it } from "vitest";
import { main } from "../tasks/wallet-risk-checker/index.js";
import { checkAddress, firstBlock, parseRiskConfig, reportText, verdictOf, type RiskConfig, type Signal } from "../src/risk/check.js";
import { TOKENS } from "../src/lib/networks.js";

const WPHRS = TOKENS.atlantic.WPHRS.address as Hex;
const WALLET = getAddress("0x00000000000000000000000000000000000000a1");
const FLAGGED = getAddress("0x00000000000000000000000000000000000000f1");
const FRIEND = getAddress("0x00000000000000000000000000000000000000b1");
const SPENDER = getAddress("0x00000000000000000000000000000000000000c1");
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}` as Hex;
const config = (over: Partial<RiskConfig> = {}): RiskConfig => ({ flagged: [{ address: FLAGGED, reason: "test flag", source: "our test list" }], trustedSpenders: [], extraTokens: [], youngDays: 7, ...over });

const transfer = (block: number, tx: number, from: Hex, to: Hex): RpcLog => ({ address: WPHRS, blockNumber: hex(block), logIndex: "0x0", transactionHash: pad(hex(tx), { size: 32 }), topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }), data: encodeAbiParameters([{ type: "uint256" }], [1n]) }) as unknown as RpcLog;
const approval = (block: number, tx: number, owner: Hex, spender: Hex, value: bigint): RpcLog => ({ address: WPHRS, blockNumber: hex(block), logIndex: "0x0", transactionHash: pad(hex(tx), { size: 32 }), topics: encodeEventTopics({ abi: erc20Abi, eventName: "Approval", args: { owner, spender } }), data: encodeAbiParameters([{ type: "uint256" }], [value]) }) as unknown as RpcLog;

interface World {
  head?: number;
  /** block at which the address first has code (contract) or nonce > 0 (wallet); undefined = never */
  firstActive?: number;
  contract?: boolean;
  balance?: bigint;
  logs?: RpcLog[];
  /** seconds per block */
  blockTime?: number;
  /** other addresses (spenders) that have code */
  withCode?: string[];
}
function chain(w: World) {
  const head = w.head ?? 100_000;
  const bt = w.blockTime ?? 100;
  const calls: { tool: string; args: any }[] = [];
  const at = (a: any) => (a.block === undefined || a.block === "latest" ? head : Number(a.block));
  const call = (async (tool: string, a: any = {}) => {
    calls.push({ tool, args: a });
    if (tool === "get_block_number") return { blockNumber: String(head) };
    if (tool === "get_code" && (w.withCode ?? []).map((x) => x.toLowerCase()).includes(String(a.address).toLowerCase())) return { code: "0x6080" };
    if (tool === "get_code") return { code: w.contract && w.firstActive !== undefined && at(a) >= w.firstActive ? "0x6080" : "0x" };
    if (tool === "get_transaction_count") return { nonce: !w.contract && w.firstActive !== undefined && at(a) >= w.firstActive ? "3" : "0" };
    if (tool === "get_balance") return { balanceWei: String(w.balance ?? 0n) };
    if (tool === "get_block") return { timestamp: hex(1_700_000_000 + Number(a.block) * bt) };
    if (tool === "get_logs") {
      const [t0, t1, t2] = a.topics ?? [];
      const ok = (t: Hex | undefined, want: any) => want == null || [].concat(want).map((x: string) => x.toLowerCase()).includes(String(t).toLowerCase());
      return (w.logs ?? []).filter((l) => Number(BigInt(l.blockNumber!)) >= Number(a.fromBlock) && Number(BigInt(l.blockNumber!)) <= Number(a.toBlock) && ok(l.topics[0], t0) && ok(l.topics[1], t1) && ok(l.topics[2], t2));
    }
    throw new Error(`unexpected ${tool}`);
  }) as any;
  return Object.assign(call, { calls });
}
const opts = { network: "atlantic" as const, config: config(), lookbackBlocks: 50_000n };
const ids = (r: { signals: Signal[] }) => Object.fromEntries(r.signals.map((s) => [s.id, s.level]));

describe("firstBlock", () => {
  it("binary-searches the first block where the predicate holds, in about log2(head) reads", async () => {
    let reads = 0;
    const b = await firstBlock(async (n) => (reads++, n >= 12_345n), 1_000_000n);
    expect(b).toBe(12_345n);
    expect(reads).toBeLessThanOrEqual(22);
    expect(await firstBlock(async () => false, 10n)).toBeNull();
    expect(await firstBlock(async () => true, 10n)).toBe(0n);
  });
});

describe("checkAddress", () => {
  it("a long-used wallet with no flagged counterpart and no odd approvals is LOW, with every signal explained", async () => {
    const r = await checkAddress(chain({ firstActive: 1_000, balance: 5n * 10n ** 18n, logs: [transfer(90_000, 1, WALLET, FRIEND)] }), WALLET, opts);
    expect(r.verdict).toBe("low");
    expect(r.signals.map((s) => s.id)).toEqual(["kind", "age", "funding", "flagged", "approvals", "counterparties"]);
    expect(ids(r)).toMatchObject({ age: "ok", funding: "ok", flagged: "ok", approvals: "ok" });
    expect(r.reasons).toEqual([]);
    expect(r.signals.every((s) => s.detail.length > 20)).toBe(true);
    expect(reportText(r)).toContain("RISK: LOW — no red flags");
  });
  it("a young wallet is a medium flag with the age in plain words", async () => {
    const r = await checkAddress(chain({ firstActive: 99_000, balance: 1n }), WALLET, opts);
    expect(ids(r).age).toBe("medium");
    expect(r.signals.find((s) => s.id === "age")!.detail).toContain("block 99000, 27.8 hours before block 100000");
    expect(r.verdict).toBe("medium");
  });
  it("funded but never sent anything is flagged as freshly funded", async () => {
    const r = await checkAddress(chain({ balance: 10n ** 16n }), WALLET, opts);
    expect(ids(r).funding).toBe("medium");
    expect(r.signals.find((s) => s.id === "funding")!.detail).toContain("never sent a transaction");
  });
  it("an address with no history at all is flagged as nothing to judge by", async () => {
    const r = await checkAddress(chain({}), WALLET, opts);
    expect(r.signals.find((s) => s.id === "age")).toMatchObject({ level: "medium" });
    expect(r.signals.find((s) => s.id === "age")!.detail).toContain("no history at all");
  });
  it("moving tokens with a flagged address, in either direction, is HIGH and names the transaction", async () => {
    for (const log of [transfer(99_990, 7, WALLET, FLAGGED), transfer(99_990, 7, FLAGGED, WALLET)]) {
      const r = await checkAddress(chain({ firstActive: 1_000, balance: 1n, logs: [log] }), WALLET, opts);
      expect(r.verdict).toBe("high");
      const f = r.signals.find((s) => s.id === "flagged")!;
      expect(f.level).toBe("high");
      expect(f.detail).toContain("test flag");
      expect(f.detail).toContain("our test list");
      expect(f.detail).toContain(pad(hex(7), { size: 32 }));
    }
  });
  it("an address that is itself on the list is HIGH", async () => {
    const r = await checkAddress(chain({ firstActive: 1_000, balance: 1n }), FLAGGED, opts);
    expect(r.verdict).toBe("high");
    expect(r.signals.find((s) => s.id === "flagged")!.title).toBe("on our flagged list");
  });
  it("an unlimited approval to an unknown spender WITH code is medium; to an address with NO code it is HIGH on its own, with no list entry involved", async () => {
    const base = { firstActive: 1_000, balance: 1n, logs: [approval(99_000, 1, WALLET, SPENDER, maxUint256)] };
    const router = await checkAddress(chain({ ...base, withCode: [SPENDER] }), WALLET, opts);
    expect(ids(router).approvals).toBe("medium");
    expect(router.verdict).toBe("medium");
    const bare = await checkAddress(chain(base), WALLET, { ...opts, config: config({ flagged: [] }) });
    expect(ids(bare).approvals).toBe("high");
    expect(bare.verdict).toBe("high");
    expect(bare.signals.find((s) => s.id === "approvals")!.detail).toContain("not a contract");
    // a small allowance to a plain wallet stays medium: only the unlimited pattern is called high
    const small = await checkAddress(chain({ ...base, logs: [approval(99_000, 1, WALLET, SPENDER, 5n)] }), WALLET, opts);
    expect(ids(small).approvals).toBe("medium");
  });
  it("prints the lookback window in time as well as blocks", async () => {
    const r = await checkAddress(chain({ firstActive: 1_000, balance: 1n }), WALLET, { ...opts, lookbackBlocks: 30_000n });
    expect(r.lookbackSeconds).toBe(30_000 * 100);
    expect(reportText(r)).toContain("(about 35 days)");
  });
  it("an unlimited approval to an unknown spender is medium; a trusted spender, a revoked approval and a small unknown one behave", async () => {
    const base = { firstActive: 1_000, balance: 1n };
    const unlimited = await checkAddress(chain({ ...base, withCode: [SPENDER], logs: [approval(99_000, 1, WALLET, SPENDER, maxUint256)] }), WALLET, opts);
    expect(ids(unlimited).approvals).toBe("medium");
    expect(unlimited.signals.find((s) => s.id === "approvals")!.detail).toContain("unlimited");
    const trusted = await checkAddress(chain({ ...base, logs: [approval(99_000, 1, WALLET, SPENDER, maxUint256)] }), WALLET, { ...opts, config: config({ trustedSpenders: [{ address: SPENDER, label: "Test DEX" }] }) });
    expect(ids(trusted).approvals).toBe("ok");
    const revoked = await checkAddress(chain({ ...base, logs: [approval(99_000, 1, WALLET, SPENDER, maxUint256), approval(99_500, 2, WALLET, SPENDER, 0n)] }), WALLET, opts);
    expect(ids(revoked).approvals).toBe("ok");
    const small = await checkAddress(chain({ ...base, logs: [approval(99_000, 1, WALLET, SPENDER, 5n)] }), WALLET, opts);
    expect(small.signals.find((s) => s.id === "approvals")!.detail).toContain("do not recognise");
    const toFlagged = await checkAddress(chain({ ...base, logs: [approval(99_000, 1, WALLET, FLAGGED, 5n)] }), WALLET, opts);
    expect(toFlagged.verdict).toBe("high");
  });
  it("a contract is told apart from a wallet and is aged by its first code", async () => {
    const r = await checkAddress(chain({ contract: true, firstActive: 10_000, balance: 0n }), WALLET, opts);
    expect(r.signals[0]!.detail).toContain("It is a contract");
    expect(r.signals.find((s) => s.id === "age")!.detail).toContain("code first appears in block 10000");
  });
  it("--block pins the check to an earlier block: the same report comes back later, and a future block is refused", async () => {
    const w = { firstActive: 1_000, balance: 1n, logs: [transfer(99_990, 7, WALLET, FLAGGED)], head: 105_000 };
    const pinned = await checkAddress(chain(w), WALLET, { ...opts, lookbackBlocks: 5_000n, block: 100_000n });
    const later = await checkAddress(chain({ ...w, head: 105_000 }), WALLET, { ...opts, lookbackBlocks: 5_000n, block: 100_000n });
    expect(pinned.block).toBe(100_000n);
    expect(JSON.stringify(pinned.signals)).toBe(JSON.stringify(later.signals));
    expect(pinned.verdict).toBe("high");
    expect((await checkAddress(chain(w), WALLET, { ...opts, lookbackBlocks: 5_000n })).verdict).toBe("low"); // at the head the transfer is older than the 5,000-block lookback
    await expect(checkAddress(chain(w), WALLET, { ...opts, block: 200_000n })).rejects.toThrow(/past the chain head/);
  });
  it("only reads the pinned lookback range", async () => {
    const c = chain({ firstActive: 1_000, balance: 1n, logs: [transfer(10, 1, WALLET, FLAGGED)] });
    const r = await checkAddress(c, WALLET, { ...opts, lookbackBlocks: 1_000n });
    expect(ids(r).flagged).toBe("ok"); // the flagged transfer is older than the 1,000 blocks read
    expect(c.calls.filter((x: { tool: string; args: any }) => x.tool === "get_logs").every((x: { args: any }) => Number(x.args.fromBlock) >= 99_000)).toBe(true);
  });
});

describe("verdictOf", () => {
  const s = (level: Signal["level"]): Signal => ({ id: "age", level, title: "t", detail: "d" });
  it("one or two mediums is medium, three is high, any high is high, none is low", () => {
    expect(verdictOf([s("ok"), s("info")])).toBe("low");
    expect(verdictOf([s("medium")])).toBe("medium");
    expect(verdictOf([s("medium"), s("medium")])).toBe("medium");
    expect(verdictOf([s("medium"), s("medium"), s("medium")])).toBe("high");
    expect(verdictOf([s("high"), s("ok")])).toBe("high");
  });
});

describe("parseRiskConfig", () => {
  it("accepts a good file and rejects bad entries with a message", () => {
    expect(parseRiskConfig({ flagged: [{ address: FLAGGED, reason: "r", source: "s" }] }).youngDays).toBe(7);
    expect(() => parseRiskConfig({ flagged: [{ address: "nope", reason: "r", source: "s" }] })).toThrow(/0x address/);
    expect(() => parseRiskConfig({ flagged: [{ address: FLAGGED, reason: "r" }] })).toThrow(/source/);
    expect(() => parseRiskConfig({ youngDays: 0 })).toThrow(/youngDays/);
    expect(() => parseRiskConfig({ flagged: "x" })).toThrow(/must be a list/);
  });
});

describe("CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "risk-"));
  const cfg = join(dir, "cfg.json");
  writeFileSync(cfg, JSON.stringify({ flagged: [{ address: FLAGGED, reason: "test flag", source: "our test list" }] }));
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({ name: "p", network: "atlantic", spendLimit: { perTx: "0.01" } }));
  const run = async (args: string[], w: World) => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => void lines.push(String(s));
    const c = chain(w);
    try {
      const code = await main({ onExit: () => {}, signal: new AbortController().signal }, args, async () => ({ call: c, close: async () => {}, endpoint: "fake", network: "atlantic", chainId: 688689, server: undefined }) as any);
      return { code, out: lines.join("\n"), c };
    } finally {
      console.log = orig;
    }
  };
  it("check prints each signal and the verdict with numbered reasons", async () => {
    const { code, out } = await run(["check", WALLET, "--network", "atlantic", "--config", cfg, "--lookback", "50000"], { firstActive: 1_000, balance: 1n, logs: [transfer(99_990, 7, WALLET, FLAGGED)] });
    expect(code).toBe(0);
    expect(out).toContain("[HIGH  ] interaction with a flagged address");
    expect(out).toContain("RISK: HIGH — 1 red flag");
    expect(out).toMatch(/\n {2}1\. It moved tokens with 0x0000…00f1/);
  });
  it("gate refuses a high-risk recipient: audit entry, no policy, nothing sent, exit 3", async () => {
    const audit = join(dir, "audit.jsonl");
    const { code, out, c } = await run(["gate", "--to", WALLET, "--amount", "0.001", "--config", cfg, "--policy", policy, "--audit", audit, "--state", join(dir, "s.json"), "--lookback", "50000"], { firstActive: 1_000, balance: 1n, logs: [transfer(99_990, 7, WALLET, FLAGGED)] });
    expect(code).toBe(3);
    expect(out).toContain("GATE: DENY by wallet_risk");
    expect(out).toContain("was NOT sent, and the policy was not asked");
    const entry = JSON.parse(readFileSync(audit, "utf8").trim());
    expect(entry).toMatchObject({ decision: "deny", rule: "wallet_risk", event: "decision" });
    expect(c.calls.some((x: { tool: string }) => x.tool === "send_raw_transaction")).toBe(false);
  });
  it("gate lets a low-risk recipient through to the Policy Gatekeeper (dry run: allowed, not sent)", async () => {
    const { code, out, c } = await run(["gate", "--to", FRIEND, "--amount", "0.001", "--config", cfg, "--policy", policy, "--audit", join(dir, "a2.jsonl"), "--state", join(dir, "s2.json"), "--lookback", "50000"], { firstActive: 1_000, balance: 1n });
    expect(code).toBe(0);
    expect(out).toContain("passing the request to the Policy Gatekeeper");
    expect(out).toContain("=> ALLOW");
    expect(out).toContain("dry-run: pass --execute to send");
    expect(c.calls.some((x: { tool: string }) => x.tool === "send_raw_transaction")).toBe(false);
  });
  it("gate --block-on medium also refuses a medium recipient", async () => {
    const { code } = await run(["gate", "--to", FRIEND, "--amount", "0.001", "--block-on", "medium", "--config", cfg, "--policy", policy, "--audit", join(dir, "a3.jsonl"), "--state", join(dir, "s3.json")], { firstActive: 99_000, balance: 1n });
    expect(code).toBe(3);
  });
  it("usage errors: unknown command, bad address, bad proof label, bad config", async () => {
    await expect(run(["nope"], {})).rejects.toThrow(/unknown command/);
    await expect(run(["check", "0x12"], {})).rejects.toThrow(/needs an address/);
    await expect(run(["check", WALLET, "--proof", "Bad Label"], {})).rejects.toThrow(/lower-case/);
    await expect(run(["check", WALLET, "--config", join(dir, "missing.json")], {})).rejects.toThrow(/cannot|ENOENT|no such/i);
    await expect(run(["gate", "--to", WALLET], {})).rejects.toThrow(/needs --to/);
  });
});

