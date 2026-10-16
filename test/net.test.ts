import { describe, expect, it } from "vitest";
import { CLIENT_INFO, RateLimiter, limiterFor, rejectUserinfo, retryAfterMs, throttleAwareFetch, wait, withRetry } from "../src/lib/net.js";

/** A clock that only moves when the limiter sleeps. */
function clock() {
  let now = 0;
  const waited: number[] = [];
  return { waited, now: () => now, sleep: async (ms: number) => void (waited.push(ms), (now += ms)) };
}

describe("RateLimiter", () => {
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

  it("takes several slots at once, waiting only as long as needed to free them", async () => {
    const c = clock();
    const l = new RateLimiter(5, c.sleep, c.now);
    await l.take(4);
    c.sleep(10_000);
    await l.take(1);
    await l.take(2); // 5 used: 2 more need the first 2 stamps (both at t=0) to leave the window
    expect(c.waited).toEqual([10_000, 50_000]);
    expect(c.now()).toBe(60_000);
  });

  it("counts noted requests without waiting, and holds everyone during a pause", async () => {
    const c = clock();
    const l = new RateLimiter(2, c.sleep, c.now);
    l.note(2);
    await l.take();
    expect(c.waited).toEqual([60_000]);
    l.pauseFor(7_000);
    await l.take();
    expect(c.waited).toEqual([60_000, 7_000]);
  });

  it("is a no-op when disabled, except for a pause the server asked for", async () => {
    const c = clock();
    const l = new RateLimiter(0, c.sleep, c.now);
    for (let i = 0; i < 1000; i++) await l.take();
    expect(c.waited).toEqual([]);
    l.pauseFor(3_000);
    await l.take();
    expect(c.waited).toEqual([3_000]);
  });

  it("can only be tightened, and stops a wait when aborted", async () => {
    const l = new RateLimiter(10);
    l.tighten(20);
    expect(l.perMinute).toBe(10);
    l.tighten(5);
    expect(l.perMinute).toBe(5);
    const unlimited = new RateLimiter(0);
    unlimited.tighten(7);
    expect(unlimited.perMinute).toBe(7);

    const ctl = new AbortController();
    l.pauseFor(60_000);
    const t0 = Date.now();
    const pending = l.take(1, ctl.signal).catch((e: Error) => e.name);
    setTimeout(() => ctl.abort(), 20);
    expect(await pending).toBe("AbortError");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("limiterFor", () => {
  it("returns one limiter per key, and the stricter budget wins", () => {
    const a = limiterFor("test-key-1", 100);
    const b = limiterFor("test-key-1", 40);
    expect(b).toBe(a);
    expect(a.perMinute).toBe(40);
    expect(limiterFor("test-key-1", 100).perMinute).toBe(40);
    expect(limiterFor("test-key-2", 100)).not.toBe(a);
  });
});

describe("wait", () => {
  it("rejects at once when aborted and leaves no timer running", async () => {
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = wait(30_000, ctl.signal).catch((e: Error) => e.name);
    ctl.abort();
    expect(await p).toBe("AbortError");
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("withRetry", () => {
  it("uses the wait a failure asks for, else the backoff", async () => {
    const waited: number[] = [];
    let n = 0;
    const result = await withRetry(
      async () => {
        if (++n < 3) throw Object.assign(new Error("fetch failed"), { asked: n === 1 ? 7_000 : undefined });
        return "ok";
      },
      { sleep: async (ms) => void waited.push(ms), delayMs: (_attempt, e) => (e as { asked?: number }).asked },
    );
    expect(result).toBe("ok");
    expect(waited).toEqual([7_000, 1_500]);
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

describe("throttleAwareFetch", () => {
  const base = (status: number, headers: Record<string, string> = {}) => (async () => new Response("x", { status, headers })) as unknown as typeof fetch;

  it("reports a 429 or 503 with the wait asked for, and returns the response unchanged (nothing resent)", async () => {
    const seen: [number, number | undefined][] = [];
    const report = (s: number, ms: number | undefined) => void seen.push([s, ms]);
    expect((await throttleAwareFetch(report, base(429, { "retry-after": "3" }))("http://x/mcp", { method: "POST" })).status).toBe(429);
    expect((await throttleAwareFetch(report, base(503))("http://x/mcp", { method: "POST" })).status).toBe(503);
    expect((await throttleAwareFetch(report, base(200))("http://x/mcp", { method: "POST" })).status).toBe(200);
    expect(seen).toEqual([[429, 3_000], [503, undefined]]);
  });
});

describe("rejectUserinfo", () => {
  it("refuses user:password@ without echoing it", () => {
    expect(() => rejectUserinfo(new URL("https://u:SECRET@h/mcp"), "the URL")).toThrow(/^the URL must not carry credentials \(user:password@\)$/);
    expect(() => rejectUserinfo(new URL("https://h/mcp?token=x"), "the URL")).not.toThrow();
  });
});

describe("CLIENT_INFO", () => {
  it("introduces both MCP clients with the package version", async () => {
    const { version } = (await import("../package.json", { with: { type: "json" } })).default;
    expect(CLIENT_INFO).toEqual({ name: "beacon", version });
  });
});
