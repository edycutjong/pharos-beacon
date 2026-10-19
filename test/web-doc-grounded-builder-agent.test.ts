// The Doc-Grounded Builder demo endpoint: input validation, never signing, and "not covered" opening no chain client.
import { describe, expect, it } from "vitest";
import { handle, jobFor, runDemo } from "../tasks/doc-grounded-builder-agent/web.js";

const docsWith = (answer: string, page = "") => ({
  callTool: (async (p: { name: string }) => ({ content: [{ type: "text", text: p.name === "askQuestion" ? answer : p.name === "searchDocumentation" ? "Title: X\nLink: https://docs.pharos.xyz/x" : page }] })) as never,
  listTools: (async () => ({ tools: [] })) as never,
  close: async () => {},
});

describe("doc-grounded-builder-agent web", () => {
  it("rejects bad input with a 400", async () => {
    for (const qs of ["action=run&preset=nope", "action=run&request=hi", `action=run&request=${"x".repeat(161)}`, "action=run&preset=send&to=0x12", "action=run&preset=send&amount=-1", "action=run&preset=receipt&tx=0x12", "action=x"]) {
      expect((await handle(new Request(`http://x/api/doc-grounded-builder-agent?${qs}`))).status, qs).toBe(400);
    }
  });

  it("never asks to execute", () => {
    expect(jobFor(new URLSearchParams("preset=send&execute=true")).params.execute).toBe(false);
  });

  it("a request the docs refuse opens no chain client and says so", async () => {
    let opened = 0;
    const ev: any[] = [];
    const conns = {
      docs: async () => docsWith("I can't find a Solana bridge in the docs.\n\n# Sources\n\n- [About](https://docs.pharos.xyz/about)"),
      mainnet: async () => { opened++; throw new Error("no"); },
      atlantic: () => { opened++; throw new Error("no"); },
    };
    await runDemo((e) => ev.push(e), jobFor(new URLSearchParams("preset=bridge")), conns as never);
    expect(opened).toBe(0);
    expect(ev.find((e) => e.id === "execute")).toMatchObject({ state: "skip" });
    expect(ev.at(-1)).toMatchObject({ type: "done", outcome: { status: "not-covered" } });
  });

  it("a send ends PREPARED and is never broadcast", async () => {
    const tools: string[] = [];
    const call = (async (tool: string) => {
      tools.push(tool);
      switch (tool) {
        case "get_block_number": return { blockNumber: "100" };
        case "get_transaction_count": return { nonce: "7" };
        case "estimate_gas": return { gas: "21000" };
        case "get_block": return { baseFeePerGas: "0x3b9aca00" };
        case "get_gas_price": return { maxPriorityFeePerGasWei: "0" };
        case "get_balance": return { balanceWei: "1000000000000000000" };
        default: throw new Error(tool);
      }
    }) as never;
    const conns = {
      docs: async () => docsWith("Use cast send <to> --value 0.1ether.\n\n# Sources\n\n- [Skill](https://docs.pharos.xyz/skill)", "cast send <recipient> --value 0.1ether"),
      mainnet: async () => { throw new Error("mainnet not used"); },
      atlantic: (on: () => void) => ({ call: (async (t: string, a: unknown) => (on(), (call as any)(t, a))) as never, endpoint: "fake", network: "atlantic", chainId: 688689, server: undefined }),
    };
    const ev: any[] = [];
    await runDemo((e) => ev.push(e), jobFor(new URLSearchParams("preset=send")), conns as never);
    expect(ev.at(-1)).toMatchObject({ outcome: { status: "prepared", unsigned: { nonce: "7", gas: "21000" } } });
    expect(tools).not.toContain("send_raw_transaction");
  });
});
