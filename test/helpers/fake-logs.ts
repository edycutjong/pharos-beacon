import { encodeAbiParameters, encodeEventTopics, erc20Abi, pad, parseAbi, type Hex, type RpcLog } from "viem";

export const TOKEN = "0x838800b758277CC111B2d48Ab01e5E164f8E9471" as Hex;
export const ALICE = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975" as Hex;
export const BOB = "0x8D347c72431ed6E033d5f43E56c0987E97f5D91B" as Hex;
const wethAbi = parseAbi(["event Deposit(address indexed dst, uint256 wad)"]);

const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}` as Hex;
export const txHash = (n: number) => pad(hex(n), { size: 32 });

export function transferLog(block: number, index: number, tx: number, value: bigint, from = ALICE, to = BOB): RpcLog {
  return {
    address: TOKEN, blockNumber: hex(block), logIndex: hex(index), transactionHash: txHash(tx), blockHash: txHash(9000 + block), transactionIndex: "0x0", removed: false,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  } as RpcLog;
}

export function depositLog(block: number, index: number, tx: number, wad: bigint, dst = ALICE): RpcLog {
  return {
    address: TOKEN, blockNumber: hex(block), logIndex: hex(index), transactionHash: txHash(tx), blockHash: txHash(9000 + block), transactionIndex: "0x0", removed: false,
    topics: encodeEventTopics({ abi: wethAbi, eventName: "Deposit", args: { dst } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [wad]),
  } as RpcLog;
}

/** A fake Chain MCP `call`: a chain whose head and logs the test controls; ERC-20 decimals 18 / symbol WPHRS. */
export function fakeChain(chain: { head: number; logs: RpcLog[] }, spy: { tool: string; args: any }[] = []) {
  const call = (async (tool: string, args: any) => {
    spy.push({ tool, args });
    if (tool === "get_block_number") return { blockNumber: String(chain.head) };
    if (tool === "get_logs") {
      const from = Number(args.fromBlock);
      const to = Number(args.toBlock);
      const addrs = ([] as string[]).concat(args.address ?? []).map((a) => a.toLowerCase());
      const t0 = args.topics?.[0] == null ? undefined : ([] as string[]).concat(args.topics[0]).map((t) => t.toLowerCase());
      return chain.logs.filter((l) => Number(BigInt(l.blockNumber!)) >= from && Number(BigInt(l.blockNumber!)) <= to && (!addrs.length || addrs.includes(l.address.toLowerCase())) && (!t0 || t0.includes(l.topics[0]!.toLowerCase())));
    }
    if (tool === "eth_call") {
      const sel = args.transaction.data.slice(0, 10);
      if (sel === "0x313ce567") return { result: pad(hex(18), { size: 32 }) };
      if (sel === "0x95d89b41") return { result: encodeAbiParameters([{ type: "string" }], ["WPHRS"]) };
    }
    throw new Error(`unexpected call ${tool}`);
  }) as any;
  return call;
}
