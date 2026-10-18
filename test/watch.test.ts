import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { amountText, decodeLog, parseEvent } from "../src/watch/decode.js";
import { eventKey, pollOnce, watch } from "../src/watch/watch.js";
import { ALICE, BOB, depositLog, fakeChain, TOKEN, transferLog } from "./helpers/fake-logs.js";

const dir = () => mkdtempSync(join(tmpdir(), "watch-test-"));
const noSleep = async () => {};

describe("decode", () => {
  it("reads a Transfer into from / to / amount / tx / block", () => {
    const e = decodeLog(parseEvent("Transfer"), transferLog(120, 3, 7, 10_000_000_000_000_000n));
    expect(e).toMatchObject({ event: "Transfer", block: 120n, logIndex: 3, from: ALICE, to: BOB, amountRaw: 10_000_000_000_000_000n });
    expect(e.tx).toMatch(/^0x0+7$/);
    expect(amountText(e, 18, "WPHRS")).toBe("0.01 WPHRS");
    expect(amountText(e, undefined)).toBe("10000000000000000 (raw)");
  });
  it("reads WETH9-style names (dst / wad) as to / amount", () => {
    const e = decodeLog(parseEvent("Deposit"), depositLog(5, 0, 1, 5n * 10n ** 15n));
    expect(e).toMatchObject({ event: "Deposit", to: ALICE, amountRaw: 5n * 10n ** 15n });
    expect(e.from).toBeUndefined();
  });
  it("takes a full signature and refuses an unreadable or unnamed one", () => {
    expect(parseEvent("event Transfer(address indexed from, address indexed to, uint256 value)").topic0).toBe(parseEvent("Transfer").topic0);
    expect(() => parseEvent("Nope(")).toThrow(/cannot read the event/);
    expect(() => parseEvent("Transfer(address,address,uint256)")).toThrow(/name every parameter/);
  });
});

describe("watch", () => {
  const spec = parseEvent("Transfer");
  const base = (chain: { head: number; logs: any[] }, stateFile: string, got: string[]) => ({
    call: fakeChain(chain), address: TOKEN, topics: [spec.topic0] as any, stateFile, sleep: noSleep,
    onLog: (l: any) => void got.push(eventKey(l)),
  });

  it("starts at the head: history is not reported, only new events", async () => {
    const chain = { head: 100, logs: [transferLog(90, 0, 1, 1n)] };
    const got: string[] = [];
    const o = base(chain, join(dir(), "s.json"), got);
    await pollOnce(o);
    expect(got).toEqual([]);
    chain.head = 103;
    chain.logs.push(transferLog(102, 0, 2, 1n));
    await pollOnce(o);
    expect(got).toHaveLength(1);
  });
  it("never reports a log twice: overlapping polls, and a restart from the state file", async () => {
    const chain = { head: 10, logs: [transferLog(8, 0, 1, 1n), transferLog(8, 1, 2, 1n), transferLog(9, 0, 3, 1n)] };
    const file = join(dir(), "s.json");
    const got: string[] = [];
    const run = (maxPolls: number) => watch({ ...base(chain, file, got), from: 5n, maxPolls });
    expect((await run(3)).handled).toBe(3); // three polls over the same chain, three events once
    expect(got).toHaveLength(3);
    expect((await run(2)).handled).toBe(0); // a restart resumes at the cursor and prints nothing
    chain.head = 12;
    chain.logs.push(transferLog(11, 0, 4, 1n));
    expect((await run(1)).handled).toBe(1);
    expect(got).toHaveLength(4);
    expect(new Set(got).size).toBe(4);
  });
  it("tells two events of one block apart (txHash:logIndex), even from the same transaction", async () => {
    const chain = { head: 6, logs: [transferLog(5, 0, 1, 1n), transferLog(5, 1, 1, 2n)] };
    const got: string[] = [];
    await watch({ ...base(chain, join(dir(), "s.json"), got), from: 5n, maxPolls: 1 });
    expect(got).toHaveLength(2);
  });
  it("a crash after a log was handled but before the cursor moved does not repeat it", async () => {
    const chain = { head: 20, logs: [transferLog(15, 0, 1, 1n), transferLog(16, 0, 2, 1n)] };
    const file = join(dir(), "s.json");
    const got: string[] = [];
    const boom = new Error("killed");
    await expect(pollOnce({ ...base(chain, file, got), from: 10n, onLog: (l: any) => { if (got.length === 1) throw boom; got.push(eventKey(l)); } })).rejects.toBe(boom);
    expect(got).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).next).toBe("10"); // cursor did not move
    await pollOnce({ ...base(chain, file, got), from: 10n });
    expect(got).toHaveLength(2); // only the second event was handled on the retry
  });
  it("refuses a state file of the wrong shape", async () => {
    const file = join(dir(), "s.json");
    writeFileSync(file, JSON.stringify({ next: "x" }));
    await expect(pollOnce(base({ head: 1, logs: [] }, file, []))).rejects.toThrow(/wrong shape/);
  });
  it("stops on untilEvents, maxPolls and abort", async () => {
    const chain = { head: 10, logs: [transferLog(8, 0, 1, 1n), transferLog(9, 0, 2, 1n)] };
    expect((await watch({ ...base(chain, join(dir(), "a.json"), []), from: 1n, untilEvents: 1 })).polls).toBe(1);
    const ac = new AbortController();
    ac.abort();
    expect((await watch({ ...base(chain, join(dir(), "b.json"), []), signal: ac.signal })).polls).toBe(0);
    expect((await watch({ ...base(chain, join(dir(), "c.json"), []), maxPolls: 4 })).polls).toBe(4);
  });
});
