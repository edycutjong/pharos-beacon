import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { encodeAbiParameters, encodeEventTopics, getAddress, isAddressEqual, parseAbiItem, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { X402_USDC } from "../src/lib/networks.js";
import { PAID_RUN_GAP_MS, rateGate, routeName } from "../tasks/x402-paywalled-api/app.js";
import { STEP_IDS, buyerClient, matchReceipt, runScenario, stepsFor, underpay, type RunEvent, type Scenario } from "../tasks/x402-paywalled-api/buyer.js";
import { BASE_PATH, FREE_ROUTES, NETWORK, PAID_ROUTES, parseBlocks, plainWords, quoteFor, requirementsFor, usdc } from "../tasks/x402-paywalled-api/config.js";
import { largestTransfers, whaleBrief } from "../tasks/x402-paywalled-api/data.js";
import { NONCE_USED, OUT_OF_SCOPE, buildFacilitator, facilitatorRoute, preCheck, type Facilitator } from "../tasks/x402-paywalled-api/facilitator.js";
import { createPaywall, parseServerTiming } from "../tasks/x402-paywalled-api/resource.js";
import { recentPayments, type LogSource } from "../tasks/x402-paywalled-api/runs.js";

const PAY_TO = getAddress("0x8D347c72431ed6E033d5f43E56c0987E97f5D91B");
const FAC = getAddress("0x5b3116cD6B3d0783581D163152A2A14c9CD4DaDF");
const TOKEN = getAddress(X402_USDC.address);
const BUYER_KEY = generatePrivateKey();
const BUYER = privateKeyToAccount(BUYER_KEY).address;
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const transferLog = (from: Hex, to: Hex, value: bigint, address: Hex = TOKEN) => ({
  address,
  topics: encodeEventTopics({ abi: [transferEvent], eventName: "Transfer", args: { from, to } }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});

/**
 * An Atlantic stand-in for the facilitator: signatures are really checked (viem's verifyTypedData, offline), the USDC
 * contract is a map of used EIP-3009 nonces, and a settle "mines" a receipt with the Transfer log.
 */
function world() {
  const used = new Set<string>();
  const settled: { hash: Hex; from: Hex; to: Hex; value: bigint }[] = [];
  const signer: FacilitatorEvmSigner = {
    getAddresses: () => [FAC],
    getCode: async ({ address }) => (isAddressEqual(address, TOKEN) ? "0x6080" : "0x"),
    readContract: async ({ functionName, args }) => {
      if (functionName === "transferWithAuthorization") {
        if (used.has(String(args?.[5]))) throw new Error("FiatTokenV2: authorization is used or canceled");
        return undefined;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    verifyTypedData: (a) => verifyTypedData(a as Parameters<typeof verifyTypedData>[0]),
    writeContract: async ({ args }) => {
      const [from, to, value, , , nonce] = args as [Hex, Hex, bigint, bigint, bigint, Hex];
      if (used.has(nonce)) throw new Error("FiatTokenV2: authorization is used or canceled");
      used.add(nonce);
      const hash = `0x${(settled.length + 1).toString(16).padStart(64, "a")}` as Hex;
      settled.push({ hash, from, to, value });
      return hash;
    },
    sendTransaction: async () => { throw new Error("no deployments here"); },
    waitForTransactionReceipt: async ({ hash }) => {
      const s = settled.find((x) => x.hash === hash)!;
      return { status: "success", logs: [{ ...transferLog(s.from, s.to, s.value), blockNumber: 7n }] as never };
    },
  };
  const f: Facilitator = { facilitator: buildFacilitator(signer, { nonceUsed: async (_t, _f, n) => used.has(n) }, PAY_TO), address: FAC };
  const facFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const op = new URL(req.url).pathname.split("/").pop() as "verify" | "settle" | "supported";
    return facilitatorRoute(f, op, req);
  };
  vi.stubGlobal("fetch", facFetch); // the resource server's HTTPFacilitatorClient uses the global fetch
  const paid = createPaywall({ payTo: PAY_TO, facilitatorUrl: `http://fac.test${BASE_PATH}`, publicBase: "https://api.test" });
  const apiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const name = routeName(new URL(req.url));
    if (name === "health") return Response.json({ status: "ok" });
    if (name === "gas-snapshot" || name === "whale-brief" || name === "whale-range") return paid(name, req, async () => ({ route: name, block: 1 }));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const getReceipt = async (hash: Hex) => {
    const s = settled.find((x) => x.hash === hash)!;
    return { status: "success", blockNumber: 7n, logs: [transferLog(s.from, s.to, s.value)] } as never;
  };
  return { used, settled, f, paid, apiFetch, getReceipt };
}

async function run(scenario: Scenario, w = world()) {
  const events: RunEvent[] = [];
  const done = await runScenario({ base: "https://api.test", scenario, key: BUYER_KEY, emit: (e) => events.push(e), fetch: w.apiFetch, getReceipt: w.getReceipt });
  return { events, done, w };
}

afterEach(() => vi.unstubAllGlobals());

describe("price table", () => {
  it("has two paid routes at different prices and one free route", () => {
    expect(PAID_ROUTES["gas-snapshot"].amount).toBe(1_000n);
    expect(PAID_ROUTES["whale-brief"].amount).toBe(10_000n);
    expect(new Set(Object.values(PAID_ROUTES).map((r) => r.amount)).size).toBe(3); // gas-snapshot, whale-brief and the quoted whale-range minimum
    expect(FREE_ROUTES).toEqual(["health"]);
    expect(usdc(1_000n)).toBe("0.001 USDC");
    expect(usdc("10000")).toBe("0.01 USDC");
  });
  it("is priced on Atlantic in the EIP-3009 registry USDC, not the 0xE0BE… token", () => {
    expect(NETWORK).toBe("eip155:688689");
    expect(TOKEN).toBe("0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B");
  });
});

describe("the 402", () => {
  it("carries exactly the requirements the facilitator will check, and says them in plain words", async () => {
    const w = world();
    const res = await w.apiFetch(`https://api.test${BASE_PATH}/whale-brief`);
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    expect(pr.accepts).toEqual([requirementsFor("whale-brief", PAY_TO)]);
    expect(pr.resource.url).toBe(`https://api.test${BASE_PATH}/whale-brief`);
    const body = (await res.json()) as { message: string; price: string; payTo: string };
    expect(body.price).toBe("0.01 USDC");
    expect(body.payTo).toBe(PAY_TO);
    expect(body.message).toBe(plainWords("whale-brief", PAY_TO));
    expect(body.message).toContain("0.01 USDC");
    expect(body.message).toContain(PAY_TO);
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("the quoted route (beyond the requirements)", () => {
  const ask = async (blocks: string) => {
    const w = world();
    const res = await w.apiFetch(`https://api.test${BASE_PATH}/whale-range?blocks=${blocks}`);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    return { res, pr, body: (await res.json()) as { price: string; amount: string; message: string; quote: { windows: number; why: string } } };
  };
  it("prices by the blocks asked for, 0.005 USDC per started 1,000, and the 402 says why", async () => {
    for (const [blocks, windows, amount] of [["1", 1, "5000"], ["1000", 1, "5000"], ["1001", 2, "10000"], ["2500", 3, "15000"], ["3000", 3, "15000"]] as const) {
      const { res, pr, body } = await ask(blocks);
      expect(res.status).toBe(402);
      expect(pr.accepts[0]!.amount).toBe(amount);
      expect(body.amount).toBe(amount);
      expect(body.quote.windows).toBe(windows);
      expect(body.message).toContain(`${windows} window`);
      expect(body.message).toContain(body.price);
    }
    expect((await ask("2500")).body.quote.why).toBe("2,500 blocks need 3 windows of 1,000 blocks at 0.005 USDC each");
  });
  it("quotes the price for free, and refuses a bad ?blocks= before any 402", () => {
    expect(quoteFor(2500)).toEqual({ blocks: 2500, windows: 3, amount: 15_000n });
    expect(parseBlocks(null)).toEqual({ blocks: 2500 });
    for (const bad of ["0", "3001", "-5", "1.5", "abc", "1e3"]) expect(parseBlocks(bad)).toHaveProperty("error");
  });
  it("is paid in full: a buyer pays the quoted amount and the receipt matches it", async () => {
    const { done, w } = await run("quote");
    expect(done.outcome).toBe("paid");
    expect(w.settled[0]!.value).toBe(15_000n);
  });
  it("refuses an underpayment of the quoted amount", async () => {
    const w = world();
    const res = await w.apiFetch(`https://api.test${BASE_PATH}/whale-range?blocks=2500`);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    const { client } = buyerClient(BUYER_KEY);
    const sig = encodePaymentSignatureHeader(await underpay(client, pr));
    const again = await w.apiFetch(`https://api.test${BASE_PATH}/whale-range?blocks=2500`, { headers: { "PAYMENT-SIGNATURE": sig } });
    expect(again.status).toBe(402);
    expect(w.settled).toHaveLength(0);
  });
});

describe("whale-range windows", () => {
  it("asks get_logs once per 1,000-block window and never past the range", async () => {
    const calls: { fromBlock: string; toBlock: string }[] = [];
    const mcp = {
      endpoint: "fake",
      close: async () => undefined,
      call: async (tool: string, args?: { fromBlock: string; toBlock: string }) => {
        if (tool === "get_block_number") return { blockNumber: "10000" };
        calls.push(args!);
        return [];
      },
    };
    const out = await whaleBrief(async () => mcp as never, 2500);
    expect(calls).toEqual([
      { address: expect.any(String), topics: expect.any(Array), fromBlock: "9001", toBlock: "10000" },
      { address: expect.any(String), topics: expect.any(Array), fromBlock: "8001", toBlock: "9000" },
      { address: expect.any(String), topics: expect.any(Array), fromBlock: "7501", toBlock: "8000" },
    ]);
    expect(out.blocks).toBe("7501–10000");
  });
});

describe("paying", () => {
  it("402 → sign → verify → settle → 200 with PAYMENT-RESPONSE, receipt checked; NDJSON events have one shape", async () => {
    const { events, done, w } = await run("a");
    expect(done.outcome).toBe("paid");
    expect(w.settled).toHaveLength(1);
    expect(w.settled[0]).toMatchObject({ from: BUYER, to: PAY_TO, value: 1_000n });
    expect(done.tx).toBe(w.settled[0]!.hash);
    expect(done.receipt?.ok).toBe(true);
    expect(done.data).toEqual({ route: "gas-snapshot", block: 1 });
    expect(events[0]).toMatchObject({ type: "start", scenario: "a", price: "0.001 USDC", payer: BUYER, steps: stepsFor("a") });
    const steps = events.filter((e) => e.type === "step");
    expect(steps.map((s) => s.id)).toEqual(["req", "q", "sign", "verify", "settle", "ok"]);
    for (const s of steps) {
      expect(Object.keys(s).sort()).toEqual(expect.arrayContaining(["id", "label", "ms", "state", "type"]));
      expect(Number.isInteger(s.ms) && s.ms >= 0).toBe(true);
      expect(["ok", "refused", "failed", "skip"]).toContain(s.state);
    }
    expect(steps.map((s) => s.state)).toEqual(["ok", "refused", "ok", "ok", "ok", "ok"]);
    expect(events.at(-1)?.type).toBe("done");
    for (const e of events) expect(JSON.parse(JSON.stringify(e))).toEqual(e); // each is one NDJSON line, losslessly
    expect(done.raw.some((r) => r.headers?.["PAYMENT-RESPONSE"]?.includes(done.tx!))).toBe(true);
  });

  it("pays the dearer route its own price", async () => {
    const { done, w } = await run("b");
    expect(done.outcome).toBe("paid");
    expect(w.settled[0]!.value).toBe(10_000n);
  });

  it("refuses an underpaid payment with another 402 and settles nothing (requirement 05)", async () => {
    const { events, done, w } = await run("under");
    expect(done.outcome).toBe("refused");
    expect(done.refusal).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
    expect(w.settled).toHaveLength(0);
    const byId = Object.fromEntries(events.filter((e) => e.type === "step").map((e) => [e.id, e]));
    expect(byId.sign).toMatchObject({ state: "ok", detail: { value: "500" } });
    expect(byId.verify).toMatchObject({ state: "failed" });
    expect(byId.settle).toMatchObject({ state: "skip" });
    expect(byId.ok).toMatchObject({ state: "refused", label: "402 again" });
  });

  it("refuses a replayed PAYMENT-SIGNATURE with 402: the nonce is already used, one settle only", async () => {
    const { events, done, w } = await run("replay");
    expect(done.outcome).toBe("paid");
    expect(w.settled).toHaveLength(1);
    const replay = events.find((e) => e.type === "step" && e.id === "replay");
    expect(replay).toMatchObject({ state: "refused", detail: { reason: NONCE_USED } });
    expect(stepsFor("replay")).toEqual([...STEP_IDS]);
  });

  it("answers the free route with no payment step", async () => {
    const { events, done, w } = await run("free");
    expect(done.outcome).toBe("free");
    expect(w.settled).toHaveLength(0);
    expect(events.filter((e) => e.type === "step" && e.state === "skip").map((e) => (e as { id: string }).id)).toEqual(["q", "sign", "verify", "settle"]);
  });
});

describe("our facilitator", () => {
  it("verify says invalid for an underpayment, before anything is sent", async () => {
    const w = world();
    const res = await w.apiFetch(`https://api.test${BASE_PATH}/gas-snapshot`);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    const payload = await underpay(buyerClient(BUYER_KEY).client, pr);
    expect(payload.accepted).toEqual(pr.accepts[0]);
    const v = await w.f.facilitator.verify(payload, pr.accepts[0]!);
    expect(v).toMatchObject({ isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_value_mismatch" });
  });

  it("refuses a used nonce and anything that is not our payee, token and network", async () => {
    const w = world();
    const res = await w.apiFetch(`https://api.test${BASE_PATH}/gas-snapshot`);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    const payload = await buyerClient(BUYER_KEY).client.createPaymentPayload(pr);
    const req = pr.accepts[0]!;
    const nonce = (payload.payload as { authorization: { nonce: Hex } }).authorization.nonce;
    expect(await preCheck(payload, req, PAY_TO, { nonceUsed: async () => false })).toBeUndefined();
    expect(await preCheck(payload, req, PAY_TO, { nonceUsed: async (_t, _f, n) => n === nonce })).toBe(NONCE_USED);
    expect(await preCheck(payload, { ...req, payTo: FAC }, PAY_TO, { nonceUsed: async () => false })).toBe(OUT_OF_SCOPE);
    expect(await preCheck(payload, { ...req, network: "eip155:1" }, PAY_TO, { nonceUsed: async () => false })).toBe(OUT_OF_SCOPE);
    // settle, then the same payload again: refused at verify and at settle, nothing moves twice
    expect((await w.f.facilitator.settle(payload, req)).success).toBe(true);
    expect(await w.f.facilitator.verify(payload, req)).toMatchObject({ isValid: false, invalidReason: NONCE_USED });
    const again = await facilitatorRoute(w.f, "settle", new Request("http://fac.test/settle", { method: "POST", body: JSON.stringify({ paymentPayload: payload, paymentRequirements: req }) }));
    expect(await again.json()).toMatchObject({ success: false, errorReason: NONCE_USED });
    expect(w.settled).toHaveLength(1);
  });

  it("lists exact on Atlantic with its signer under /supported", async () => {
    const res = await facilitatorRoute(world().f, "supported", new Request("http://fac.test/supported"));
    expect(await res.json()).toMatchObject({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], signers: { "eip155:*": [FAC] } });
  });
});

describe("receipt check", () => {
  const expectPay = { token: TOKEN, from: BUYER, to: PAY_TO, value: 1_000n };
  it("accepts status 1 with the matching USDC Transfer", () => {
    expect(matchReceipt({ status: "success", blockNumber: 9n, logs: [transferLog(BUYER, PAY_TO, 1_000n)] }, expectPay)).toMatchObject({ ok: true, block: 9 });
  });
  it("rejects a revert, a wrong amount, a wrong payee and the wrong token", () => {
    expect(matchReceipt({ status: "reverted", blockNumber: 9n, logs: [transferLog(BUYER, PAY_TO, 1_000n)] }, expectPay).ok).toBe(false);
    expect(matchReceipt({ status: "success", blockNumber: 9n, logs: [transferLog(BUYER, PAY_TO, 999n)] }, expectPay).ok).toBe(false);
    expect(matchReceipt({ status: "success", blockNumber: 9n, logs: [transferLog(BUYER, FAC, 1_000n)] }, expectPay).ok).toBe(false);
    expect(matchReceipt({ status: "success", blockNumber: 9n, logs: [transferLog(BUYER, PAY_TO, 1_000n, FAC)] }, expectPay).ok).toBe(false);
    expect(matchReceipt({ status: "success", blockNumber: 9n, logs: [] }, expectPay).ok).toBe(false);
  });
});

describe("plumbing", () => {
  it("parses Server-Timing", () => {
    expect(parseServerTiming('verify;dur=132;desc="facilitator /verify", data;dur=4, settle;dur=1840.5')).toEqual({ verify: 132, data: 4, settle: 1840.5 });
    expect(parseServerTiming(null)).toEqual({});
  });
  it("routes by the rewrite's ?path= or by the path", () => {
    expect(routeName(new URL("https://x/api/x402-paywalled-api?path=gas-snapshot"))).toBe("gas-snapshot");
    expect(routeName(new URL("https://x/api/x402-paywalled-api/demo-run?scenario=a"))).toBe("demo-run");
  });
  it("lets one paid demo run through per gap, and none while one is running", () => {
    const g = rateGate();
    expect(g.take(0)).toBe(0);
    expect(g.take(1)).toBeGreaterThan(0); // still running
    g.release();
    expect(g.take(PAID_RUN_GAP_MS - 1)).toBe(1);
    expect(g.take(PAID_RUN_GAP_MS)).toBe(0);
  });
  it("ranks the whale brief by size", () => {
    const log = (value: bigint, block: number) => ({ ...transferLog(BUYER, PAY_TO, value), blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${"1".repeat(64)}` }) as never;
    const top = largestTransfers([log(5n * 10n ** 6n, 1), log(9n * 10n ** 6n, 2), log(1n, 3)], 6, 2);
    expect(top.map((m) => m.usdc)).toEqual(["9", "5"]);
  });
  it("reads the run log from the chain, newest first, route by price", async () => {
    const calls: [bigint, bigint][] = [];
    const src: LogSource = {
      blockNumber: async () => 5_500n,
      logs: async (f, t) => {
        calls.push([f, t]);
        const mk = (value: bigint, block: number) => ({ ...transferLog(BUYER, PAY_TO, value), blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${String(block).padStart(64, "0")}` }) as never;
        return f <= 5_000n && t >= 5_000n ? [mk(1_000n, 5_000)] : f <= 3_000n && t >= 3_000n ? [mk(10_000n, 3_000)] : [];
      },
      blockTime: async (b) => 1_800_000_000 + Number(b),
    };
    const r = await recentPayments(src, PAY_TO, { limit: 2 });
    expect(r.payments.map((p) => [p.block, p.route, p.usdc])).toEqual([[5_000, "gas-snapshot", "0.001"], [3_000, "whale-brief", "0.01"]]);
    expect(calls[0]).toEqual([4_501n, 5_500n]);
    expect(calls).toHaveLength(3); // stopped once it had two
    expect(r.payments[0]!.explorer).toMatch(/^https:\/\/atlantic\.pharosscan\.xyz\/tx\/0x/);
  });
});
