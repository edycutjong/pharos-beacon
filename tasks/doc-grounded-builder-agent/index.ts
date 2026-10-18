// Doc-Grounded Builder Agent (Hard · 200 pts): "how do I X on Pharos?" → plan from the Docs MCP (sources cited) → do X
// through the Chain MCP → verify on chain against the plan. Anything that moves funds is PREPARED (unsigned tx shown);
// it is signed and sent only with --execute, on Atlantic testnet, never on mainnet.
//   npm run doc-grounded-builder-agent -- ["request" …] [--address 0x…] [--to 0x…] [--amount PHRS] [--token 0x…] [--tx 0x…] [--execute] [--json] [--proof]
// With no request it runs the six-request demo. A request the docs don't cover ends with "the docs don't cover this".
import { getAddress, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { secret } from "../../src/lib/env.js";
import { docsMcp, DOCS_MCP_URL, type DocsClient } from "../../src/lib/docs-mcp.js";
import { chainMcp, type ChainMcp } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { TOKENS } from "../../src/lib/networks.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { format, handle, type Deps, type Network, type Outcome, type Params } from "./agent.js";

const TASK = "doc-grounded-builder-agent";
export const DEMO = [
  "check my PHRS balance",
  "send PHRS on Atlantic",
  "read a token's total supply",
  "look up the receipt of a transaction",
  "wrap PHRS into WPHRS",
  "how do I bridge to Solana on Pharos?",
];
/** Keyless defaults: a public Atlantic contract as the address to read, a burn address as the recipient (when the second test wallet's key is present it is the recipient instead: no one else's send can touch its balance in the same block), a known Atlantic tx. */
const DEFAULT_ADDRESS = getAddress(TOKENS.atlantic.WPHRS.address);
const DEFAULT_TO = "0x000000000000000000000000000000000000dEaD" as Hex;
const DEFAULT_TX = "0x01cd6b78d83947c46e45d2e6c283ed68ea9dc6a9493b422c30163d42f704fe88" as Hex;
type Connect = Deps["chain"];

export async function main(
  { onExit }: RunContext,
  argv = process.argv.slice(2),
  connect?: Connect,
  connectDocs: () => Promise<Pick<DocsClient, "callTool" | "listTools"> & { close(): Promise<void> }> = () => docsMcp(),
  signerFor: Deps["signer"] = (mcp) => testnetSigner(mcp as ChainMcp),
): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- ["request" …] [--address 0x…] [--to 0x…] [--amount PHRS] [--token 0x…] [--tx 0x…] [--execute] [--json] [--proof]`,
      options: {
        address: { type: "string" },
        to: { type: "string" },
        amount: { type: "string", default: "0.001" },
        token: { type: "string" },
        tx: { type: "string" },
        execute: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        proof: { type: "boolean", default: false },
      },
      positionals: [0, 20],
    },
    argv,
  );
  for (const [flag, v] of [["--address", values.address], ["--to", values.to], ["--token", values.token]] as const) {
    if (v !== undefined && !isAddress(v)) throw new UsageError(`${flag} must be an address (got ${JSON.stringify(v)})`);
  }
  if (values.tx !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(values.tx)) throw new UsageError("--tx must be 0x followed by 64 hex characters");
  const requests = positionals.length ? positionals : DEMO;

  const pk = secret("PRIVATE_KEY");
  const pk2 = secret("PRIVATE_KEY_2");
  const keyAddress = pk ? privateKeyToAccount(pk as Hex).address : undefined; // only to know who "my" is; signing needs --execute
  const clients = new Map<string, Promise<Awaited<ReturnType<Connect>>>>();
  const chain: Connect =
    connect ??
    ((network: Network, broadcast = false) => {
      const key = `${network}:${broadcast}`;
      if (!clients.has(key)) {
        const c = chainMcp(network, broadcast ? { broadcast: true } : {});
        clients.set(key, c);
        void c.then((m) => onExit(() => m.close()));
      }
      return clients.get(key)!;
    });
  const docs = await connectDocs();
  onExit(() => docs.close());

  const params: Params = {
    address: values.address ? getAddress(values.address) : keyAddress ?? (positionals.length ? undefined : DEFAULT_ADDRESS),
    to: values.to ? getAddress(values.to) : pk2 ? privateKeyToAccount(pk2 as Hex).address : getAddress(DEFAULT_TO),
    amount: values.amount,
    token: values.token ? getAddress(values.token) : getAddress(TOKENS.pharos.WPROS.address),
    txHash: (values.tx as Hex | undefined) ?? DEFAULT_TX,
    execute: values.execute!,
  };
  const deps: Deps = { docs, chain, signer: signerFor, ...(keyAddress ? { defaultFrom: keyAddress } : { defaultFrom: DEFAULT_ADDRESS }) };

  const outcomes: Outcome[] = [];
  for (const r of requests) outcomes.push(await handle(r, params, deps));
  console.log(values.json ? JSON.stringify(outcomes, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) : outcomes.map((o, i) => format(o, i, outcomes.length)).join("\n\n"));
  const n = (s: Outcome["status"]) => outcomes.filter((o) => o.status === s).length;
  console.log(`\nsummary: ${outcomes.length} requests · ${n("success")} verified · ${n("prepared")} prepared · ${n("not-covered") + n("no-executor")} not covered/executed · ${n("failure")} failed`);
  console.log(`via Docs MCP ${DOCS_MCP_URL} and the Pharos Chain MCP`);
  if (values.proof) {
    const label = values.execute ? "executed" : "prepared";
    const meta = proofMeta(TASK, { network: "atlantic", chainId: 688689, endpoint: "Pharos Chain MCP (Atlantic stdio + hosted mainnet) and Docs MCP", server: undefined });
    console.log(`proof: ${writeProof(new URL(`proof/${label}.json`, import.meta.url), { outcomes }, meta)}`);
  }
  return n("failure") > 0 ? 1 : 0;
}

if (isMain(import.meta.url)) await runCli(main);
