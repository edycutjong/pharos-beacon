import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { X402_USDC } from "../src/lib/networks.js";
import { BASE_PATH, PAID_ROUTES, QUOTE } from "../tasks/x402-paywalled-api/config.js";

const h = vi.hoisted(() => ({ release: undefined as undefined | (() => void), scenario: "", payments: undefined as unknown, fail: undefined as undefined | Error, calls: 0 }));
vi.mock("../tasks/x402-paywalled-api/buyer.js", async (orig) => ({
  ...(await orig<typeof import("../tasks/x402-paywalled-api/buyer.js")>()),
  runScenario: vi.fn(async (o: { scenario: string; emit: (e: any) => void }) => {
    h.scenario = o.scenario;
    o.emit({ type: "start", scenario: o.scenario });
    if (h.fail) throw h.fail;
    if (o.scenario !== "free") await new Promise<void>((r) => (h.release = r));
    o.emit({ type: "done" });
  }),
}));
vi.mock("../tasks/x402-paywalled-api/runs.js", async (orig) => ({
  ...(await orig<typeof import("../tasks/x402-paywalled-api/runs.js")>()),
  rpcLogSource: () => ({}),
  recentPayments: vi.fn(async () => {
    h.calls++;
    if (h.fail) throw h.fail;
    return h.payments;
  }),
}));

import { handle } from "../tasks/x402-paywalled-api/app.js";

const PAYEE = privateKeyToAccount(generatePrivateKey()).address;
const get = (path: string, init?: RequestInit) => handle(new Request(`https://demo.example${BASE_PATH}/${path}`, init));
const lines = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

beforeEach(() => {
  vi.stubEnv("PAY_TO_ADDRESS", PAYEE);
  vi.stubEnv("FACILITATOR_PRIVATE_KEY", generatePrivateKey());
  vi.stubEnv("BUYER_PRIVATE_KEY", generatePrivateKey());
  vi.stubEnv("USDC_ADDRESS", "");
  vi.stubEnv("PUBLIC_BASE_URL", "");
  h.fail = undefined;
});
afterEach(() => vi.unstubAllEnvs());

describe("x402 app: free routes", () => {
  it("answers CORS preflight with the payment headers", async () => {
    const res = await get("quote", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("PAYMENT-SIGNATURE");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST");
  });

  it("health lists the token, payee, facilitator signer, free and paid routes", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://public.example///");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "1234567890");
    const body = await (await get("health")).json();
    expect(body.status).toBe("ok");
    expect(body.asset.address).toBe(X402_USDC.address);
    expect(body.payTo).toBe(PAYEE);
    expect(body.facilitator.url).toBe(`https://public.example${BASE_PATH}`);
    expect(body.facilitator.signer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(body.routes.free).toEqual([`GET ${BASE_PATH}/health`]);
    expect(body.routes.paid.map((r: any) => r.route)).toEqual(Object.keys(PAID_ROUTES).map((n) => `GET ${BASE_PATH}/${n}`));
    expect(body.demo.scenarios).toEqual(expect.arrayContaining(["a", "free"]));
    expect(body.demo.buyer).toMatch(/^0x/);
    expect(body.deploy.commit).toBe("1234567");
  });

  it("quotes the price of whale-range by started windows of 1,000 blocks", async () => {
    const body = await (await get("quote?blocks=2500")).json();
    expect(body).toMatchObject({ blocks: 2500, windows: 3, price: "0.015 USDC", amount: "15000", perWindow: "0.005 USDC" });
    expect(body.route).toBe(`GET ${BASE_PATH}/${QUOTE.route}?blocks=2500`);
    expect(body.rule).toBe("0.005 USDC per started 1000 blocks, 1 to 3 windows");
  });

  it("refuses a bad block count for the free quote", async () => {
    const res = await get("quote?blocks=abc");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(expect.any(String));
  });
});

describe("x402 app: errors and the paywall", () => {
  it("only GET is allowed outside the facilitator routes", async () => {
    const res = await get("health", { method: "POST" });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "use GET" });
  });

  it("an unknown route is a 404 that lists the real ones", async () => {
    const res = await get("nope");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('no route "nope"');
    expect(body.routes).toEqual(expect.arrayContaining(["health", "quote", "gas-snapshot", "whale-range", "verify", "settle", "supported", "demo-run", "runs"]));
  });

  it("a bad ?blocks= on the paid range is refused with 400 before any 402", async () => {
    const res = await get(`${QUOTE.route}?blocks=0`);
    expect(res.status).toBe(400);
  });

  it("the wrong USDC_ADDRESS setting is a 500 configuration error", async () => {
    vi.stubEnv("USDC_ADDRESS", "0x0000000000000000000000000000000000000001");
    const res = await get("health");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/is not the EIP-3009 USDC this API settles in/);
  });
});

describe("x402 app: runs", () => {
  it("turns an RPC failure into a 503 with the RPC's own reason, then caches a success for 15 s", async () => {
    h.fail = new Error("HTTP request failed.\nURL: https://rpc\nDetails: rate limited");
    const bad = await get("runs");
    expect(bad.status).toBe(503);
    expect(bad.headers.get("retry-after")).toBe("10");
    expect((await bad.json()).error).toBe("could not read the payments from Atlantic: rate limited");
    h.fail = new Error("socket closed\nsecond line");
    expect((await (await get("runs")).json()).error).toBe("could not read the payments from Atlantic: socket closed");

    h.fail = undefined;
    h.payments = { payments: [{ tx: "0x1" }], count: 1 };
    h.calls = 0;
    const ok = await (await get("runs")).json();
    expect(ok).toMatchObject({ payments: [{ tx: "0x1" }], count: 1, source: "USDC Transfer logs to the payee sent by the facilitator signer, Atlantic eth_getLogs" });
    expect(ok.readAt).toEqual(expect.any(String));
    await get("runs");
    expect(h.calls).toBe(1); // the second read came from the cache
  });
});

describe("x402 app: demo-run", () => {
  it("rejects an unknown scenario", async () => {
    const res = await get("demo-run?scenario=zzz");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^scenario must be one of /);
  });

  it("streams the scenario as NDJSON, allows one paid run at a time, and frees the slot at the end", async () => {
    const first = await get("demo-run?scenario=a");
    expect(first.headers.get("content-type")).toMatch(/x-ndjson/);
    const reader = first.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"type":"start","scenario":"a"}\n');
    const second = await get("demo-run?scenario=b");
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await second.json()).error).toMatch(/one paid demo run every 10 s/);
    // the free scenario is never gated
    const free = await get("demo-run?scenario=free");
    expect(free.status).toBe(200);
    expect(await lines(free)).toEqual([{ type: "start", scenario: "free" }, { type: "done" }]);
    await vi.waitFor(() => expect(h.release).toBeDefined());
    h.release!();
    h.release = undefined;
    let rest = "";
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      rest += new TextDecoder().decode(r.value);
    }
    expect(rest).toBe('{"type":"done"}\n');
  });

  it("a failing scenario becomes an error line, not a broken stream", async () => {
    h.fail = new Error("buyer has no USDC");
    const res = await get("demo-run?scenario=free");
    expect(await lines(res)).toEqual([{ type: "start", scenario: "free" }, { type: "error", message: "buyer has no USDC" }]);
  });
});
