// The shared payment preparer for the Natural-Language Payment Agent and the Invoice-to-Payment Agent.
// Draft in → deterministic checks (recipient format + checksum, token from the SkillEngine list, decimals read ON CHAIN,
// balance) → a human-readable summary → an UNSIGNED Atlantic transaction. It never holds a key: signing is a separate,
// explicit step (`signAndSend`) that only the CLIs' --execute flag reaches.
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseUnits, stringToHex, toHex, zeroAddress, type Hex } from "viem";
import type { Call } from "../lib/atlantic-call.js";
import type { PreparedTx, TestnetSigner } from "../lib/signer.js";
import { TOKENS, atlantic, explorerTx } from "../lib/networks.js";
import { SYMBOLS, type Draft } from "./parse.js";

export interface Check { name: string; ok: boolean; detail: string }
export interface Prepared {
  ok: boolean;
  checks: Check[];
  summary?: string;
  tx?: PreparedTx;
  /** The same transaction as an eth_sendTransaction request a wallet can sign. */
  walletRequest?: { method: "eth_sendTransaction"; params: [Record<string, string>] };
  resolved?: { symbol: string; decimals: number; units: bigint; recipient: Hex; from: Hex; reference?: string };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const MAX_REFERENCE_BYTES = 64;

export function txJson(tx: PreparedTx): Record<string, string | number> {
  return {
    chainId: tx.chainId, to: tx.to, value: tx.value.toString(), ...(tx.data ? { data: tx.data } : {}), nonce: tx.nonce,
    gas: tx.gas.toString(), maxFeePerGas: tx.maxFeePerGas.toString(), maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(),
  };
}

/** Everything is read through the Chain MCP `call`; `from` is only an address, never a key. */
export async function preparePayment(draft: Draft, o: { call: Call; from: Hex }): Promise<Prepared> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => (checks.push({ name, ok, detail }), ok);
  const fail = (): Prepared => ({ ok: false, checks });

  // 1. Recipient format
  const raw = draft.recipient ?? "";
  let recipient: Hex | undefined;
  if (!/^0x/i.test(raw)) add("recipient", false, /\.[a-z]+$/i.test(raw) ? `"${raw}" is a name, and Pharos has no name service to resolve it: give a 0x address` : `"${raw}" is not an address`);
  else if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) add("recipient", false, `"${raw}" is not a 42-character address`);
  else if (!isAddress(raw, { strict: true })) add("recipient", false, `${raw} has mixed-case letters that fail the EIP-55 checksum (a typo?): refusing`);
  else if (raw.toLowerCase() === zeroAddress) add("recipient", false, "the zero address burns funds: refusing");
  else if (raw.toLowerCase() === o.from.toLowerCase()) add("recipient", false, "the recipient is the sender: a self-transfer pays nothing");
  else {
    recipient = getAddress(raw);
    add("recipient", true, `${recipient} (valid, checksum ok)`);
  }

  // 2. Token from the SkillEngine list
  const symbol = (draft.token ?? "").toUpperCase();
  const native = symbol === "PHRS";
  const entry = native ? { address: undefined, decimals: 18 } : (TOKENS.atlantic as Record<string, { address: Hex; decimals: number }>)[symbol];
  if (!entry) add("token", false, `"${draft.token ?? ""}" is not in the Atlantic token list (${SYMBOLS.join(", ")})`);
  else add("token", true, native ? "PHRS, the native coin (18 decimals)" : `${symbol} at ${entry.address} (SkillEngine tokens.json)`);

  // 3. Decimals read on chain, amount precision
  let decimals = entry?.decimals ?? 18;
  if (entry?.address) {
    try {
      const onchain = Number(BigInt((await o.call("eth_call", { transaction: { to: entry.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }) } })).result));
      if (onchain !== entry.decimals) add("decimals", false, `the list says ${entry.decimals} but the contract answers ${onchain}: refusing`);
      else add("decimals", true, `decimals() = ${onchain} read on chain`);
      decimals = onchain;
    } catch (e) {
      add("decimals", false, `could not read decimals() from ${entry.address}: ${(e as Error).message}`);
    }
  }
  let units: bigint | undefined;
  const amount = draft.amount ?? "";
  if (!/^\d+(\.\d+)?$/.test(amount)) add("amount", false, `"${amount}" is not a plain decimal number`);
  else if ((amount.split(".")[1] ?? "").length > decimals) add("amount", false, `${amount} has more than ${decimals} decimals: it would be rounded, refusing`);
  else if (parseUnits(amount, decimals) === 0n) add("amount", false, "the amount is zero");
  else {
    units = parseUnits(amount, decimals);
    add("amount", true, `${amount} ${symbol} = ${units} base units`);
  }

  // Reference (invoice) travels as trailing calldata bytes
  let refHex = "";
  if (draft.reference) {
    const bytes = new TextEncoder().encode(draft.reference).length;
    if (bytes > MAX_REFERENCE_BYTES) return (add("reference", false, `the reference is ${bytes} bytes; the limit is ${MAX_REFERENCE_BYTES}`), fail());
    refHex = stringToHex(draft.reference).slice(2);
    add("reference", true, `"${draft.reference}" appended to the transaction data (${bytes} bytes)`);
  }
  if (!recipient || !entry || units === undefined || checks.some((c) => !c.ok)) return fail();

  // 4. Build the transaction, then the balance check (it needs the fee)
  const to: Hex = native ? recipient : entry.address!;
  const data = (native ? (refHex ? `0x${refHex}` : undefined) : `${encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, units] })}${refHex}`) as Hex | undefined;
  const value = native ? units : 0n;
  let tx: PreparedTx;
  let maxFeeText = "";
  const unit = native ? "PHRS" : symbol;
  try {
    // Balance first: a node cannot estimate gas for a transfer the sender cannot cover, and "revert" is a poor answer.
    const phrs = BigInt((await o.call("get_balance", { address: o.from })).balanceWei);
    const held = native ? phrs : BigInt((await o.call("eth_call", { transaction: { to: entry.address!, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [o.from] }) } })).result);
    if (held < units) {
      add("balance", false, `${short(o.from)} holds ${formatUnits(held, decimals)} ${unit} but ${amount} is requested`);
      return fail();
    }
    const [nonce, gas, block, price] = await Promise.all([
      o.call("get_transaction_count", { address: o.from, block: "pending" }),
      o.call("estimate_gas", { transaction: { from: o.from, to, value: toHex(value), ...(data ? { data } : {}) } }),
      o.call("get_block", { block: "latest" }),
      o.call("get_gas_price"),
    ]);
    if (!block?.baseFeePerGas) throw new Error("the latest block has no base fee");
    const priority = BigInt(price.maxPriorityFeePerGasWei);
    tx = { chainId: atlantic.id, to, value, ...(data ? { data } : {}), nonce: Number(nonce.nonce), gas: BigInt(gas.gas), maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + priority, maxPriorityFeePerGas: priority };
    const maxFee = tx.gas * tx.maxFeePerGas;
    const need = native ? value + maxFee : units;
    if (!native && phrs < maxFee) add("gas", false, `${short(o.from)} holds ${formatUnits(phrs, 18)} PHRS but the fee can reach ${formatUnits(maxFee, 18)} PHRS`);
    add("balance", held >= need, `${short(o.from)} holds ${formatUnits(held, decimals)} ${unit}, needs ${formatUnits(need, decimals)}${native ? " (amount + max fee)" : ""}`);
    maxFeeText = formatUnits(maxFee, 18);
  } catch (e) {
    add("simulation", false, `the node refused to prepare it: ${(e as Error).message.split("\n")[0]}`);
    return fail();
  }
  if (checks.some((c) => !c.ok)) return fail();

  const summary = [
    `Send ${amount} ${symbol}`,
    `  from      ${o.from}`,
    `  to        ${recipient}`,
    `  network   ${atlantic.name} (chain ${atlantic.id})`,
    ...(native ? [] : [`  contract  ${entry.address} (${symbol}.transfer)`]),
    ...(draft.reference ? [`  reference ${draft.reference}`] : []),
    `  max fee   ${maxFeeText} PHRS (gas ${tx.gas})`,
    "  status    UNSIGNED: nothing is signed or sent until you approve it",
  ].join("\n");
  const walletRequest = {
    method: "eth_sendTransaction" as const,
    params: [{ from: o.from, to: tx.to, value: toHex(tx.value), ...(tx.data ? { data: tx.data } : {}), gas: toHex(tx.gas), maxFeePerGas: toHex(tx.maxFeePerGas), maxPriorityFeePerGas: toHex(tx.maxPriorityFeePerGas), nonce: toHex(tx.nonce), chainId: toHex(tx.chainId), type: "0x2" }] as [Record<string, string>],
  };
  return { ok: true, checks, summary, tx, walletRequest, resolved: { symbol, decimals, units, recipient, from: o.from, ...(draft.reference ? { reference: draft.reference } : {}) } };
}

export interface Sent { hash: Hex; status: "success" | "reverted"; blockNumber: bigint; url: string }

/** The only place a key is used. The caller reaches it only with --execute. */
export async function signAndSend(signer: TestnetSigner, tx: PreparedTx): Promise<Sent> {
  const signed = await signer.sign(tx);
  await signer.broadcast(signed);
  const r = await signer.waitForReceipt(signed.hash);
  return { hash: signed.hash, status: r.status, blockNumber: r.blockNumber, url: explorerTx("atlantic", signed.hash) };
}

export function checksTable(checks: Check[]): string {
  return checks.map((c) => `  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(9)} ${c.detail}`).join("\n");
}
