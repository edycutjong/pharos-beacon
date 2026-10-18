import { decodeEventLog, formatUnits, getAddress, parseAbiItem, toEventSelector, type AbiEvent, type Hex, type RpcLog } from "viem";

// Turns a raw log into the fields a reader wants (from, to, amount, tx hash, block), whatever the event is called:
// WETH9-style contracts say src/dst/wad where ERC-20 says from/to/value.

/** Events that can be named without a signature. */
const KNOWN: Record<string, string> = {
  Transfer: "event Transfer(address indexed from, address indexed to, uint256 value)",
  Approval: "event Approval(address indexed owner, address indexed spender, uint256 value)",
  Deposit: "event Deposit(address indexed dst, uint256 wad)",
  Withdrawal: "event Withdrawal(address indexed src, uint256 wad)",
};

export interface EventSpec {
  item: AbiEvent;
  /** The event signature hash: topic0, what get_logs filters on. */
  topic0: Hex;
  signature: string;
}

/** `Transfer`, or a full signature with names and `indexed`: `event Transfer(address indexed from, address indexed to, uint256 value)`. */
export function parseEvent(input: string): EventSpec {
  const text = (KNOWN[input.trim()] ?? input).trim();
  const full = text.startsWith("event ") ? text : `event ${text}`;
  let item: AbiEvent;
  try {
    item = parseAbiItem(full) as AbiEvent;
  } catch {
    throw new Error(`cannot read the event ${JSON.stringify(input)}: use a known name (${Object.keys(KNOWN).join(", ")}) or a full signature such as "Transfer(address indexed from, address indexed to, uint256 value)"`);
  }
  if (item.type !== "event") throw new Error(`${JSON.stringify(input)} is not an event`);
  if (item.inputs.some((i) => !i.name)) throw new Error(`name every parameter of ${JSON.stringify(input)} (e.g. "address indexed from") so the fields can be read`);
  return { item, topic0: toEventSelector(item), signature: `${item.name}(${item.inputs.map((i) => i.type).join(",")})` };
}

const FROM = ["from", "src", "owner", "sender", "_from", "depositor"];
const TO = ["to", "dst", "recipient", "spender", "_to", "receiver"];
const AMOUNT = ["value", "amount", "wad", "_value", "amount0"];

export interface DecodedEvent {
  event: string;
  contract: Hex;
  block: bigint;
  logIndex: number;
  tx: Hex;
  /** Every decoded parameter, bigints as decimal strings. */
  fields: Record<string, string>;
  from?: Hex;
  to?: Hex;
  /** Raw base units. */
  amountRaw?: bigint;
}

/** The first parameter with one of these names, but only if it really is of `type` (a `string sender` is not an address). */
const first = (spec: EventSpec, names: string[], type: string) => names.find((n) => spec.item.inputs.some((i) => i.name === n && i.type === type));

export function decodeLog(spec: EventSpec, log: RpcLog): DecodedEvent {
  const { args } = decodeEventLog({ abi: [spec.item], topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex }) as { args: Record<string, unknown> };
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(args ?? {})) fields[k] = typeof v === "bigint" ? v.toString() : String(v);
  const f = first(spec, FROM, "address");
  const t = first(spec, TO, "address");
  const a = first(spec, AMOUNT, "uint256");
  return {
    event: spec.item.name,
    contract: getAddress(log.address),
    block: BigInt(log.blockNumber!),
    logIndex: Number(BigInt(log.logIndex!)),
    tx: log.transactionHash as Hex,
    fields,
    ...(f ? { from: getAddress(fields[f]!) } : {}),
    ...(t ? { to: getAddress(fields[t]!) } : {}),
    ...(a ? { amountRaw: BigInt(fields[a]!) } : {}),
  };
}

/** `0.01` for 10000000000000000 at 18 decimals; the raw number when the decimals are unknown. */
export function amountText(e: DecodedEvent, decimals: number | undefined, symbol = ""): string {
  if (e.amountRaw === undefined) return "n/a";
  return decimals === undefined ? `${e.amountRaw} (raw)` : `${formatUnits(e.amountRaw, decimals)}${symbol ? ` ${symbol}` : ""}`;
}
