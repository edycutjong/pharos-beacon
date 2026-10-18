import { encodeFunctionResult, erc20Abi, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/lib/cli.js";
import type { DocsClient } from "../src/lib/docs-mcp.js";
import { classify, format, handle, plan, refusal, type Deps, type Params } from "../tasks/doc-grounded-builder-agent/agent.js";
import { main } from "../tasks/doc-grounded-builder-agent/index.js";

const ME = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975" as Hex;
const TO = "0x000000000000000000000000000000000000dEaD" as Hex;
const TOKEN = "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0" as Hex;
const TX = ("0x" + "ab".repeat(32)) as Hex;
const RPC_PAGE = "https://docs.pharos.xyz/api-and-sdk/json-rpc-methods";

const answer = (body: string, src: string[]) => `${body}\n\n# Sources\n\n${src.map((u, i) => `- [Page ${i}](${u})`).join("\n")}`;

/** Fake Docs MCP: askQuestion answers by keyword in the question, getPage / searchDocumentation from tables. */
function fakeDocs(answers: Record<string, string>, pages: Record<string, string>, search: Record<string, string[]> = {}) {
  const calls: string[] = [];
  const client: DocsClient & { close(): Promise<void> } = {
    callTool: (async (p: { name: string; arguments: any }) => {
      calls.push(p.name);
      if (p.name === "getPage") {
        const t = pages[p.arguments.url];
        if (t === undefined) throw new Error("404");
        return { content: [{ type: "text", text: t }] };
      }
      if (p.name === "searchDocumentation") {
        return { content: (search[p.arguments.query] ?? []).map((u) => ({ type: "text", text: `Title: T\nLink: ${u}\nContent: x` })) };
      }
      const k = Object.keys(answers).find((x) => p.arguments.question.toLowerCase().includes(x));
      return { content: [{ type: "text", text: k ? answers[k]! : "I can't find this in the docs." }] };
    }) as never,
    listTools: (async () => ({ tools: [] })) as never,
    close: async () => {},
  };
  return { client, calls };
}

const DOCS = {
  balance: answer("Call `eth_getBalance` and divide by 10^18.", [RPC_PAGE]),
  "send phrs": answer("Use `cast send <to> --value 0.1ether`.", ["https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide"]),
  "total supply": answer("Call `totalSupply()` and divide by 10^decimals.", ["https://docs.pharos.xyz/developer-guide/rust"]),
  receipt: answer("Use `eth_getTransactionReceipt` with the hash.", [RPC_PAGE]),
};
const PAGES = {
  [RPC_PAGE]: "eth_getBalance eth_getTransactionReceipt",
  "https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide": "cast send 0x.. --value 1ether",
  "https://docs.pharos.xyz/developer-guide/rust": "function totalSupply() view returns (uint256)",
};

/** Fake Chain MCP with a movable balance book. */
function fakeChain(over: { receiptStatus?: string; recipientDelta?: bigint } = {}) {
  const bal = new Map<string, bigint>([[ME.toLowerCase(), 10n ** 18n], [TO.toLowerCase(), 5n]]);
  const seen: string[] = [];
  const call = (async (tool: string, args: any) => {
    seen.push(tool);
    switch (tool) {
      case "get_block_number": return { blockNumber: "100" };
      case "get_balance": {
        const w = bal.get(args.address.toLowerCase()) ?? 0n;
        return { address: args.address, balanceWei: w.toString(), balance: (Number(w) / 1e18).toString().replace(/e.*/, ""), symbol: "PHRS" };
      }
      case "get_transaction_count": return { nonce: "7" };
      case "estimate_gas": return { gas: "21000" };
      case "get_block": return { baseFeePerGas: "1000000000" };
      case "get_gas_price": return { maxPriorityFeePerGasWei: "0" };
      case "get_transaction_receipt": return args.hash === TX ? { status: over.receiptStatus ?? "0x1", blockNumber: "0x64", gasUsed: "0x5208" } : null;
      case "eth_call": {
        const sel = args.transaction.data.slice(0, 10);
        const enc = (functionName: any, result: unknown) => ({ result: encodeFunctionResult({ abi: erc20Abi, functionName, result } as never) });
        if (sel === "0x18160ddd") return enc("totalSupply", 5n * 10n ** 18n);
        if (sel === "0x313ce567") return enc("decimals", 18);
        if (sel === "0x95d89b41") return enc("symbol", "WPROS");
        throw new Error(sel);
      }
    }
    throw new Error(`unexpected tool ${tool}`);
  }) as any;
  return { mcp: { call, endpoint: "fake", network: "atlantic", chainId: 688689, server: undefined } as any, seen, bal, over };
}

function deps(docs: ReturnType<typeof fakeDocs>, chain: ReturnType<typeof fakeChain>, extra: Partial<Deps> = {}) {
  const networks: string[] = [];
  const d: Deps = { docs: docs.client, chain: async (n, b) => (networks.push(`${n}:${!!b}`), chain.mcp), defaultFrom: ME, ...extra };
  return { d, networks };
}
const P: Params = { execute: false, to: TO, amount: "0.001", token: TOKEN, txHash: TX };

describe("classify", () => {
  it.each([
    ["check my PHRS balance", "balance"],
    ["send PHRS on Atlantic", "send"],
    ["read a token's total supply", "supply"],
    ["look up the receipt of a transaction", "receipt"],
    ["wrap PHRS into WPHRS", "other"],
    ["how do I bridge to Solana on Pharos?", "other"],
    ["deploy a token", "other"],
    ["how do I check my USDC token balance on mainnet?", "other"],
    ["send tokens on Pharos mainnet", "other"],
  ])("%s → %s", (r, k) => expect(classify(r)).toBe(k));
});

describe("refusal", () => {
  it.each(["I can’t find a documented bridge.", "The docs don’t list a supported route.", "They don’t document the wrapping method.", "Solana isn’t listed.", "That is not supported."])(
    "%s",
    (s) => expect(refusal(s)).toBe(true),
  );
  it("does not flag a plain answer", () => expect(refusal("Call eth_getBalance and divide by 10^18.")).toBe(false));
});

describe("plan", () => {
  it("covers a request when a cited page names the method", async () => {
    const p = await plan(fakeDocs(DOCS, PAGES).client, "balance", "check my PHRS balance");
    expect(p.covered).toBe(true);
    expect(p.groundedIn).toEqual([RPC_PAGE]);
    expect(p.sources[0]!.url).toBe(RPC_PAGE);
  });
  it("falls back to searchDocumentation when no cited page names the method", async () => {
    const docs = fakeDocs({ balance: answer("Use eth_getBalance.", ["https://docs.pharos.xyz/x"]) }, { ...PAGES, "https://docs.pharos.xyz/x": "nothing" }, { eth_getBalance: [RPC_PAGE] });
    const p = await plan(docs.client, "balance", "check my PHRS balance");
    expect(p.covered).toBe(true);
    expect(p.sources.some((s) => s.url === RPC_PAGE && /searchDocumentation/.test(s.title))).toBe(true);
  });
  it("is not covered when the answer is general knowledge no page backs", async () => {
    const docs = fakeDocs({ balance: answer("Use eth_getBalance.", ["https://docs.pharos.xyz/x"]) }, { "https://docs.pharos.xyz/x": "nothing" });
    expect((await plan(docs.client, "balance", "check my PHRS balance")).covered).toBe(false);
  });
  it("is not covered when the docs answer is a refusal, even with sources", async () => {
    const docs = fakeDocs({ solana: answer("I can’t find a documented bridge. Solana isn’t listed.", [RPC_PAGE]) }, PAGES);
    const p = await plan(docs.client, "other", "how do I bridge to Solana on Pharos?");
    expect(p.covered).toBe(false);
    expect(p.refused).toBe(true);
    expect(p.excerpt).toEqual([]);
  });
});

describe("handle", () => {
  it("balance: plans first, reads, verifies a same-block re-read", async () => {
    const docs = fakeDocs(DOCS, PAGES);
    const chain = fakeChain();
    const o = await handle("check my PHRS balance", P, deps(docs, chain).d);
    expect(o.status).toBe("success");
    expect(o.observed).toContain("= 1 PHRS");
    expect(docs.calls[0]).toBe("askQuestion");
    expect(o.checks.every((c) => c.ok)).toBe(true);
  });

  it("supply: mainnet read only, verified", async () => {
    const chain = fakeChain();
    const { d, networks } = deps(fakeDocs(DOCS, PAGES), chain);
    const o = await handle("read a token's total supply", { ...P, execute: true }, d);
    expect(o.status).toBe("success");
    expect(o.observed).toContain("= 5 WPROS");
    expect(networks).toEqual(["pharos:false"]); // --execute never opens a broadcasting client for mainnet
  });

  it("receipt: success, and a revert is a failure", async () => {
    expect((await handle("look up the receipt of a transaction", P, deps(fakeDocs(DOCS, PAGES), fakeChain()).d)).status).toBe("success");
    expect((await handle("look up the receipt of a transaction", P, deps(fakeDocs(DOCS, PAGES), fakeChain({ receiptStatus: "0x0" })).d)).status).toBe("failure");
    expect((await handle("look up the receipt of a transaction", { ...P, txHash: ("0x" + "cd".repeat(32)) as Hex }, deps(fakeDocs(DOCS, PAGES), fakeChain()).d)).status).toBe("failure");
  });

  it("send without --execute is prepared: unsigned tx shown, no signer, no broadcast", async () => {
    const signer = vi.fn();
    const chain = fakeChain();
    const { d, networks } = deps(fakeDocs(DOCS, PAGES), chain, { signer });
    const o = await handle("send PHRS on Atlantic", P, d);
    expect(o.status).toBe("prepared");
    expect(o.unsigned).toMatchObject({ from: ME, to: TO, nonce: "7", gas: "21000", chainId: "688689" });
    expect(signer).not.toHaveBeenCalled();
    expect(networks).toEqual(["atlantic:false"]);
    expect(chain.seen).not.toContain("send_raw_transaction");
    expect(format(o, 0, 1)).toContain("PREPARED");
  });

  it("send prepared but underfunded fails the funding check", async () => {
    const chain = fakeChain();
    chain.bal.set(ME.toLowerCase(), 1000n);
    expect((await handle("send PHRS on Atlantic", P, deps(fakeDocs(DOCS, PAGES), chain).d)).status).toBe("failure");
  });

  function fakeSigner(chain: ReturnType<typeof fakeChain>, move: (value: bigint, fee: bigint) => void) {
    return () => ({
      address: ME,
      unresolved: undefined,
      prepare: async (i: any) => ({ chainId: 688689, to: i.to, value: i.value, nonce: 7, gas: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 0n }),
      sign: async (tx: any) => ({ hash: TX, raw: "0x", tx }),
      broadcast: async () => TX,
      waitForReceipt: async () => {
        move(10n ** 15n, 21000n * 1_000_000_000n);
        return { status: "success" as const, blockNumber: 101n, gasUsed: 21000n, effectiveGasPrice: 1_000_000_000n };
      },
    });
  }

  it("send --execute: signs, broadcasts, then verifies both balances against the plan", async () => {
    const chain = fakeChain();
    const move = (v: bigint, fee: bigint) => {
      chain.bal.set(ME.toLowerCase(), chain.bal.get(ME.toLowerCase())! - v - fee);
      chain.bal.set(TO.toLowerCase(), chain.bal.get(TO.toLowerCase())! + v);
    };
    const { d, networks } = deps(fakeDocs(DOCS, PAGES), chain, { signer: fakeSigner(chain, move) as never });
    const o = await handle("send PHRS on Atlantic", { ...P, execute: true }, d);
    expect(o.status).toBe("success");
    expect(networks).toEqual(["atlantic:true"]);
    expect(o.tx?.explorer).toBe(`https://atlantic.pharosscan.xyz/tx/${TX}`);
    expect(o.checks.map((c) => c.name)).toContain("recipient balance rose by the amount");
  });

  it("send --execute: a recipient balance that did not move is a failure", async () => {
    const chain = fakeChain();
    const move = (v: bigint, fee: bigint) => chain.bal.set(ME.toLowerCase(), chain.bal.get(ME.toLowerCase())! - v - fee); // recipient not credited
    const { d } = deps(fakeDocs(DOCS, PAGES), chain, { signer: fakeSigner(chain, move) as never });
    const o = await handle("send PHRS on Atlantic", { ...P, execute: true }, d);
    expect(o.status).toBe("failure");
    expect(o.checks.find((c) => c.name === "recipient balance rose by the amount")?.ok).toBe(false);
  });

  it("a request the docs don't cover ends with 'the docs don't cover this': no plan, no chain call", async () => {
    const docs = fakeDocs({ solana: answer("The docs don’t list a supported Solana bridge.", [RPC_PAGE]) }, PAGES);
    const chain = fakeChain();
    const { d, networks } = deps(docs, chain);
    const o = await handle("how do I bridge to Solana on Pharos?", { ...P, execute: true }, d);
    expect(o.status).toBe("not-covered");
    expect(o.plan.steps).toEqual([]);
    expect(networks).toEqual([]);
    expect(chain.seen).toEqual([]);
    expect(format(o, 0, 1)).toContain("THE DOCS DON'T COVER THIS");
  });

  it("a recipe whose docs are missing is also not covered, even when the chain could answer", async () => {
    const docs = fakeDocs({ "total supply": answer("Call totalSupply().", ["https://docs.pharos.xyz/x"]) }, { "https://docs.pharos.xyz/x": "no such word" });
    const chain = fakeChain();
    const o = await handle("read a token's total supply", P, deps(docs, chain).d);
    expect(o.status).toBe("not-covered");
    expect(chain.seen).toEqual([]);
  });

  it("an unknown request the docs do describe is reported but never executed", async () => {
    const docs = fakeDocs({ stake: answer("Stake through the validator portal.", [RPC_PAGE]) }, PAGES);
    const o = await handle("how do I stake PHRS?", P, deps(docs, fakeChain()).d);
    expect(o.status).toBe("no-executor");
  });
});

describe("main", () => {
  const run = (argv: string[], docs = fakeDocs(DOCS, PAGES), chain = fakeChain()) =>
    main({ onExit: () => {}, signal: new AbortController().signal }, argv, async () => chain.mcp, async () => docs.client);

  it("rejects bad flags", async () => {
    await expect(run(["--address", "nope"])).rejects.toBeInstanceOf(UsageError);
    await expect(run(["--tx", "0x12"])).rejects.toBeInstanceOf(UsageError);
    await expect(run(["--bogus"])).rejects.toBeInstanceOf(UsageError);
  });

  it("runs requests and exits 0; exits 1 when a verification fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await run(["check my PHRS balance", "--address", ME])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("summary: 1 requests · 1 verified");
    expect(await run(["look up the receipt of a transaction", "--tx", "0x" + "cd".repeat(32)])).toBe(1);
    log.mockRestore();
  });
});
