import { afterEach, describe, expect, it, vi } from "vitest";
import { InputError, busy, deployInfo, gate, json, ms, ndjson, toJson } from "../src/lib/demo-stream.js";

const lines = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

describe("demo-stream json", () => {
  it("serialises bigints as decimal strings", () => {
    expect(toJson({ a: 10n ** 20n, b: [1n] })).toBe('{"a":"100000000000000000000","b":["1"]}');
  });

  it("replies with status, no-store and merged headers", async () => {
    const res = json(201, { ok: 1n }, { "x-extra": "y" });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-extra")).toBe("y");
    expect(await res.json()).toEqual({ ok: "1" });
  });

  it("busy() says how long to wait, rounded up to whole seconds", async () => {
    const res = busy(2_100);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3");
    expect((await res.json()).error).toMatch(/Try again in 3 s/);
  });

  it("InputError is a named error", () => {
    const e = new InputError("bad");
    expect(e.name).toBe("InputError");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("ndjson", () => {
  it("streams one JSON line per emit and releases the slot at the end", async () => {
    const release = vi.fn();
    const res = ndjson(async (emit) => {
      emit({ type: "a", n: 1n });
      emit({ type: "b" });
    }, release);
    expect(res.headers.get("content-type")).toMatch(/x-ndjson/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await lines(res)).toEqual([{ type: "a", n: "1" }, { type: "b" }]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("turns a thrown error into an error line cut to its first line and 400 chars", async () => {
    const res = ndjson(async (emit) => {
      emit({ type: "start" });
      throw new Error("x".repeat(500) + "\nsecond line");
    });
    const out = await lines(res);
    expect(out[0]).toEqual({ type: "start" });
    expect(out[1].type).toBe("error");
    expect(out[1].message).toHaveLength(400);
    expect(out[1].message).not.toContain("second");
  });

  it("stringifies a non-Error throw", async () => {
    const out = await lines(ndjson(async () => { throw "plain"; })); // eslint-disable-line no-throw-literal
    expect(out).toEqual([{ type: "error", message: "plain" }]);
  });

  it("aborts the work and still releases when the reader goes away", async () => {
    const release = vi.fn();
    let aborted = false;
    let late: (() => void) | undefined;
    const res = ndjson(
      (emit, signal) =>
        new Promise<void>((done) => {
          emit({ type: "first" });
          signal.addEventListener("abort", () => (aborted = true));
          late = () => {
            emit({ type: "ignored" }); // after cancel: dropped silently
            done();
          };
        }),
      release,
    );
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    expect(aborted).toBe(true);
    late!();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });
});

describe("gate", () => {
  it("allows one run at a time", () => {
    const g = gate(3_000);
    expect(g.take(10_000)).toBe(0);
    expect(g.take(10_001)).toBe(3_000); // busy: the full gap
    g.release();
  });

  it("enforces the gap between starts, then lets the next one in", () => {
    const g = gate(3_000);
    expect(g.take(10_000)).toBe(0);
    g.release();
    expect(g.take(11_000)).toBe(2_000);
    expect(g.take(13_000)).toBe(0);
  });
});

describe("deployInfo / ms", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads the Vercel commit (7 chars) and env", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abcdef1234567890");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(deployInfo()).toEqual({ commit: "abcdef1", env: "production" });
  });

  it("falls back to null / local", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_ENV;
    expect(deployInfo()).toEqual({ commit: null, env: "local" });
  });

  it("ms measures elapsed time", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    expect(ms(4_200)).toBe(800);
    vi.restoreAllMocks();
  });
});
