// Finds large holders to watch: ranks the addresses that moved the most of a token in a block range (getLogsRange over the
// token's Transfer logs, so every number is from the chain, not a list we typed). Used once to write the whale watchlist.
//   npx tsx scripts/find-whales.ts [--blocks 40000] [--top 8] [--token 0x… …]
import { formatUnits, getAddress, type Hex } from "viem";
import { chainMcp, getLogsRange } from "../src/lib/mcp.js";
import { TOKENS } from "../src/lib/networks.js";
import { TRANSFER_TOPIC, ZERO } from "../src/whale/scan.js";
import { tokenInfo } from "../src/watch/token.js";

const arg = (name: string, d: string) => process.argv[process.argv.indexOf(`--${name}`) + 1] ?? d;
const blocks = BigInt(arg("blocks", "40000"));
const top = Number(arg("top", "8"));
const tokens = process.argv.includes("--token") ? process.argv.filter((_, i, a) => a[i - 1] === "--token") : [TOKENS.pharos.USDC.address, TOKENS.pharos.WPROS.address];

const mcp = await chainMcp("pharos");
try {
  const head = BigInt(((await mcp.call("get_block_number")) as { blockNumber: string }).blockNumber);
  console.log(`head ${head}; blocks ${head - blocks}–${head}`);
  for (const t of tokens as Hex[]) {
    const info = await tokenInfo(mcp.call, t);
    const logs = await getLogsRange(mcp.call, { address: t, topics: [[TRANSFER_TOPIC]], fromBlock: head - blocks, toBlock: head });
    const vol = new Map<string, bigint>();
    for (const l of logs) {
      if (l.topics.length !== 3) continue;
      for (const topic of [l.topics[1]!, l.topics[2]!]) {
        const a = getAddress(`0x${topic.slice(26)}`);
        if (a !== ZERO) vol.set(a, (vol.get(a) ?? 0n) + BigInt(l.data));
      }
    }
    console.log(`\n${info?.symbol ?? t}: ${logs.length} transfers`);
    for (const [a, v] of [...vol].sort((x, y) => (x[1] < y[1] ? 1 : -1)).slice(0, top)) console.log(`  ${a}  ${formatUnits(v, info?.decimals ?? 0)}`);
  }
} finally {
  await mcp.close();
}
