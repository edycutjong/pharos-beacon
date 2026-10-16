import { describe, expect, it } from "vitest";
import { CLIENT_INFO, RateLimiter, patientFetch, retryAfterMs } from "../src/lib/net.js";

describe("RateLimiter", () => {
  /** A clock that only moves when the limiter sleeps. */
  function clock() {
    let now = 0;
    const waited: number[] = [];
    return { waited, now: () => now, sleep: async (ms: number) => void (waited.push(ms), (now += ms)) };
  }

  it("lets `perMinute` requests through at once, then waits until the oldest leaves the 60 s window", async () => {
    const c = clock();
    const l = new RateLimiter(3, c.sleep, c.now);
    for (let i = 0; i < 3; i++) await l.take();
    expect(c.waited).toEqual([]);
    await l.take();
    expect(c.waited).toEqual([60_000]);
  });

  it("serves concurrent callers in order without letting a burst through", async () => {
    const c = clock();
    const l = new RateLimiter(2, c.sleep, c.now);
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3, 4].map((i) => l.take().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(c.now()).toBe(120_000); // 5 requests at 2 per minute: the 5th goes out two windows after the first
  });

  it("is a no-op when disabled", async () => {
    const c = clock();
    const l = new RateLimiter(0, c.sleep, c.now);
    for (let i = 0; i < 1000; i++) await l.take();
    expect(c.waited).toEqual([]);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates, and ignores junk", () => {
    expect(retryAfterMs("7")).toBe(7_000);
    expect(retryAfterMs("0")).toBe(0);
    expect(retryAfterMs("Thu, 01 Jan 1970 00:00:10 GMT", 4_000)).toBe(6_000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
  });
});

describe("patientFetch", () => {
  function server(...statuses: [number, Record<string, string>?][]) {
    const seen: string[] = [];
    const base = (async (_input: unknown, init?: RequestInit) => {
      seen.push(`${init?.method} ${init?.body ?? ""}`);
      const [status, headers] = statuses.shift() ?? [200];
      return new Response(status === 200 ? "ok" : "no", { status, headers });
    }) as typeof fetch;
    return { base, seen };
  }
  const sleeps = () => {
    const waited: number[] = [];
    return { waited, sleep: async (ms: number) => void waited.push(ms) };
  };

  it("waits out a 429 as long as Retry-After says, then resends the same body", async () => {
    const s = server([429, { "retry-after": "3" }], [200]);
    const { waited, sleep } = sleeps();
    const res = await patientFetch({ sleep }, s.base)("http://x/mcp", { method: "POST", body: '{"id":1}' });
    expect(res.status).toBe(200);
    expect(waited).toEqual([3_000]);
    expect(s.seen).toEqual(['POST {"id":1}', 'POST {"id":1}']);
  });

  it("backs off 1 s, 2 s, 4 s on a 503 without Retry-After, then gives the last reply back", async () => {
    const s = server([503], [503], [503], [503]);
    const { waited, sleep } = sleeps();
    const res = await patientFetch({ sleep }, s.base)("http://x/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect(waited).toEqual([1_000, 2_000, 4_000]);
  });

  it("does not hold up a DELETE, and returns a Retry-After longer than maxWaitMs at once", async () => {
    const { waited, sleep } = sleeps();
    expect((await patientFetch({ sleep }, server([429]).base)("http://x/mcp", { method: "DELETE" })).status).toBe(429);
    expect((await patientFetch({ sleep, maxWaitMs: 5_000 }, server([429, { "retry-after": "60" }]).base)("http://x/mcp", { method: "POST" })).status).toBe(429);
    expect(waited).toEqual([]);
  });

  it("stops waiting when the request is aborted", async () => {
    const ctl = new AbortController();
    const s = server([429, { "retry-after": "30" }], [200]);
    let slept = false;
    const sleep = () => new Promise<void>(() => void (slept = true)); // never wakes up by itself
    const pending = patientFetch({ sleep }, s.base)("http://x/mcp", { method: "POST", signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    await pending; // the fake base ignores the signal; what matters is that the wait ended
    expect(slept).toBe(true);
    expect(s.seen).toHaveLength(2);
  });
});

describe("CLIENT_INFO", () => {
  it("introduces both MCP clients with the package version", async () => {
    const { version } = (await import("../package.json", { with: { type: "json" } })).default;
    expect(CLIENT_INFO).toEqual({ name: "beacon", version });
  });
});
