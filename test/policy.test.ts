import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compare, parsePolicy } from "../src/guardian/policy.js";

const base = { name: "p", network: "atlantic", conditions: [{ kind: "gas_price", op: "lte", gwei: "50" }] };

describe("parsePolicy", () => {
  it("accepts every shipped example policy", () => {
    const dir = "tasks/threshold-guardian/policies";
    for (const f of readdirSync(dir)) expect(() => parsePolicy(JSON.parse(readFileSync(`${dir}/${f}`, "utf8")))).not.toThrow();
  });

  it.each([
    [{ ...base, network: "ethereum" }, /network/],
    [{ ...base, conditions: [] }, /non-empty/],
    [{ ...base, conditions: [{ kind: "price_oracle" }] }, /not supported/],
    [{ ...base, conditions: [{ kind: "native_balance", address: "0x12", op: "gte", value: "1" }] }, /address/],
    [{ ...base, conditions: [{ kind: "native_balance", address: "$SELF", op: "gte", value: "-1" }] }, /decimal/],
    [{ ...base, conditions: [{ kind: "gas_price", op: "ge", gwei: "1" }] }, /op must be/],
    [{ ...base, conditions: [{ kind: "erc20_balance", token: "$SELF", address: "$SELF", op: "gte", value: "1" }] }, /token/],
    [{ ...base, conditions: [{ kind: "is_contract", address: "$SELF", expect: "yes" }] }, /boolean/],
    [{ ...base, conditions: [{ kind: "log_activity", address: "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0", blocks: 1001, op: "gte", count: 1 }] }, /1\.\.1000/],
    [{ ...base, conditions: [{ kind: "log_activity", address: "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0", topic0: "0xdd", blocks: 10, op: "gte", count: 1 }] }, /topic0/],
    [{ ...base, action: { type: "erc20_transfer", to: "$SELF", amount: "1" } }, /action.type/],
    [{ ...base, network: "pharos", action: { type: "native_transfer", to: "$SELF", amount: "1" } }, /testnet only/],
    [{ ...base, action: { type: "native_transfer", to: "$SELF", amount: "0.000" } }, /greater than 0/],
    [{ ...base, action: { type: "native_transfer", to: "$SELF", amount: "0.0000000000000000004" } }, /18 decimal places/],
    [{ ...base, conditions: [{ kind: "gas_price", op: "lte", gwei: "1.0000000001" }] }, /9 decimal places/],
    [{ ...base, action: { type: "native_transfer", to: "0x8d347c72431ed6E033d5f43E56c0987E97f5D91B", amount: "1" } }, /action.to/],
  ])("rejects %#", (raw, msg) => {
    expect(() => parsePolicy(raw)).toThrow(msg);
  });
});

describe("compare", () => {
  it("implements every operator at the boundary", () => {
    expect([compare("gte", 5n, 5n), compare("gt", 5n, 5n), compare("lte", 5n, 5n), compare("lt", 5n, 5n), compare("eq", 5n, 5n)]).toEqual([
      true, false, true, false, true,
    ]);
  });
});
