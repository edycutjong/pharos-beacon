import { formatEther, formatGwei, formatUnits, parseEther, parseGwei, parseUnits, type Hex } from "viem";
import { compare, type AddressRef, type Condition, type Op, type Policy } from "./policy.js";
import type { Reader } from "./reader.js";

export interface Check {
  label: string;
  kind: Condition["kind"];
  observed: string;
  expected: string;
  pass: boolean;
  error?: string;
}

export interface Verdict {
  policy: string;
  network: Policy["network"];
  block: string;
  allow: boolean;
  checks: Check[];
  evaluatedAt: string;
}

const SYMBOL = { pharos: "PROS", atlantic: "PHRS" } as const;
const OP_TEXT: Record<Op, string> = { gte: ">=", gt: ">", lte: "<=", lt: "<", eq: "==" };

/** Default human label so a report line reads on its own. */
export function describe(c: Condition): string {
  if (c.label) return c.label;
  switch (c.kind) {
    case "native_balance": return `native balance of ${c.address}`;
    case "erc20_balance": return `token ${c.token} balance of ${c.address}`;
    case "gas_price": return "gas price";
    case "is_contract": return `${c.address} ${c.expect ? "is a contract" : "is an EOA (no code)"}`;
    case "nonce_settled": return `${c.address} has no pending tx`;
    case "log_activity": return `events from ${c.address} in last ${c.blocks} blocks`;
  }
}

/**
 * Evaluate every condition against chain state pinned to one block. ALLOW only if all pass;
 * a read that throws counts as a failed check (fail closed), never as a pass.
 */
export async function evaluate(policy: Policy, reader: Reader, self?: Hex): Promise<Verdict> {
  const resolve = (a: AddressRef): Hex => {
    if (a !== "$SELF") return a;
    if (!self) throw new Error('"$SELF" needs a signing wallet (PRIVATE_KEY)');
    return self;
  };
  const sym = SYMBOL[policy.network];
  const block = await reader.blockNumber();
  const checks: Check[] = [];

  for (const c of policy.conditions) {
    const label = describe(c);
    try {
      checks.push({ label, kind: c.kind, ...(await check(c)) });
    } catch (e) {
      checks.push({ label, kind: c.kind, observed: "read failed", expected: "-", pass: false, error: (e as Error).message });
    }
  }

  async function check(c: Condition): Promise<Omit<Check, "label" | "kind">> {
    switch (c.kind) {
      case "native_balance": {
        const v = await reader.nativeBalance(resolve(c.address), block);
        return { observed: `${formatEther(v)} ${sym}`, expected: `${OP_TEXT[c.op]} ${c.value} ${sym}`, pass: compare(c.op, v, parseEther(c.value)) };
      }
      case "erc20_balance": {
        const [v, d] = await Promise.all([reader.erc20Balance(c.token, resolve(c.address), block), reader.erc20Decimals(c.token, block)]);
        if ((c.value.split(".")[1] ?? "").length > d) throw new Error(`threshold ${c.value} has more decimals than the token (${d})`);
        return { observed: formatUnits(v, d), expected: `${OP_TEXT[c.op]} ${c.value}`, pass: compare(c.op, v, parseUnits(c.value, d)) };
      }
      case "gas_price": {
        const v = await reader.gasPrice();
        return { observed: `${formatGwei(v)} gwei`, expected: `${OP_TEXT[c.op]} ${c.gwei} gwei`, pass: compare(c.op, v, parseGwei(c.gwei)) };
      }
      case "is_contract": {
        const code = await reader.code(resolve(c.address), block);
        const has = code !== "0x" && code.length > 2;
        return { observed: has ? `contract (${(code.length - 2) / 2} bytes)` : "no code", expected: c.expect ? "contract" : "no code", pass: has === c.expect };
      }
      case "nonce_settled": {
        const { latest, pending } = await reader.nonces(resolve(c.address));
        return { observed: `nonce latest ${latest} / pending ${pending}`, expected: "latest == pending", pass: latest === pending };
      }
      case "log_activity": {
        const from = block - BigInt(c.blocks) + 1n;
        const n = await reader.logCount(c.address, c.topic0, from < 0n ? 0n : from, block);
        return { observed: `${n} logs`, expected: `${OP_TEXT[c.op]} ${c.count}`, pass: compare(c.op, BigInt(n), BigInt(c.count)) };
      }
    }
  }

  return {
    policy: policy.name,
    network: policy.network,
    block: block.toString(),
    allow: checks.every((c) => c.pass),
    checks,
    evaluatedAt: new Date().toISOString(),
  };
}

export function formatVerdict(v: Verdict): string {
  const lines = [`${v.policy} @ ${v.network} block ${v.block}`];
  for (const c of v.checks) {
    lines.push(`  ${c.pass ? "PASS" : "FAIL"}  ${c.label}: ${c.observed} (need ${c.expected})${c.error ? ` — ${c.error}` : ""}`);
  }
  lines.push(`  => ${v.allow ? "ALLOW" : "DENY"} (${v.checks.filter((c) => c.pass).length}/${v.checks.length} conditions pass)`);
  return lines.join("\n");
}
