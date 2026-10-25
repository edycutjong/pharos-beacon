import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbiItem, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { X402_USDC } from "../src/lib/networks.js";
import { Agent, covers, decide, readLog, type AgentEvent, type CachedAnswer, type Chain, type Want } from "../tasks/x402-agent-buyer/agent.js";
import { compactFormatter, failOnce, formatLog, formatLogCompact } from "../tasks/x402-agent-buyer/index.js";
import { PARTNER_URL, TASKS, partnerTask } from "../tasks/x402-agent-buyer/plan.js";
import { BASE_PATH, NETWORK, quoteFor } from "../tasks/x402-paywalled-api/config.js";

const KEY = generatePrivateKey();
const PAYER = privateKeyToAccount(KEY).address;
const PAY_TO = getAddress("0x8D347c72431ed6E033d5f43E56c0987E97f5D91B");
const TOKEN = getAddress(X402_USDC.address);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const u = (usdc: string) => BigInt(Math.round(Number(usdc) * 1e6));

const PRICES: Record<string, bigint> = { "gas-snapshot": 1000n, "whale-brief": 10_000n };
const priceOf = (path: string) => {
  const [route, q] = path.split("?");
  if (route === "whale-range") return quoteFor(Number(new URLSearchParams(q).get("blocks") ?? 2500)).amount;
  return PRICES[route!]!;
};

/**
 * An API and a chain in one stand-in. The API answers a bare request with a real 402 header, takes a PAYMENT-SIGNATURE, and
 * "settles" it once per EIP-3009 nonce: a second send of the same signature gets 402 nonce_already_used, as the real API does.
 */
function world() {
  const used = new Map<string, { tx: Hex; block: number; value: bigint }>();
  const requests: { path: string; paid: boolean }[] = [];
  let seq = 0;
  const api = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.slice(BASE_PATH.length + 1) + url.search;
    const sig = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
    requests.push({ path, paid: Boolean(sig) });
    const price = priceOf(path);
    const accepts = [{ scheme: "exact", network: NETWORK, asset: TOKEN, amount: price.toString(), payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } }];
    const required = (reason?: string) =>
      new Response(JSON.stringify({ reason }), { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, error: reason, resource: { url: String(input) }, accepts } as never) } });
    if (!sig) return required();
    const payload = decodePaymentSignatureHeader(sig);
    const auth = (payload.payload as { authorization: { nonce: Hex; value: string } }).authorization;
    if (used.has(auth.nonce)) return required("invalid_exact_evm_nonce_already_used");
    if (BigInt(auth.value) !== price) return required("invalid_exact_evm_payload_authorization_value_mismatch");
    const tx = `0x${(++seq).toString(16).padStart(64, "b")}` as Hex;
    used.set(auth.nonce, { tx, block: 100 + seq, value: price });
    const data = path.startsWith("whale") ? { blocks: "1000–1999", largest: [{ block: 1990, usdc: "9" }, { block: 1950, usdc: "8" }, { block: 1100, usdc: "7" }] } : { block: seq };
    return new Response(JSON.stringify(data), { status: 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: tx, network: NETWORK, payer: PAYER } as never) } });
  }) as typeof fetch;
  const chain: Chain = {
    nonceUsed: async (_p, n) => used.has(n),
    settlementOf: async (_p, n) => (used.has(n) ? { tx: used.get(n)!.tx, block: used.get(n)!.block } : undefined),
    receipt: async (hash) => {
      const s = [...used.values()].find((x) => x.tx === hash)!;
      return { status: "success", blockNumber: BigInt(s.block), logs: [{ address: TOKEN, data: encodeAbiParameters([{ type: "uint256" }], [s.value]), topics: encodeEventTopics({ abi: [transferEvent], eventName: "Transfer", args: { from: PAYER, to: PAY_TO } }) }] } as never;
    },
  };
  return { api, chain, used, requests, settles: () => used.size };
}

function agentFor(taskId: keyof typeof TASKS | "custom", w = world(), extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "x402-buyer-"));
  const events: AgentEvent[] = [];
  const task = TASKS[taskId === "custom" ? "retry" : taskId]!;
  const agent = new Agent({
    task: task.id, base: "https://api.test", key: KEY, policy: task.policy, logFile: join(dir, "log.jsonl"), journalFile: join(dir, "journal.json"),
    fetch: w.api, chain: w.chain, sleep: async () => undefined, emit: (e) => events.push(e), ...extra,
  });
  return { agent, w, events, dir, task };
}

const want = (over: Partial<Want> = {}): Want => ({ id: "w", path: "gas-snapshot", purpose: "x", maxWorth: u("0.01"), ...over });
const base = { asset: TOKEN, network: NETWORK, spent: 0n, pending: 0n, cache: [] as CachedAnswer[], now: 1_000_000 };
const policy = { budget: u("0.05"), perCallCap: u("0.02") };

describe("decide: the policy, in order", () => {
  it("buys when cap, worth, cache and budget all allow it", () => {
    expect(decide({ ...base, want: want(), ask: 1000n, policy })).toEqual({ buy: true });
  });
  it("refuses over the per-call cap, even when the budget is huge", () => {
    const d = decide({ ...base, want: want({ maxWorth: u("1") }), ask: u("0.021"), policy: { budget: u("5"), perCallCap: u("0.02") } });
    expect(d).toMatchObject({ buy: false, why: "over-cap" });
  });
  it("refuses an answer that costs more than the task thinks it is worth", () => {
    expect(decide({ ...base, want: want({ maxWorth: 500n }), ask: 1000n, policy })).toMatchObject({ buy: false, why: "not-worth" });
  });
  it("refuses when spent + pending + price would pass the budget, and the text says by how much is left", () => {
    const d = decide({ ...base, want: want(), ask: u("0.01"), spent: u("0.03"), pending: u("0.01"), policy: { budget: u("0.045"), perCallCap: u("0.02") } });
    expect(d).toMatchObject({ buy: false, why: "over-budget" });
    expect((d as { text: string }).text).toContain("0.005 USDC left");
  });
  it("allows a purchase that lands exactly on the budget", () => {
    expect(decide({ ...base, want: want(), ask: u("0.01"), spent: u("0.04"), policy })).toEqual({ buy: true });
  });
  it("refuses a 402 that asks for another token or another network", () => {
    expect(decide({ ...base, want: want(), ask: 1n, asset: "0x0000000000000000000000000000000000000001", policy })).toMatchObject({ why: "wrong-asset" });
    expect(decide({ ...base, want: want(), ask: 1n, network: "eip155:1672", policy })).toMatchObject({ why: "wrong-asset" });
  });
  it("checks the cap before the worth, the worth before the cache, the cache before the budget", () => {
    const cache: CachedAnswer[] = [{ key: "t/gas", path: "gas-snapshot", at: base.now, data: {} }];
    expect(decide({ ...base, want: want({ maxWorth: 1n }), ask: u("0.5"), policy, cache })).toMatchObject({ why: "over-cap" });
    expect(decide({ ...base, want: want({ maxWorth: 1n }), ask: 1000n, policy, cache })).toMatchObject({ why: "not-worth" });
    expect(decide({ ...base, want: want(), ask: 1000n, spent: u("0.05"), policy, cache })).toMatchObject({ why: "redundant", saved: 1000n });
  });
});

describe("covers: when an answer already bought still answers the question", () => {
  const brief = (blocks: string, top: number[]): CachedAnswer => ({ key: "t/b", path: "whale-range?blocks=2000", at: 0, data: { blocks, largest: top.map((b) => ({ block: b, usdc: "1" })) } });
  it("covers gas-snapshot inside its 60 s TTL only", () => {
    const c: CachedAnswer = { key: "t/g", path: "gas-snapshot", at: 0, data: {} };
    expect(covers({ path: "gas-snapshot" }, c, 59_000)).toBe(true);
    expect(covers({ path: "gas-snapshot" }, c, 61_000)).toBe(false);
    expect(covers({ path: "whale-brief" }, c, 1000)).toBe(false);
  });
  it("covers the last 1,000 blocks when enough of the listed transfers sit in that window", () => {
    const c = brief("1000–2999", [2990, 2500, 2100, 1500, 1200]); // window = 2000–2999: three listed transfers inside
    expect(covers({ path: "whale-brief", top: 3 }, c, 1000)).toBe(true);
    expect(covers({ path: "whale-brief", top: 4 }, c, 1000)).toBe(false);
  });
  it("does not cover when the answer's range is shorter than the question", () => {
    expect(covers({ path: "whale-range?blocks=3000" }, brief("1000–2999", [2990]), 1000)).toBe(false);
  });
  it("does not cover when the listed transfers in the window are fewer than asked for", () => {
    const c = brief("1000–2999", [2990, 1500, 1200, 1100, 1050]); // only one in 2000–2999
    expect(covers({ path: "whale-brief", top: 3 }, c, 1000)).toBe(false);
    expect(covers({ path: "whale-brief", top: 1 }, c, 1000)).toBe(true);
  });
});

describe("a task that finishes", () => {
  it("buys three answers, refuses two repeats as redundant and a dear extra as not worth it, and logs a running total", async () => {
    const { agent, w, events } = agentFor("finish");
    const s = await agent.run(TASKS.finish!.wants);
    expect(s.outcome).toBe("finished");
    expect(s.results.map((r) => `${r.want}:${r.status}`)).toEqual(["gas:paid", "whales:paid", "whales-1k:redundant", "gas-again:redundant", "range:paid", "deep-history:not-worth"]);
    expect(w.settles()).toBe(3);
    expect(s.saved).toBe("0.006 USDC"); // 0.005 (the other route) + 0.001 (gas again)
    const rows = readLog(agent.o.logFile);
    expect(rows.map((r) => [r.price, r.runningTotal])).toEqual([["0.001 USDC", "0.001 USDC"], ["0.01 USDC", "0.011 USDC"], ["0.01 USDC", "0.021 USDC"]]);
    expect(rows.every((r) => /^0x[0-9a-f]{64}$/.test(r.tx!) && r.explorer!.endsWith(r.tx!) && r.bought.length > 0)).toBe(true);
    expect(events.filter((e) => e.type === "refused").map((e) => (e as { why: string }).why)).toEqual(["redundant", "redundant", "not-worth"]);
  });
  it("asks the price of a redundant or refused want without paying for it", async () => {
    const { agent, w } = agentFor("finish");
    await agent.run(TASKS.finish!.wants);
    expect(w.requests.filter((r) => r.paid)).toHaveLength(3);
    expect(w.requests.filter((r) => !r.paid && r.path === "whale-range?blocks=3000")).toHaveLength(1);
    expect(w.requests.filter((r) => r.paid && r.path === "whale-range?blocks=2000")).toHaveLength(1);
    expect(w.requests.filter((r) => r.paid && r.path === "whale-range?blocks=1000")).toHaveLength(0);
  });
});

describe("a task that stops at the budget", () => {
  it("pays two, refuses the third as over budget, and does not attempt the rest", async () => {
    const { agent, w, events } = agentFor("budget");
    const s = await agent.run(TASKS.budget!.wants);
    expect(s.outcome).toBe("stopped-budget");
    expect(s.results.map((r) => `${r.want}:${r.status}`)).toEqual(["gas:paid", "whales:paid", "history:over-budget", "summary-gas:not-attempted"]);
    expect(agent.spent()).toBe(u("0.011"));
    expect(w.settles()).toBe(2);
    expect(events.some((e) => e.type === "stopped")).toBe(true);
    expect(w.requests.some((r) => r.path.startsWith("gas-snapshot") && r.paid)).toBe(true);
  });
});

describe("the per-call cap", () => {
  it("refuses the 0.015 answer and goes on with the rest", async () => {
    const { agent } = agentFor("cap");
    const s = await agent.run(TASKS.cap!.wants);
    expect(s.results.map((r) => `${r.want}:${r.status}`)).toEqual(["gas:paid", "history:over-cap", "whales:paid"]);
    expect(s.outcome).toBe("finished");
  });
});

describe("safe retries: the same payment never counts twice", () => {
  const gas = TASKS.retry!.wants[0]!;

  it("a failure BEFORE the request leaves: the retry re-sends the same signature and pays once", async () => {
    const w = world();
    const { agent, events } = agentFor("retry", w, { fetch: failOnce(w.api, "before") });
    const r = await agent.buy(gas);
    expect(r.status).toBe("paid");
    expect(w.settles()).toBe(1);
    expect(readLog(agent.o.logFile)).toHaveLength(1);
    expect(events.filter((e) => e.type === "sign")).toHaveLength(1);
    expect(events.filter((e) => e.type === "attempt")).toHaveLength(2);
  });

  it("a failure AFTER the API settled: the retry is refused as a used nonce, the log still has one row", async () => {
    const w = world();
    const { agent, events } = agentFor("retry", w, { fetch: failOnce(w.api, "after") });
    const r = await agent.buy(gas);
    expect(r.status).toBe("paid-data-lost");
    expect(w.settles()).toBe(1);
    const rows = readLog(agent.o.logFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toContain("counted once");
    expect(rows[0]!.tx).toBe([...w.used.values()][0]!.tx);
    expect(events.filter((e) => e.type === "sign")).toHaveLength(1);
    // The 402 for the replay is the proof: the second send settled nothing.
    expect(events.some((e) => e.type === "reconcile" && e.nonceUsed)).toBe(true);
  });

  it("asking again under the same key after that never pays again, and does not even call the API", async () => {
    const w = world();
    const { agent } = agentFor("retry", w, { fetch: failOnce(w.api, "after") });
    await agent.buy(gas);
    const before = w.requests.length;
    const again = await agent.buy(gas);
    expect(again.status).toBe("paid-data-lost");
    expect(w.requests.length).toBe(before);
    expect(w.settles()).toBe(1);
    expect(agent.spent()).toBe(1000n);
  });

  it("re-running a finished task pays nothing and sends no request", async () => {
    const w = world();
    const { agent } = agentFor("finish", w);
    await agent.run(TASKS.finish!.wants.slice(0, 2));
    const before = w.requests.length;
    const s = await agent.run(TASKS.finish!.wants.slice(0, 2));
    expect(s.results.map((r) => r.status)).toEqual(["already-paid", "already-paid"]);
    expect(w.requests.length).toBe(before);
    expect(w.settles()).toBe(2);
    expect(readLog(agent.o.logFile)).toHaveLength(2);
  });

  it("when every send fails and the chain shows the nonce unused, the signed payment stays pending and counts against the budget", async () => {
    const w = world();
    const dead = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) throw new Error("network down");
      return w.api(input, init);
    }) as typeof fetch;
    const { agent } = agentFor("retry", w, { fetch: dead, retries: 3 });
    const r = await agent.buy(gas);
    expect(r.status).toBe("failed");
    expect(w.settles()).toBe(0);
    expect(agent.spent()).toBe(0n);
    expect(agent.pending()).toBe(1000n);
    // Budget 0.01: the pending 0.001 plus a 0.01 purchase is over it.
    const next = await agent.buy({ ...gas, id: "whales", path: "whale-brief", maxWorth: u("0.02") });
    expect(next.status).toBe("over-budget");
  });

  it("an authorization that lapsed unsettled is replaced by a new one, once", async () => {
    const w = world();
    let t = Date.now();
    let down = true;
    const dead = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).has("PAYMENT-SIGNATURE") && down) throw new Error("network down");
      return w.api(input, init);
    }) as typeof fetch;
    const { agent, events } = agentFor("retry", w, { fetch: dead, retries: 1, now: () => t });
    expect((await agent.buy(gas)).status).toBe("failed");
    t += 10 * 60_000; // past validBefore (signed for about two minutes)
    down = false;
    const r = await agent.buy(gas);
    expect(r.status).toBe("paid");
    expect(w.settles()).toBe(1);
    expect(events.filter((e) => e.type === "sign")).toHaveLength(2);
    expect(readLog(agent.o.logFile)).toHaveLength(1);
  });

  it("a 200 whose receipt holds no matching Transfer although our authorization is used: data refused, the payment counted once", async () => {
    const w = world();
    const bad: Chain = { ...w.chain, receipt: async () => ({ status: "success", blockNumber: 1n, logs: [] }) as never };
    const { agent, events } = agentFor("retry", w, { chain: bad });
    const r = await agent.buy(gas);
    expect(r.status).toBe("failed");
    const rows = readLog(agent.o.logFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toContain("counted once");
    expect(agent.spent()).toBe(1000n);
    expect(events.some((e) => e.type === "failed" && e.text.includes("receipt check failed"))).toBe(true);
    // A re-run does not sign a second payment under the same key.
    expect((await agent.buy(gas)).status).toBe("paid-data-lost");
    expect(w.settles()).toBe(1);
  });

  it("a 200 that names another seller's transaction: the real settlement is logged once, the data is refused", async () => {
    const w = world();
    const other = agentFor("retry", w); // a different ledger buys first; its tx is not in the ledger under test
    await other.agent.buy(gas);
    const foreign = readLog(other.agent.o.logFile)[0]!.tx!;
    const liar = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await w.api(input, init);
      if (!new Headers(init?.headers).has("PAYMENT-SIGNATURE")) return res;
      return new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: foreign, network: NETWORK, payer: PAYER } as never) } });
    }) as typeof fetch;
    const { agent } = agentFor("retry", w, { fetch: liar });
    const r = await agent.buy(gas);
    expect(r.status).toBe("failed");
    const rows = readLog(agent.o.logFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tx).not.toBe(foreign);
    expect(rows[0]!.note).toContain("named another transaction");
    expect(w.settles()).toBe(2);
  });

  it("a receipt that cannot be read leaves the payment pending, and a re-run reconciles it from the chain without paying again", async () => {
    const w = world();
    const flaky: Chain = { ...w.chain, receipt: async () => { throw new Error("rpc timeout"); } };
    const { agent } = agentFor("retry", w, { chain: flaky });
    const r = await agent.buy(gas);
    expect(r.status).toBe("failed");
    expect(agent.pending()).toBe(1000n);
    expect(agent.spent()).toBe(0n);
    const again = await agent.buy(gas);
    expect(again.status).toBe("paid-data-lost");
    expect(w.settles()).toBe(1);
    expect(readLog(agent.o.logFile)).toHaveLength(1);
  });

  it("a 402 that is not a replay: the token is asked, the authorization stays counted until it lapses, and no second payment is signed", async () => {
    const w = world();
    let refuse = true;
    const api = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (refuse && new Headers(init?.headers).has("PAYMENT-SIGNATURE")) {
        const bare = await w.api(input, {});
        return new Response(JSON.stringify({ reason: "invalid_exact_evm_transaction_failed" }), { status: 402, headers: bare.headers });
      }
      return w.api(input, init);
    }) as typeof fetch;
    let t = Date.now();
    const { agent, events } = agentFor("retry", w, { fetch: api, now: () => t });
    expect((await agent.buy(gas)).status).toBe("failed");
    expect(agent.pending()).toBe(1000n);
    refuse = false;
    // Still valid: not signing a second authorization.
    expect((await agent.buy(gas)).status).toBe("failed");
    expect(events.filter((e) => e.type === "sign")).toHaveLength(1);
    // Lapsed (past validBefore + margin): safe to sign again, and it pays once.
    t += 10 * 60_000;
    expect((await agent.buy(gas)).status).toBe("paid");
    expect(events.filter((e) => e.type === "sign")).toHaveLength(2);
    expect(w.settles()).toBe(1);
  });

  it("a refused purchase is not signed again while the token cannot be read", async () => {
    const w = world();
    let refuse = true;
    const api = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (refuse && new Headers(init?.headers).has("PAYMENT-SIGNATURE")) {
        const bare = await w.api(input, {});
        return new Response(JSON.stringify({ reason: "invalid_exact_evm_transaction_failed" }), { status: 402, headers: bare.headers });
      }
      return w.api(input, init);
    }) as typeof fetch;
    const { agent, events } = agentFor("retry", w, { fetch: api });
    expect((await agent.buy(gas)).status).toBe("failed"); // rejected: the token said unused
    refuse = false;
    const down = new Agent({ ...agent.o, chain: { ...w.chain, nonceUsed: async () => { throw new Error("rpc down"); } } });
    const r = await down.buy(gas);
    expect(r.status).toBe("failed");
    expect(events.filter((e) => e.type === "sign")).toHaveLength(1);
    expect(w.settles()).toBe(0);
  });

  it("a response body that is cut after the API settled is reconciled at once", async () => {
    const w = world();
    const cut = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await w.api(input, init);
      if (!new Headers(init?.headers).has("PAYMENT-SIGNATURE")) return res;
      return { status: 200, headers: res.headers, text: async () => { throw new Error("socket hang up"); } } as unknown as Response;
    }) as typeof fetch;
    const { agent } = agentFor("retry", w, { fetch: cut });
    expect((await agent.buy(gas)).status).toBe("paid-data-lost");
    expect(readLog(agent.o.logFile)).toHaveLength(1);
    expect(w.settles()).toBe(1);
  });

  it("exhausted retries still ask the token: a payment that did settle is logged once", async () => {
    const w = world();
    // The API settles, then answers 503 every time.
    const api = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await w.api(input, init);
      return new Headers(init?.headers).has("PAYMENT-SIGNATURE") ? new Response("busy", { status: 503 }) : res;
    }) as typeof fetch;
    const { agent } = agentFor("retry", w, { fetch: api, retries: 2 });
    const r = await agent.buy(gas);
    expect(r.status).toBe("paid-data-lost");
    expect(w.settles()).toBe(1);
    expect(readLog(agent.o.logFile)).toHaveLength(1);
  });

  it("a settlement outside the lookback is still logged once, without a tx", async () => {
    const w = world();
    const blind: Chain = { ...w.chain, settlementOf: async () => undefined };
    const { agent } = agentFor("retry", w, { chain: blind, fetch: failOnce(w.api, "after") });
    expect((await agent.buy(gas)).status).toBe("paid-data-lost");
    const rows = readLog(agent.o.logFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tx).toBeUndefined();
    expect(formatLog(rows)).toContain("not found in the lookback");
  });

  it("refuses to sign an authorization that stays valid longer than 15 minutes", async () => {
    const w = world();
    const long = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await w.api(input, init);
      if (res.status !== 402) return res;
      const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
      pr.accepts[0]!.maxTimeoutSeconds = 7200;
      return new Response(res.body, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) } });
    }) as typeof fetch;
    const { agent, events } = agentFor("retry", w, { fetch: long });
    expect((await agent.buy(gas)).status).toBe("failed");
    expect(events.some((e) => e.type === "failed" && e.text.includes("valid longer"))).toBe(true);
    expect(w.settles()).toBe(0);
  });

  it("signs the offer in test USDC on Atlantic even when it is not the first one listed", async () => {
    const w = world();
    const two = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await w.api(input, init);
      if (res.status !== 402) return res;
      const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
      pr.accepts.unshift({ ...pr.accepts[0]!, amount: "5", asset: "0x0000000000000000000000000000000000000001" });
      return new Response(res.body, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) } });
    }) as typeof fetch;
    const { agent } = agentFor("retry", w, { fetch: two });
    expect((await agent.buy(gas)).status).toBe("paid");
    expect(agent.spent()).toBe(1000n);
  });

  it("does not reuse an idempotency key for another question", async () => {
    const w = world();
    const { agent } = agentFor("retry", w);
    await agent.buy(gas);
    const r = await agent.buy({ ...gas, path: "whale-brief" });
    expect(r.status).toBe("failed");
    expect(w.settles()).toBe(1);
  });

  it("two purchases started at once cannot both fit a budget that holds one", async () => {
    const w = world();
    const { agent } = agentFor("retry", w); // budget 0.01
    const [a, b] = await Promise.all([agent.buy({ ...gas, id: "a", path: "whale-brief", maxWorth: u("0.02") }), agent.buy({ ...gas, id: "b", path: "gas-snapshot", maxWorth: u("0.02") })]);
    expect([a.status, b.status].sort()).toEqual(["over-budget", "paid"]);
    expect(w.settles()).toBe(1);
  });

  it("a second run on the same ledger fails at once on the lock", async () => {
    const w = world();
    const { agent } = agentFor("finish", w);
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => { await new Promise((r) => setTimeout(r, 30)); return w.api(input, init); }) as typeof fetch;
    const dir = agent.o.journalFile;
    const a = new Agent({ ...agent.o, fetch: slow, journalFile: dir });
    const b = new Agent({ ...agent.o, fetch: slow, journalFile: dir });
    const res = await Promise.allSettled([a.run(TASKS.finish!.wants.slice(0, 1)), b.run(TASKS.finish!.wants.slice(0, 1))]);
    expect(res.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(w.settles()).toBe(1);
  });

  it("buys from a seller at another address (an absolute URL) under the same rules", async () => {
    const w = world();
    const other = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u2 = new URL(String(input));
      const rewritten = u2.hostname === "partner.test" ? `https://api.test${BASE_PATH}/gas-snapshot` : String(input);
      return w.api(rewritten, init);
    }) as typeof fetch;
    const { agent, events } = agentFor("retry", w, { fetch: other });
    const r = await agent.buy({ ...gas, id: "theirs", path: "https://partner.test/paid/network-snapshot?block=1" });
    expect(r.status).toBe("paid");
    expect(readLog(agent.o.logFile)[0]!.endpoint).toBe("https://partner.test/paid/network-snapshot?block=1");
    expect(events.some((e) => e.type === "ask")).toBe(true);
  });

  it("a seller that names someone else's transaction as the payment is not believed", async () => {
    const w = world();
    const first = agentFor("retry", w);
    await first.agent.buy(gas); // a real purchase: its tx is in the log
    const oldTx = readLog(first.agent.o.logFile)[0]!.tx!;
    // The same ledger, a new purchase: the seller answers 200 and points at the OLD transaction.
    const liar = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await w.api(input, init);
      if (!new Headers(init?.headers).has("PAYMENT-SIGNATURE")) return res;
      return new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: oldTx, network: NETWORK, payer: PAYER } as never) } });
    }) as typeof fetch;
    const second = new Agent({ ...first.agent.o, fetch: liar });
    const r = await second.buy({ ...gas, id: "again", path: "whale-range?blocks=1000", maxWorth: u("0.02") });
    expect(r.status).toBe("failed");
    expect(readLog(first.agent.o.logFile)).toHaveLength(1);
  });

  it("a receipt that matches the price but not our authorization is refused and the payment stays pending", async () => {
    const w = world();
    const unused: Chain = { ...w.chain, nonceUsed: async () => false };
    const { agent } = agentFor("retry", w, { chain: unused });
    const r = await agent.buy(gas);
    expect(r.status).toBe("failed");
    expect(readLog(agent.o.logFile)).toHaveLength(0);
    expect(agent.pending()).toBe(1000n);
  });

  it("one ledger is one budget, whichever task spends from it", async () => {
    const w = world();
    const a = agentFor("retry", w); // budget 0.01
    await a.agent.buy({ ...gas, id: "x", path: "whale-brief", maxWorth: u("0.02") });
    const b = new Agent({ ...a.agent.o, task: "other" });
    const r = await b.buy({ ...gas, id: "y", path: "gas-snapshot" });
    expect(r.status).toBe("over-budget");
  });

  it("before deciding, an older signed payment that did settle is logged, so the budget is right", async () => {
    const w = world();
    const dead = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await w.api(input, init);
      if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) throw new Error("lost");
      return res;
    }) as typeof fetch;
    const { agent } = agentFor("retry", w, { fetch: dead, retries: 1, chain: { ...w.chain, nonceUsed: async () => false } });
    await agent.buy({ ...gas, id: "old", path: "whale-brief", maxWorth: u("0.02") }); // settled at the API; the agent could not tell
    expect(agent.pending()).toBe(10_000n);
    const fresh = new Agent({ ...agent.o, fetch: w.api, chain: w.chain });
    const r = await fresh.buy({ ...gas, id: "new", path: "gas-snapshot" });
    expect(r.status).toBe("over-budget"); // the old 0.01 is now known to be spent: 0.01 + 0.001 > 0.01
    expect(readLog(agent.o.logFile).map((x) => x.purchase)).toEqual(["retry/old"]);
  });

  it("a half-written last line in the payment log does not swallow the next row", async () => {
    const w = world();
    const { agent } = agentFor("retry", w);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(agent.o.logFile, '{"n":1,"half');
    await agent.buy(gas);
    const rows = readLog(agent.o.logFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.purchase).toBe("retry/gas");
  });

  it("failOnce drops only the first paid request", async () => {
    const calls: boolean[] = [];
    const f = failOnce((async (_i: RequestInfo | URL, init?: RequestInit) => (calls.push(new Headers(init?.headers).has("PAYMENT-SIGNATURE")), new Response("ok"))) as typeof fetch, "before");
    await f("https://x", {});
    await expect(f("https://x", { headers: { "PAYMENT-SIGNATURE": "s" } })).rejects.toThrow("never left");
    await f("https://x", { headers: { "PAYMENT-SIGNATURE": "s" } });
    expect(calls).toEqual([false, true]);
  });
});

describe("keys and signatures", () => {
  it("never write the private key or the signed authorization into the log, the events or the printed table", async () => {
    const { agent, events, dir } = agentFor("finish");
    await agent.run(TASKS.finish!.wants);
    const journal = JSON.parse(readFileSync(join(dir, "journal.json"), "utf8")) as Record<string, { header: string }>;
    const header = Object.values(journal)[0]!.header;
    const out = JSON.stringify(events) + readFileSync(agent.o.logFile, "utf8") + formatLog(readLog(agent.o.logFile));
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(KEY.slice(2));
    expect(out).not.toContain(header);
  });
});

describe("the demo tasks", () => {
  it("fit their stories: finish has room in the budget, budget runs out, cap is below the dearest price", () => {
    expect(TASKS.finish!.policy.budget).toBeGreaterThan(u("0.011"));
    expect(TASKS.budget!.policy.budget).toBeLessThan(u("0.026"));
    expect(TASKS.cap!.policy.perCallCap).toBeLessThan(quoteFor(3000).amount);
    expect(TASKS.cap!.policy.perCallCap).toBeGreaterThan(10_000n);
  });
});

describe("the partner task", () => {
  it("asks another developer's two routes at a recent block and keeps within a 0.01 budget", () => {
    const t = partnerTask(`${PARTNER_URL}/`, 31801660);
    expect(t.wants.map((x) => x.path)).toEqual(["gas-snapshot", `${PARTNER_URL}/paid/network-snapshot?block=31801660`, `${PARTNER_URL}/paid/activity-summary?block=31801660`]);
    expect(t.wants.reduce((s, x) => s + x.maxWorth, 0n)).toBeLessThanOrEqual(u("0.01"));
  });
});

describe("--compact output", () => {
  it("keeps every line of every committed proof run within 62 characters", () => {
    for (const name of ["finish", "budget", "cap", "retry-before", "retry-after", "partner-seller", "prod-gas-ok"]) {
      const proof = JSON.parse(readFileSync(new URL(`../tasks/x402-agent-buyer/proof/${name}.json`, import.meta.url), "utf8")) as { events: AgentEvent[] };
      const fmt = compactFormatter();
      for (const e of proof.events) {
        const line = fmt(e);
        if (line) expect(line.length, `${name}: ${line}`).toBeLessThanOrEqual(62);
      }
      const rows = readLog(new URL(`../tasks/x402-agent-buyer/proof/${name}.payments.jsonl`, import.meta.url).pathname);
      for (const l of formatLogCompact(rows).split("\n")) expect(l.length, `${name}: ${l}`).toBeLessThanOrEqual(62);
    }
  });
  it("a refusal carries the price asked just before it", () => {
    const fmt = compactFormatter();
    fmt({ type: "ask", want: "x", path: "p", price: "0.015 USDC" });
    expect(fmt({ type: "refused", want: "x", why: "over-cap", text: "…" })).toBe("NO    x         0.015: over the per-call cap");
  });
});
