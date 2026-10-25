import { encodeAbiParameters, encodeEventTopics, erc20Abi, pad, parseAbi, type Hex, type RpcLog } from "viem";
import { APPROVAL_TOPIC } from "../../src/activity/engine.js";

export const W = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975" as Hex;
export const B = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B" as Hex;
export const S = "0x1111111111111111111111111111111111111111" as Hex;
export const POOL = "0x2222222222222222222222222222222222222222" as Hex;
export const C = "0x3333333333333333333333333333333333333333" as Hex;
export const TKN = "0x4444444444444444444444444444444444444444" as Hex;
export const OTH = "0x5555555555555555555555555555555555555555" as Hex;
export const T0 = 1_700_000_000; // block n has timestamp T0 + n (1 s blocks)
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}` as Hex;
export const th = (n: number) => pad(hex(n), { size: 32 });
const swapAbi = parseAbi(["event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"]); // the Uniswap V2 signature

export interface FakeTx { n: number; block: number; from: Hex; to: Hex | null; value?: bigint; input?: Hex; status?: 0 | 1; logs?: RpcLog[]; /** logs that are in the receipt but that the wallet's own topic queries do not match */ receiptOnly?: RpcLog[] }

let idx = 0;
const log = (tx: number, block: number, address: Hex, topics: Hex[], data: Hex): RpcLog =>
  ({ address, blockNumber: hex(block), logIndex: hex(idx++), transactionHash: th(tx), blockHash: th(9000 + block), transactionIndex: "0x0", removed: false, topics: topics as [Hex, ...Hex[]], data }) as RpcLog;
export const transfer = (tx: number, block: number, token: Hex, from: Hex, to: Hex, v: bigint) =>
  log(tx, block, token, encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [v]));
export const approval = (tx: number, block: number, token: Hex, owner: Hex, spender: Hex, v: bigint) =>
  log(tx, block, token, [APPROVAL_TOPIC as Hex, pad(owner, { size: 32 }), pad(spender, { size: 32 })], encodeAbiParameters([{ type: "uint256" }], [v]));
export const swapLog = (tx: number, block: number, pool: Hex, sender: Hex, to: Hex) =>
  log(tx, block, pool, encodeEventTopics({ abi: swapAbi, eventName: "Swap", args: { sender, to } }) as Hex[], encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [1n, 0n, 0n, 1n]));

/** A tiny chain: blocks with 1 s spacing, transactions with receipts and logs, two ERC-20s, the contracts S/POOL/C. */
export function fakeWorld(txs: FakeTx[], head = 400, spy: { tool: string; args: any }[] = []) {
  const byHash = new Map(txs.map((t) => [th(t.n), t]));
  const logsAll = txs.flatMap((t) => t.logs ?? []);
  const call = (async (tool: string, args: any = {}) => {
    spy.push({ tool, args });
    switch (tool) {
      case "get_chain_info": return { nativeSymbol: "PROS", chainId: 1672 };
      case "get_block_number": return { blockNumber: String(head) };
      case "get_block": {
        const n = args.block === "latest" ? head : Number(args.block);
        if (n > head) return null;
        const inBlock = txs.filter((t) => t.block === n);
        return { number: hex(n), timestamp: hex(T0 + n), transactions: args.includeTransactions ? inBlock.map((t) => ({ hash: th(t.n), from: t.from, to: t.to, value: hex(t.value ?? 0n), input: t.input ?? "0x" })) : inBlock.map((t) => th(t.n)) };
      }
      case "get_transaction": { const t = byHash.get(args.hash); return t ? { hash: args.hash, from: t.from, to: t.to, value: hex(t.value ?? 0n), input: t.input ?? "0x", gasPrice: hex(10n ** 9n) } : null; }
      case "get_transaction_receipt": { const t = byHash.get(args.hash); return t ? { blockNumber: hex(t.block), status: t.status === 0 ? "0x0" : "0x1", gasUsed: hex(21000), effectiveGasPrice: hex(10n ** 9n), logs: [...(t.logs ?? []), ...(t.receiptOnly ?? [])] } : null; }
      case "get_code": return { code: [S, POOL, C, TKN, OTH].some((a) => a.toLowerCase() === String(args.address).toLowerCase()) ? "0x6001" : "0x" };
      case "get_transaction_count": { const upto = args.block === undefined || args.block === "latest" ? head : Number(args.block); return { nonce: String(txs.filter((t) => t.from === W && t.block <= upto).length) }; }
      case "get_logs": {
        const from = Number(args.fromBlock), to = Number(args.toBlock);
        if (to - from + 1 > 1000) throw new Error("Block range too large");
        const [, t1, t2] = (args.topics ?? []) as (string | null | undefined)[];
        return logsAll.filter((l) => {
          const b = Number(BigInt(l.blockNumber!));
          return b >= from && b <= to && (!t1 || l.topics[1]?.toLowerCase() === t1.toLowerCase()) && (!t2 || l.topics[2]?.toLowerCase() === t2.toLowerCase());
        });
      }
      case "eth_call": {
        const sel = args.transaction.data.slice(0, 10);
        const sym = String(args.transaction.to).toLowerCase() === TKN.toLowerCase() ? "TKN" : "OTH";
        const dec = sym === "TKN" ? 6 : 18;
        if (sel === "0x313ce567") return { result: pad(hex(dec), { size: 32 }) };
        if (sel === "0x95d89b41") return { result: encodeAbiParameters([{ type: "string" }], [sym]) };
      }
    }
    throw new Error(`unexpected call ${tool}`);
  }) as any;
  return call;
}

export const world = (): FakeTx[] => [
  { n: 1, block: 100, from: W, to: TKN, input: "0xa9059cbb00", logs: [transfer(1, 100, TKN, W, B, 5_000_000n)] },
  { n: 2, block: 110, from: B, to: TKN, input: "0xa9059cbb00", logs: [transfer(2, 110, TKN, B, W, 3_000_000n)] },
  { n: 3, block: 120, from: W, to: TKN, input: "0x095ea7b3", logs: [approval(3, 120, TKN, W, S, (1n << 256n) - 1n)] },
  { n: 4, block: 130, from: W, to: POOL, input: "0x38ed1739", logs: [transfer(4, 130, TKN, W, POOL, 2_000_000n), transfer(4, 130, OTH, POOL, W, 10n ** 18n), swapLog(4, 130, POOL, W, W)] },
  { n: 5, block: 140, from: W, to: C, input: "0xdeadbeef", status: 0 },
  { n: 6, block: 150, from: W, to: B, value: 10n ** 18n },
  { n: 7, block: 160, from: B, to: W, value: 2n * 10n ** 18n },
];

/** An allowance being used up inside a transfer the wallet sends: an Approval log, but not a new approval. */
export const spentAllowance = (): FakeTx => ({ n: 8, block: 105, from: W, to: TKN, input: "0x23b872dd", logs: [transfer(8, 105, TKN, W, B, 1_000_000n), approval(8, 105, TKN, W, S, 99n)] });

/** Value sent into a contract with calldata (a wrap): a payable call, not a transfer. */
export const payableCall = (): FakeTx => ({ n: 9, block: 112, from: W, to: C, value: 5n * 10n ** 17n, input: "0xd0e30db0" });
/** A swap paid in the native token: value to the pool, a token back. */
export const nativeSwap = (): FakeTx => ({ n: 10, block: 114, from: W, to: POOL, value: 10n ** 18n, input: "0x7ff36ab5", logs: [transfer(10, 114, OTH, POOL, W, 7n * 10n ** 18n)] });

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Hex;
/** Tokens minted to the wallet: a Transfer from the zero address, sent by someone else. */
export const mintTx = (): FakeTx => ({ n: 11, block: 118, from: B, to: TKN, input: "0x1249c58b", logs: [transfer(11, 118, TKN, ZERO_ADDR, W, 9_000_000n)] });

const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65" as Hex;
export const withdrawalLog = (tx: number, block: number, token: Hex, src: Hex, wad: bigint): RpcLog => log(tx, block, token, [WITHDRAWAL, pad(src, { size: 32 })], encodeAbiParameters([{ type: "uint256" }], [wad]));
/** A token sold for the native token through a router: the wallet sends the token to a pool; the Swap event names the router (not the wallet) and the payout is an unwrap. */
export const sellForNative = (): FakeTx => ({
  n: 13, block: 116, from: W, to: C, input: "0x18cbafe5",
  logs: [transfer(13, 116, TKN, W, POOL, 4_000_000n)],
  receiptOnly: [swapLog(13, 116, POOL, C, C), withdrawalLog(13, 116, OTH, C, 2n * 10n ** 18n)],
});
/** The same shape with no unwrap: nothing shows what came back. */
export const sellNoPayout = (): FakeTx => ({ n: 14, block: 117, from: W, to: C, input: "0x38ed1739", logs: [transfer(14, 117, TKN, W, POOL, 1_000_000n)], receiptOnly: [swapLog(14, 117, POOL, C, C)] });
/** Someone else's swap that pays the wallet: the wallet did not send it, so it is a transfer in, not a swap. */
export const swapByOther = (): FakeTx => ({ n: 15, block: 119, from: B, to: C, input: "0x38ed1739", logs: [transfer(15, 119, TKN, POOL, W, 2_000_000n), swapLog(15, 119, POOL, C, W)] }); // the Swap event names the wallet as recipient: the wallet's own log query returns it
