// The dApp Support demo endpoint (tasks/dapp-support-agent/web.ts): hash checks, lamps, and the examples match the proofs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXAMPLES, handle, lampOf, parseDiagnose, run } from "../tasks/dapp-support-agent/web.js";

const H = "0x" + "ab".repeat(32);
describe("dapp-support-agent web", () => {
  it("checks the hash and the network", () => {
    expect(parseDiagnose(new URL(`http://x/?hash=${H}`))).toEqual({ hash: H, network: "atlantic" });
    expect(parseDiagnose(new URL(`http://x/?hash=${H.toUpperCase().replace("0X", "0x")}&network=pharos`)).network).toBe("pharos");
    expect(() => parseDiagnose(new URL("http://x/?hash=0x12"))).toThrow(/64 hex/);
    expect(() => parseDiagnose(new URL(`http://x/?hash=${H}&network=eth`))).toThrow(/network/);
  });

  it("answers 400 / 404 / health", async () => {
    expect((await handle(new Request("http://x/api?action=diagnose&hash=nope"))).status).toBe(400);
    expect((await handle(new Request("http://x/api?action=nope"))).status).toBe(404);
    expect(await (await handle(new Request("http://x/api?action=health"))).json()).toMatchObject({ status: "ok", examples: EXAMPLES });
  });

  it("lists the proof transactions with the causes the CLI recorded", () => {
    for (const x of EXAMPLES) {
      const p = JSON.parse(readFileSync(new URL(`../tasks/dapp-support-agent/proof/${x.id}.json`, import.meta.url), "utf8"));
      expect([x.id, p.diagnosis.hash, p.meta.network, p.diagnosis.cause]).toEqual([x.id, x.hash, x.network, x.recorded]);
    }
  });

  it("puts each tool call on its lamp: the replay is the eth_call carrying the gas limit", () => {
    expect(lampOf({ tool: "get_transaction", args: {} })).toBe("tx");
    expect(lampOf({ tool: "eth_call", args: { transaction: { gas: "0x5dc0" } } })).toBe("replay");
    expect(lampOf({ tool: "eth_call", args: { transaction: { to: "0x1" } } })).toBe("reads");
    expect(lampOf({ tool: "estimate_gas", args: {} })).toBe("reads");
  });

  it("a successful transaction: no replay, the agent's own answer", async () => {
    const call = (async (tool: string) => {
      if (tool === "get_transaction") return { from: "0x317bca01bb101c0f1e86c21576a4e14d92b02975", to: null, gas: "0x5208", value: "0x0", input: "0x" };
      if (tool === "get_transaction_receipt") return { status: "0x1", blockNumber: "0x10", gasUsed: "0x5208" };
      throw new Error("unexpected " + tool);
    }) as any;
    const ev: any[] = [];
    await run(H as any, "atlantic", ev.push.bind(ev), async (_n, onCall) => ({ network: "atlantic", chainId: 688689, endpoint: "fake", via: "direct JSON-RPC", call: (async (t: string, a: any) => { const r = await call(t, a); onCall({ tool: t, args: a ?? {}, ms: 1, ok: true }); return r; }) as any, close: async () => {} }));
    const done = ev.find((e) => e.type === "done");
    expect(done.diagnosis.cause).toBe("succeeded");
    expect(done.text).toContain("DID NOT FAIL");
    expect(ev.filter((e) => e.type === "step").map((s) => `${s.id}:${s.state}`)).toEqual(["connect:ok", "tx:ok", "receipt:ok", "replay:skip", "reads:skip", "explain:ok"]);
  });
});
