// Threshold Guardian CLI: evaluate a policy of onchain conditions via the Pharos Chain MCP, act only on ALLOW.
//   npx tsx tasks/threshold-guardian/index.ts <policy.json> [--execute] [--proof]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool, chainMcp } from "../../src/lib/mcp.js";
import { wallet } from "../../src/lib/chain.js";
import { formatVerdict } from "../../src/guardian/evaluate.js";
import { guard, type Signer } from "../../src/guardian/guard.js";
import { parsePolicy, type Policy } from "../../src/guardian/policy.js";
import { mcpReader } from "../../src/guardian/reader.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: guard <policy.json> [--execute] [--proof]");
  process.exit(2);
}
let policy: Policy;
try {
  policy = parsePolicy(JSON.parse(readFileSync(file, "utf8")));
} catch (e) {
  console.error(`${file}: ${(e as Error).message}`);
  process.exit(2);
}
const execute = args.includes("--execute");

let signer: Signer | undefined;
let mcp: Awaited<ReturnType<typeof chainMcp>> | undefined;
let code = 0;
try {
  if (policy.network === "atlantic" && process.env.PRIVATE_KEY) {
    const w = wallet();
    signer = { address: w.account.address, sendNative: (to, value) => w.sendTransaction({ to, value }) };
  }
  mcp = await chainMcp(policy.network);
  const outcome = await guard(policy, mcpReader((name, a) => callTool(mcp!, name, a)), signer, { execute });
  console.log(formatVerdict(outcome.verdict));
  if (outcome.status === "aborted") console.log(`re-check before send:\n${formatVerdict(outcome.recheck)}`);
  if (outcome.status === "executed" || outcome.status === "reverted") {
    console.log(`  re-checked at block ${outcome.recheck.block}: ALLOW → broadcast ${policy.action!.amount} PHRS transfer`);
    console.log(`  tx ${outcome.receipt.status} in block ${outcome.receipt.blockNumber}: https://atlantic.pharosscan.xyz/tx/${outcome.tx}`);
  }
  console.log(`status: ${outcome.status}`);
  if (args.includes("--proof")) {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "proof");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${basename(file, ".json")}.${outcome.status}.json`);
    writeFileSync(out, JSON.stringify({ policy, outcome }, null, 2) + "\n");
    console.log(`proof: ${out}`);
  }
  code = outcome.status === "executed" || outcome.status === "dry-run" ? 0 : 1;
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  code = 1;
} finally {
  await mcp?.close();
}
process.exit(code);
