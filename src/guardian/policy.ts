import { isAddress } from "viem";
import type { Network } from "../lib/mcp.js";

export type Op = "gte" | "gt" | "lte" | "lt" | "eq";
const OPS: Op[] = ["gte", "gt", "lte", "lt", "eq"];

/** "$SELF" resolves to the signing wallet's address at run time. */
export type AddressRef = `0x${string}` | "$SELF";

export type Condition =
  | { kind: "native_balance"; address: AddressRef; op: Op; value: string; label?: string }
  | { kind: "erc20_balance"; token: `0x${string}`; address: AddressRef; op: Op; value: string; label?: string }
  | { kind: "gas_price"; op: Op; gwei: string; label?: string }
  | { kind: "is_contract"; address: AddressRef; expect: boolean; label?: string }
  | { kind: "nonce_settled"; address: AddressRef; label?: string }
  | { kind: "log_activity"; address: `0x${string}`; topic0?: `0x${string}`; blocks: number; op: Op; count: number; label?: string };

export type Action = { type: "native_transfer"; to: AddressRef; amount: string };

export interface Policy {
  name: string;
  network: Network;
  conditions: Condition[];
  action?: Action;
}

const MAX_LOG_WINDOW = 1000; // Chain MCP get_logs limit (inclusive block span)

function fail(msg: string): never {
  throw new Error(`invalid policy: ${msg}`);
}

function checkAddress(v: unknown, where: string, allowSelf = true): void {
  if (allowSelf && v === "$SELF") return;
  if (typeof v !== "string" || !isAddress(v, { strict: false })) fail(`${where} must be an address${allowSelf ? ' or "$SELF"' : ""}`);
}

function checkDecimal(v: unknown, where: string): void {
  if (typeof v !== "string" || !/^\d+(\.\d+)?$/.test(v)) fail(`${where} must be a non-negative decimal string`);
}

function checkOp(v: unknown, where: string): void {
  if (!OPS.includes(v as Op)) fail(`${where}.op must be one of ${OPS.join(", ")}`);
}

/** Validate untrusted JSON into a Policy. Throws with a precise message on the first problem. */
export function parsePolicy(raw: unknown): Policy {
  if (!raw || typeof raw !== "object") fail("not an object");
  const p = raw as Record<string, unknown>;
  if (typeof p.name !== "string" || !p.name) fail("name is required");
  if (p.network !== "pharos" && p.network !== "atlantic") fail('network must be "pharos" or "atlantic"');
  if (!Array.isArray(p.conditions) || p.conditions.length === 0) fail("conditions must be a non-empty array");

  p.conditions.forEach((c: Record<string, unknown>, i: number) => {
    const at = `conditions[${i}]`;
    switch (c?.kind) {
      case "native_balance":
        checkAddress(c.address, `${at}.address`), checkOp(c.op, at), checkDecimal(c.value, `${at}.value`);
        break;
      case "erc20_balance":
        checkAddress(c.token, `${at}.token`, false), checkAddress(c.address, `${at}.address`);
        checkOp(c.op, at), checkDecimal(c.value, `${at}.value`);
        break;
      case "gas_price":
        checkOp(c.op, at), checkDecimal(c.gwei, `${at}.gwei`);
        break;
      case "is_contract":
        checkAddress(c.address, `${at}.address`);
        if (typeof c.expect !== "boolean") fail(`${at}.expect must be boolean`);
        break;
      case "nonce_settled":
        checkAddress(c.address, `${at}.address`);
        break;
      case "log_activity":
        checkAddress(c.address, `${at}.address`, false), checkOp(c.op, at);
        if (c.topic0 !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(String(c.topic0))) fail(`${at}.topic0 must be a 32-byte hex topic`);
        if (!Number.isInteger(c.blocks) || (c.blocks as number) < 1 || (c.blocks as number) > MAX_LOG_WINDOW)
          fail(`${at}.blocks must be an integer 1..${MAX_LOG_WINDOW}`);
        if (!Number.isInteger(c.count) || (c.count as number) < 0) fail(`${at}.count must be a non-negative integer`);
        break;
      default:
        fail(`${at}.kind "${String(c?.kind)}" is not supported`);
    }
  });

  if (p.action !== undefined) {
    const a = p.action as Record<string, unknown>;
    if (a.type !== "native_transfer") fail('action.type must be "native_transfer"');
    checkAddress(a.to, "action.to");
    checkDecimal(a.amount, "action.amount");
    if (p.network !== "atlantic") fail("actions run on Atlantic testnet only; mainnet policies are dry-run");
  }
  return raw as Policy;
}

export function compare(op: Op, observed: bigint, threshold: bigint): boolean {
  switch (op) {
    case "gte": return observed >= threshold;
    case "gt": return observed > threshold;
    case "lte": return observed <= threshold;
    case "lt": return observed < threshold;
    case "eq": return observed === threshold;
  }
}
