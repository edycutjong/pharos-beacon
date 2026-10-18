import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main as monitorMain, parseFrom, formatEvent } from "../tasks/event-log-monitor/index.js";
import { decodeLog, parseEvent } from "../src/watch/decode.js";
import { fakeChain, TOKEN, transferLog } from "./helpers/fake-logs.js";

const dir = () => mkdtempSync(join(tmpdir(), "monitor-test-"));
const ctx = () => ({ onExit: () => {}, signal: new AbortController().signal });
const E15 = 10n ** 15n;

describe("event-log-monitor", () => {
  const conn = (call: any) => async () => ({ call, close: async () => {}, endpoint: "fake://mcp", network: "atlantic" as const, chainId: 688689, server: undefined }) as any;
  it("parses --from-block", () => {
    expect(parseFrom("head", 100n)).toBe("head");
    expect(parseFrom("42", 100n)).toBe(42n);
    expect(parseFrom("head-30", 100n)).toBe(70n);
    expect(() => parseFrom("soon", 1n)).toThrow(/--from-block/);
  });
  it("catches a live event once, and a restart prints nothing new", async () => {
    const chain = { head: 100, logs: [] as any[] };
    const state = join(dir(), "s.json");
    const log = join(dir(), "run.log");
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
    const argv = ["--contract", TOKEN, "--event", "Transfer", "--state", state, "--log", log, "--poll-ms", "200", "--max-polls", "3"];
    let n = 0;
    const call = fakeChain(chain);
    const live = (async (tool: string, a: any) => {
      if (tool === "get_block_number" && ++n === 3) {
        chain.head = 103;
        chain.logs.push(transferLog(102, 0, 7, 10n * E15));
      }
      return call(tool, a);
    }) as any;
    await monitorMain(ctx(), argv, conn(live), async () => {});
    const text = out.join("\n");
    expect(text).toContain("amount  0.01 WPHRS");
    expect(text).toContain("block 102");
    expect(text).toMatch(/1 new Transfer event;/);
    out.length = 0;
    await monitorMain(ctx(), argv, conn(call), async () => {});
    expect(out.join("\n")).toMatch(/0 new Transfer events;/);
    expect(out.join("\n")).not.toContain("amount");
    expect(readFileSync(log, "utf8")).toContain("block 102");
    spy.mockRestore();
  });
  it("formats from / to / amount / tx / block", () => {
    const e = decodeLog(parseEvent("Transfer"), transferLog(9, 1, 3, 10n * E15));
    const text = formatEvent(e, "atlantic", 18, "WPHRS");
    for (const w of ["from    ", "to      ", "amount  0.01 WPHRS", "tx      0x", "block 9", "pharosscan.xyz/tx/0x"]) expect(text).toContain(w);
  });
  it("rejects a missing contract and a bad poll interval", async () => {
    await expect(monitorMain(ctx(), ["--event", "Transfer"], conn(fakeChain({ head: 1, logs: [] })))).rejects.toThrow(/--contract/);
    await expect(monitorMain(ctx(), ["--contract", TOKEN, "--poll-ms", "5"], conn(fakeChain({ head: 1, logs: [] })))).rejects.toThrow(/--poll-ms/);
  });
});
