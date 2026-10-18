// Read Contract State (Easy · 50 pts): read a live contract's state through the Pharos Chain MCP and say it in plain words.
//   npm run read-contract-state -- [--contract 0x…] [--holder 0x…[=label]]… [--block N] [--proof]
// Default contract: official USDC on Pharos mainnet ("USDC (Circle Deployed)" in the Pharos docs token registry).
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseAbi, toEventSelector, type Hex } from "viem";
import { isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp, ChainToolError, getLogsRange, MAX_LOG_WINDOW, type ChainMcp } from "../../src/lib/mcp.js";
import { TOKENS } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";

const TASK = "read-contract-state";
export const USDC = TOKENS.pharos.USDC.address;
const ownable = parseAbi(["function owner() view returns (address)", "function paused() view returns (bool)"]);

export type Call = ChainMcp["call"];
export interface Labels {
  /** lower-case address → label */
  [address: string]: string;
}

/** Known addresses on Pharos mainnet (the SkillEngine token registry), plus anything the caller labels. */
export function labelsFor(contract: Hex, symbol: string, extra: Labels = {}): Labels {
  const l: Labels = {};
  for (const [sym, t] of Object.entries(TOKENS.pharos)) l[t.address.toLowerCase()] = `${sym} token contract`;
  l[contract.toLowerCase()] = `${symbol} token contract (this contract)`;
  return { ...l, ...extra };
}

/** `0xabc…` or `0xabc…=Treasury`. */
export function parseHolder(arg: string): { address: Hex; label?: string } {
  const [addr, ...rest] = arg.split("=");
  if (!addr || !isAddress(addr)) throw new UsageError(`--holder must be an address, optionally as 0x…=label (got ${JSON.stringify(arg)})`);
  return { address: getAddress(addr), ...(rest.length ? { label: rest.join("=") } : {}) };
}

export interface Holder {
  address: Hex;
  label: string;
  raw: string;
  amount: string;
}
export interface ContractState {
  contract: Hex;
  block: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupplyRaw: string;
  totalSupply: string;
  holders: Holder[];
  /** Optional Ownable / Pausable views: null when the contract has no such function. */
  owner: { address: Hex; label: string } | null;
  paused: boolean | null;
}

/** Group digits in thousands: "1234567.5" → "1,234,567.5". */
export const withCommas = (s: string) => s.replace(/^(-?\d+)/, (i) => i.replace(/\B(?=(\d{3})+(?!\d))/g, ","));

/** Every read is pinned to `block`, so all the numbers describe the same moment. */
export async function readState(call: Call, contract: Hex, block: bigint, holders: { address: Hex; label?: string }[], extra: Labels = {}): Promise<ContractState> {
  const view = async <F extends "name" | "symbol" | "decimals" | "totalSupply" | "balanceOf">(functionName: F, args?: readonly [Hex]) => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName, ...(args ? { args } : {}) } as never);
    const { result } = await call("eth_call", { transaction: { to: contract, data }, block: block.toString() });
    if (typeof result !== "string" || result === "0x") throw new Error(`${functionName}() on ${contract} returned no data: not a token contract at block ${block}`);
    return decodeFunctionResult({ abi: erc20Abi, functionName, data: result as Hex } as never) as never;
  };
  const optional = async <T>(functionName: "owner" | "paused"): Promise<T | null> => {
    try {
      const { result } = await call("eth_call", { transaction: { to: contract, data: encodeFunctionData({ abi: ownable, functionName }) }, block: block.toString() });
      if (typeof result !== "string" || result === "0x") return null;
      return decodeFunctionResult({ abi: ownable, functionName, data: result as Hex }) as T;
    } catch (e) {
      if (e instanceof ChainToolError) return null; // the contract reverted: it has no such function
      throw e; // anything else (network, rate limit) is a real failure, not "no owner"
    }
  };

  const [name, symbol, decimals, totalSupply] = await Promise.all([view("name") as Promise<string>, view("symbol") as Promise<string>, view("decimals") as Promise<number>, view("totalSupply") as Promise<bigint>]);
  const labels = labelsFor(contract, symbol, extra);
  // An address nobody labelled is still described: get_code says whether it is a wallet or a contract.
  const kind = async (a: Hex): Promise<string> => {
    const { code } = await call("get_code", { address: a, block: block.toString() });
    return code === "0x" ? "wallet (no code)" : "contract (has code)";
  };
  const label = async (a: Hex, own?: string): Promise<string> => own ?? labels[a.toLowerCase()] ?? kind(a);
  const balances = await Promise.all(holders.map(async (h) => (await view("balanceOf", [h.address])) as bigint));
  const owner = await optional<Hex>("owner");
  const paused = await optional<boolean>("paused");
  const holderLabels = await Promise.all(holders.map((h) => label(h.address, h.label)));
  // The owner is labelled by its role, plus what kind of account it is.
  const ownerLabel = owner ? (labels[owner.toLowerCase()] ?? `owner of this contract · ${await kind(owner)}`) : "";
  return {
    contract,
    block: block.toString(),
    name,
    symbol,
    decimals,
    totalSupplyRaw: totalSupply.toString(),
    totalSupply: formatUnits(totalSupply, decimals),
    holders: holders.map((h, i) => ({ address: h.address, label: holderLabels[i]!, raw: balances[i]!.toString(), amount: formatUnits(balances[i]!, decimals) })),
    owner: owner ? { address: getAddress(owner), label: ownerLabel } : null,
    paused,
  };
}

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const ZERO = "0x0000000000000000000000000000000000000000";

/** How many of the largest recipients are tried before giving up on finding one that still holds a balance. */
const MAX_HOLDER_TRIES = 4;

/**
 * A holder worth showing by default: the recipient of the largest Transfer in the last 1000 blocks up to `block`
 * (one get_logs call), skipping burns (to 0x0) and transfers to the token contract itself, which hold nothing worth
 * showing. Recipients are taken in descending order of their largest transfer and the first with `balanceOf > 0`
 * at `block` wins (at most MAX_HOLDER_TRIES eth_calls): a pass-through address that already moved its tokens on is
 * not a holder. The label says which rank was picked. Null when no candidate holds anything.
 */
export async function largestTransferRecipient(call: Call, contract: Hex, block: bigint, symbol: string): Promise<{ address: Hex; label: string } | null> {
  const from = block >= BigInt(MAX_LOG_WINDOW - 1) ? block - BigInt(MAX_LOG_WINDOW - 1) : 0n;
  const logs = await getLogsRange(call, { address: contract, topics: [TRANSFER], fromBlock: from, toBlock: block });
  const largest = new Map<string, { to: Hex; value: bigint }>();
  for (const log of logs) {
    try {
      const { args } = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      const to = args.to.toLowerCase();
      if (to === ZERO || to === contract.toLowerCase()) continue;
      const seen = largest.get(to);
      if (!seen || args.value > seen.value) largest.set(to, { to: args.to, value: args.value });
    } catch {
      // not a standard Transfer (e.g. a non-indexed variant): skip it
    }
  }
  const ranked = [...largest.values()].sort((x, y) => (x.value === y.value ? 0 : x.value > y.value ? -1 : 1)).slice(0, MAX_HOLDER_TRIES);
  for (const [i, c] of ranked.entries()) {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [c.to] });
    const { result } = await call("eth_call", { transaction: { to: contract, data }, block: block.toString() });
    if (typeof result !== "string" || result === "0x" || decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result as Hex }) === 0n) continue;
    const which = i === 0 ? "the largest" : `the #${i + 1} largest (the larger ones hold nothing at the read block)`;
    return { address: getAddress(c.to), label: `recipient of ${which} ${symbol} transfer in blocks ${from}–${block}` };
  }
  return null;
}

/** The token's symbol at `block`, with the same "not a token" error as `readState` when the call returns nothing. */
export async function readSymbol(call: Call, contract: Hex, block: bigint): Promise<string> {
  const { result } = await call("eth_call", { transaction: { to: contract, data: encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }) }, block: block.toString() });
  if (typeof result !== "string" || result === "0x") throw new Error(`symbol() on ${contract} returned no data: not a token contract at block ${block}`);
  return decodeFunctionResult({ abi: erc20Abi, functionName: "symbol", data: result as Hex }) as string;
}

/** Plain-language report: the address and block first, then every value with its unit applied. */
export function formatState(s: ContractState): string {
  const lines = [
    `Contract  ${s.contract}  (${s.name})`,
    `Read at   block ${s.block} on Pharos mainnet (chain 1672)`,
    "",
    `  name         ${s.name}`,
    `  symbol       ${s.symbol}`,
    `  decimals     ${s.decimals}   (1 ${s.symbol} = ${10n ** BigInt(s.decimals)} base units)`,
    `  totalSupply  ${withCommas(s.totalSupply)} ${s.symbol}   (raw ${s.totalSupplyRaw})`,
  ];
  for (const h of s.holders) lines.push(`  balance      ${withCommas(h.amount)} ${s.symbol}   held by ${h.address}  [${h.label}]`);
  lines.push(`  owner        ${s.owner ? `${s.owner.address}  [${s.owner.label}]` : "none: this contract has no owner() view"}`);
  lines.push(`  paused       ${s.paused === null ? "none: this contract has no paused() view" : s.paused ? "yes" : "no"}`);
  return lines.join("\n");
}

export async function main({ onExit }: RunContext, argv = process.argv.slice(2), connect: (n: "pharos") => Promise<Pick<ChainMcp, "call" | "close" | "endpoint" | "network" | "chainId" | "server">> = chainMcp): Promise<number> {
  const { values } = parseCli(
    {
      usage: `npm run ${TASK} -- [--contract 0x…] [--holder 0x…[=label]]… [--block N] [--proof]`,
      options: { contract: { type: "string", default: USDC }, holder: { type: "string", multiple: true }, block: { type: "string" }, proof: { type: "boolean", default: false } },
    },
    argv,
  );
  if (!isAddress(values.contract!)) throw new UsageError(`--contract must be an address (got ${JSON.stringify(values.contract)})`);
  const contract = getAddress(values.contract!);
  if (values.block !== undefined && !/^\d+$/.test(values.block)) throw new UsageError("--block must be a block number (decimal digits)");
  const holders = (values.holder ?? []).map(parseHolder);

  const mcp = await connect("pharos"); // the hosted, keyless Chain MCP; checks the endpoint serves chain 1672
  onExit(() => mcp.close());
  const head = BigInt((await mcp.call("get_block_number")).blockNumber);
  const block = values.block ? BigInt(values.block) : head;
  if (block > head) throw new UsageError(`--block ${block} is ahead of the chain head ${head}`);
  // Default balances: a real recent holder (found with get_logs) and the WPROS token contract (from the token registry).
  if (!values.holder) {
    const recent = await largestTransferRecipient(mcp.call, contract, block, await readSymbol(mcp.call, contract, block));
    if (recent) holders.push(recent);
    holders.push({ address: getAddress(TOKENS.pharos.WPROS.address) });
  }
  const state = await readState(mcp.call, contract, block, holders);
  console.log(formatState(state));
  console.log(`\nvia ${mcp.endpoint} · every read pinned to block ${state.block}`);
  if (values.proof) console.log(`proof: ${writeProof(new URL(`proof/${contract.toLowerCase()}.json`, import.meta.url), { head: head.toString(), state }, proofMeta(TASK, mcp))}`);
  return 0;
}

if (isMain(import.meta.url)) await runCli(main);
