import { describe, expect, it, vi } from "vitest";
import { InputError } from "../src/web/live.js";
import type { Deps } from "../src/web/mainnet-live.js";

const WALLET = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975";
const h = vi.hoisted(() => ({
  snapAt: [] as bigint[],
  yielded: [] as { from: bigint }[],
  answer: undefined as undefined | ((q: string, reads: any, days: number) => Promise<any>),
}));

// The reads and the answer engine have their own tests; here the glue is under test: the header, the window maths, the view.
vi.mock("../src/portfolio/read.js", async (orig) => {
  const real = await orig<typeof import("../src/portfolio/read.js")>();
  return {
    ...real,
    readSnapshot: vi.fn(async (_call: unknown, _w: string, book: InstanceType<typeof real.FactBook>, block: bigint) => {
      h.snapAt.push(block);
      book.add("USDC balance", 1_500_000n, 6, "USDC", { contract: "0x3333333333333333333333333333333333333333", call: "balanceOf(wallet)", block });
      return { block, timestamp: 1_000n, unreadable: block === 1000n ? [{ protocol: "Harbor", what: "positions", reason: "no reader" }] : [] };
    }),
    vaultYield: vi.fn(async (_c: unknown, _p: unknown, from: bigint) => (h.yielded.push({ from }), { apy: 0.05 })),
  };
});
vi.mock("../src/portfolio/ask.js", async (orig) => ({
  ...(await orig<typeof import("../src/portfolio/ask.js")>()),
  answerQuestion: vi.fn((q: string, reads: unknown, days: number) => h.answer!(q, reads, days)),
}));

import { handle, parseRun, run } from "../tasks/portfolio-assistant/web.js";

const q = (s: string) => new URL(`http://x/api?${s}`);
const conn = () => {
  const closed = { n: 0 };
  const deps: Deps = {
    connect: async () => ({
      endpoint: "fake-mcp",
      close: async () => void closed.n++,
      call: (async (tool: string, args: any) => {
        if (tool === "get_block_number") return { blockNumber: "1000" };
        if (tool === "get_block") return { timestamp: String(100_000 + Number(args.block) * 2) }; // 2 s blocks
        throw new Error(`unexpected ${tool}`);
      }) as never,
    }),
  };
  return { deps, closed };
};
const ANSWER = { question: "what do I have?", lang: "en", intent: { type: "total" }, text: "You hold 1.50 USDC [F1].", cites: ["F1"] };

describe("portfolio web: parameters", () => {
  it("checksums the wallet and keeps the question, the pinned block and the window", () => {
    expect(parseRun(q(`wallet=${WALLET.toLowerCase()}&q=what am I earning?&block=123&windowDays=3`))).toEqual({ wallet: WALLET, q: "what am I earning?", block: 123n, windowDays: 3 });
    expect(parseRun(q(`wallet=${WALLET}&q=hi`))).toEqual({ wallet: WALLET, q: "hi", windowDays: 7 });
  });
  it("refuses a bad wallet, an empty or long question and a bad block", () => {
    expect(() => parseRun(q("wallet=0x12&q=hi"))).toThrow("wallet must be a 0x address (40 hex digits)");
    expect(() => parseRun(q(`wallet=${WALLET}&q=%20`))).toThrow("q is the question to ask");
    expect(() => parseRun(q(`wallet=${WALLET}&q=${"x".repeat(201)}`))).toThrow("q must be 200 characters or fewer");
    expect(() => parseRun(q(`wallet=${WALLET}&q=hi&block=latest`))).toThrow("block must be a block number (digits only)");
    expect(() => parseRun(q(`wallet=${WALLET}&q=hi&windowDays=99`))).toThrow(InputError);
  });
});

describe("portfolio web: run", () => {
  it("answers with cited facts, a source table and what could not be read", async () => {
    h.snapAt = [];
    h.answer = async () => ANSWER;
    const { deps, closed } = conn();
    const out: any[] = [];
    await run({ wallet: WALLET as never, q: "what do I have?", windowDays: 7 }, (e) => out.push(e), deps);
    expect(h.snapAt).toEqual([1000n]);
    const done = out.at(-1);
    expect(done.type).toBe("done");
    const v = done.view;
    expect(v.tone).toBe("ok");
    expect(v.verdict).toBe("Answered (English), 1 cited fact");
    expect(v.text).toContain("Q: what do I have?");
    expect(v.text).toContain("A: You hold 1.50 USDC [F1].");
    expect(v.text).toContain("F1 | USDC balance | 0x3333333333333333333333333333333333333333 | balanceOf(wallet) | block 1000");
    expect(v.text).toContain("Harbor: positions (no reader)");
    expect(v.evidence[1][1]).toBe("1000 (the head, read first)");
    expect(v.evidence[3][1]).toBe("total");
    expect(v.summary).toBe("1 cited facts at block 1000.");
    expect(out.find((e) => e.id === "answer" && e.state !== "running")).toMatchObject({ state: "ok", label: "1 cited fact" });
    expect(closed.n).toBe(1);
  });

  it("says Bahasa Indonesia and pins the block when asked", async () => {
    h.answer = async () => ({ ...ANSWER, lang: "id", cites: ["F1", "F1"] });
    const out: any[] = [];
    await run({ wallet: WALLET as never, q: "saldo saya", block: 900n, windowDays: 7 }, (e) => out.push(e), conn().deps);
    const v = out.at(-1).view;
    expect(v.verdict).toBe("Answered (Bahasa Indonesia), 2 cited facts");
    expect(v.evidence[1][1]).toBe("900 (pinned)");
  });

  it("a refusal is a warning and is not dressed up as an answer", async () => {
    h.answer = async () => ({ question: "will it rise?", lang: "en", intent: { type: "unsupported", reason: "advice", name: "" }, text: "I do not forecast prices.", cites: [], refused: "advice" });
    const out: any[] = [];
    await run({ wallet: WALLET as never, q: "will it rise?", windowDays: 7 }, (e) => out.push(e), conn().deps);
    const v = out.at(-1).view;
    expect(v.tone).toBe("warn");
    expect(v.verdict).toBe("It would not guess");
    expect(v.summary).toBe("Declined: advice");
    expect(v.text).not.toContain("sources:");
    expect(out.find((e) => e.id === "answer" && e.state !== "running")).toMatchObject({ state: "refused", label: "declined" });
  });

  it("reads an earlier snapshot a number of days back, or at a block, and refuses a block that is not earlier", async () => {
    h.snapAt = [];
    h.yielded = [];
    let earlierDays: bigint[] = [];
    h.answer = async (_q, reads) => {
      earlierDays = [(await reads.earlier(undefined, 1))[0].block, (await reads.earlier(950n))[0].block, (await reads.earlier(undefined, undefined))[0].block];
      await expect(reads.earlier(1000n)).rejects.toThrow("the earlier block 1000 must be before the block read (1000)");
      expect(await reads.yieldOf({ kind: "vault" }, { timestamp: 1_000n }, 2)).toEqual({ apy: 0.05 });
      return ANSWER;
    };
    const out: any[] = [];
    await run({ wallet: WALLET as never, q: "what changed?", windowDays: 7 }, (e) => out.push(e), conn().deps);
    // 2 s blocks: one day is 43,200 blocks, so the window reaches before block 0 (a negative block is what the maths gives)
    expect(earlierDays).toEqual([1000n - 43_200n, 950n, 1000n - 302_400n]);
    expect(h.yielded).toEqual([{ from: 1000n - 86_400n }]);
  });

  it("closes the connection and rethrows when the answer fails", async () => {
    h.answer = async () => { throw new Error("cannot read the vault"); };
    const { deps, closed } = conn();
    const out: any[] = [];
    await expect(run({ wallet: WALLET as never, q: "x", windowDays: 7 }, (e) => out.push(e), deps)).rejects.toThrow("cannot read the vault");
    expect(out.some((e) => e.type === "step" && e.state === "failed")).toBe(true);
    expect(closed.n).toBe(1);
  });

  it("serves info and an NDJSON run through handle()", async () => {
    h.answer = async () => ANSWER;
    expect((await (await handle(new Request("http://x/api?action=info"))).json()).task).toBe("portfolio-assistant");
    const text = await (await handle(new Request(`http://x/api?action=run&wallet=${WALLET}&q=hi`), conn().deps)).text();
    expect(JSON.parse(text.trim().split("\n").at(-1)!).type).toBe("done");
    expect((await handle(new Request("http://x/api?action=run&wallet=nope&q=hi"), conn().deps)).status).toBe(400);
  });
});
