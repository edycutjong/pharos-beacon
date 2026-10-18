// Why did this transaction fail? Everything here reads through the Pharos Chain MCP (get_transaction, get_transaction_receipt,
// eth_call, estimate_gas) and returns a plain-language Diagnosis. No LLM: the cause comes from replaying the call.
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, erc20Abi, formatUnits, getAddress, parseAbi, type Hex } from "viem";
import { ChainToolError, type ChainMcp } from "../../src/lib/mcp.js";
import { withCommas } from "../read-contract-state/index.js";

export type Call = ChainMcp["call"];
export type Cause =
  | "not-found"
  | "pending"
  | "succeeded"
  | "out-of-gas"
  | "insufficient-balance"
  | "insufficient-allowance"
  | "revert-reason"
  | "known-error"
  | "panic"
  | "empty-revert"
  | "unknown-error"
  | "state-unavailable"
  | "not-reproduced";

export interface Diagnosis {
  hash: Hex;
  outcome: "failed" | "succeeded" | "pending" | "not-found";
  cause: Cause;
  /** One sentence, no jargon. */
  headline: string;
  /** Why it happened, in plain words. */
  why: string;
  /** What the user can do about it. */
  fix: string[];
  /** The raw findings behind the cause, so a reader can check them. */
  evidence: string[];
  facts: Record<string, string | number | boolean | null>;
}

/** Errors that popular contract libraries (OpenZeppelin v5) raise, plus Error(string) and Panic(uint256), which viem knows. */
export const ERRORS_ABI = parseAbi([
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidSpender(address spender)",
  "error OwnableUnauthorizedAccount(address account)",
  "error OwnableInvalidOwner(address owner)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error ReentrancyGuardReentrantCall()",
  "error ERC721NonexistentToken(uint256 tokenId)",
  "error ERC721InsufficientApproval(address operator, uint256 tokenId)",
  "error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner)",
]);

const PANIC: Record<number, string> = {
  0x01: "an internal safety check (assert) failed",
  0x11: "a number went below zero or above its maximum (arithmetic overflow)",
  0x12: "the contract divided by zero",
  0x21: "the contract was given a value outside the list it accepts",
  0x22: "the contract read corrupted storage",
  0x31: "the contract tried to remove an item from an empty list",
  0x32: "the contract read past the end of a list",
  0x41: "the contract ran out of memory",
  0x51: "the contract called a function that does not exist",
};

const OUT_OF_GAS = /out of gas/i;
const SEL = { transfer: "0xa9059cbb", transferFrom: "0x23b872dd", withdraw: "0x2e1a7d4d" } as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (n: bigint | number | string) => withCommas(n.toString());

interface Token {
  symbol: string;
  decimals: number;
}

async function tokenAt(call: Call, address: Hex, block: string): Promise<Token | null> {
  const read = async (functionName: "symbol" | "decimals") => {
    const { result } = await call("eth_call", { transaction: { to: address, data: encodeFunctionData({ abi: erc20Abi, functionName }) }, block });
    if (typeof result !== "string" || result === "0x") throw new Error("not a token");
    return decodeFunctionResult({ abi: erc20Abi, functionName, data: result as Hex });
  };
  try {
    return { symbol: (await read("symbol")) as string, decimals: Number(await read("decimals")) };
  } catch {
    return null; // not an ERC-20 (or no such view): amounts stay in raw units
  }
}

/** "Send at most X, or add Y first": a wallet with nothing only gets the second half. */
const topUp = (verb: string, who: string, balance: bigint, need: bigint, t: Token | null) =>
  balance === 0n ? `${who[0]!.toUpperCase()}${who.slice(1)} holds no${t ? ` ${t.symbol}` : " tokens"}: add at least ${amount(need, t)} before trying to ${verb} that much.` : `${verb[0]!.toUpperCase()}${verb.slice(1)} at most ${amount(balance, t)}, or first add at least ${amount(need - balance, t)} to ${who}.`;
const amount = (raw: bigint, t: Token | null) => (t ? `${withCommas(formatUnits(raw, t.decimals))} ${t.symbol}` : `${num(raw)} (raw units)`);

async function viewUint(call: Call, token: Hex, block: string, abi: typeof erc20Abi, functionName: "balanceOf" | "allowance", args: readonly Hex[]): Promise<bigint | null> {
  try {
    const { result } = await call("eth_call", { transaction: { to: token, data: encodeFunctionData({ abi, functionName, args } as never) }, block });
    if (typeof result !== "string" || result === "0x") return null;
    return decodeFunctionResult({ abi, functionName, data: result as Hex } as never) as bigint;
  } catch {
    return null;
  }
}

interface Ctx {
  call: Call;
  hash: Hex;
  from: Hex;
  to: Hex | null;
  input: Hex;
  value: bigint;
  gasLimit: bigint;
  gasUsed: bigint;
  block: bigint;
  /** the block before the failing one: the state the transaction started from (earlier transactions in its own block are not replayed) */
  before: string;
  token: Token | null;
}

/** Turn a revert's bytes into a cause. Token errors read the token's symbol and decimals so amounts have units. */
function explainRevert(c: Ctx, data: Hex): Pick<Diagnosis, "cause" | "headline" | "why" | "fix" | "evidence"> {
  if (data === "0x" || data === undefined) throw new Error("explainRevert needs revert bytes");
  let decoded: { errorName: string; args?: readonly unknown[] };
  try {
    decoded = decodeErrorResult({ abi: ERRORS_ABI, data }) as typeof decoded;
  } catch {
    const sel = data.slice(0, 10);
    return {
      cause: "unknown-error",
      headline: "The contract refused the transaction with an error this agent does not know.",
      why: `The contract stopped the transaction and returned an error code (${sel}) that is not in the list of common errors. The contract's own source or its verified page on the explorer says what that code means.`,
      fix: [`Open the contract on the explorer and look up the error ${sel} in its code or ABI.`, "If the dApp has a support channel, send them the transaction link."],
      evidence: [`revert data ${data.length > 74 ? `${data.slice(0, 74)}…` : data}`],
    };
  }
  const a = (decoded.args ?? []) as readonly (bigint | string)[];
  const who = (x: string) => (x.toLowerCase() === c.from.toLowerCase() ? "your wallet" : `wallet ${getAddress(x)}`);
  switch (decoded.errorName) {
    case "Error":
      return {
        cause: "revert-reason",
        headline: `The contract refused the transaction and gave this reason: "${a[0]}".`,
        why: `The contract checked a condition, it was not met, and the contract stopped the transaction with the message "${a[0]}". Nothing was changed; you only paid the network fee.`,
        fix: [
          // a short code with no spaces ("BC") says nothing by itself: point at where its meaning is written down
          ...(c.to && /^\S{1,6}$/.test(String(a[0])) ? [`The message is a short code, not a sentence. Look the contract (${c.to.slice(0, 6)}…${c.to.slice(-4)}) up on the block explorer; if its source is verified, search it for "${a[0]}" to see which check it belongs to.`] : []),
          "Change the input that the message points at (an amount, an address or a deadline) and send again.",
          "If you did not expect this, ask the dApp's support, quoting the message and the transaction link.",
        ],
        evidence: [`revert reason string: ${JSON.stringify(a[0])}`],
      };
    case "Panic": {
      const code = Number(a[0]);
      return {
        cause: "panic",
        headline: `The contract crashed on a safety check (code 0x${code.toString(16)}).`,
        why: `${PANIC[code] ?? "the contract hit an internal error"}. This is usually a bug in the contract or an input it was not built for.`,
        fix: ["Try a different (usually smaller or non-zero) input.", "If it keeps failing, tell the dApp's team: the contract has a bug."],
        evidence: [`panic code 0x${code.toString(16)}`],
      };
    }
    case "ERC20InsufficientBalance": {
      const [sender, balance, needed] = [a[0] as string, a[1] as bigint, a[2] as bigint];
      return {
        cause: "insufficient-balance",
        headline: `${who(sender)} does not hold enough${c.token ? ` ${c.token.symbol}` : " of the token"}: it has ${amount(balance, c.token)} and the transaction needed ${amount(needed, c.token)}.`,
        why: `The transaction tried to move ${amount(needed, c.token)} out of ${who(sender)}, but that wallet only held ${amount(balance, c.token)} when it ran. The token contract does not allow spending more than a wallet holds, so it stopped the transaction.`,
        fix: [topUp("send", who(sender), balance, needed, c.token), "Check the amount's decimals: a value typed in whole tokens must be multiplied by the token's decimals before sending."],
        evidence: [`token error ERC20InsufficientBalance(sender=${sender}, balance=${balance}, needed=${needed}) at block ${c.before}`],
      };
    }
    case "ERC20InsufficientAllowance": {
      const [spender, allowance, needed] = [a[0] as string, a[1] as bigint, a[2] as bigint];
      return {
        cause: "insufficient-allowance",
        headline: `${who(spender)} is not approved to move that much${c.token ? ` ${c.token.symbol}` : ""}: it is allowed ${amount(allowance, c.token)} and the transaction needed ${amount(needed, c.token)}.`,
        why: `Moving tokens on someone else's behalf needs their permission first (an "approval" that sets how much the spender may take). ${cap(who(spender))} was allowed ${amount(allowance, c.token)} but tried to take ${amount(needed, c.token)}, so the token contract stopped it.`,
        fix: [`The token's owner must approve first: from the owner's wallet call approve(${getAddress(spender)}, ${amount(needed, c.token)} or more) on the token ${c.to ? getAddress(c.to) : ""}, wait for it to confirm, then send this transaction again.`, "Approve only the amount you need, not an unlimited amount."],
        evidence: [`token error ERC20InsufficientAllowance(spender=${spender}, allowance=${allowance}, needed=${needed}) at block ${c.before}`],
      };
    }
    case "OwnableUnauthorizedAccount":
    case "AccessControlUnauthorizedAccount":
      return {
        cause: "known-error",
        headline: `${who(a[0] as string)} is not allowed to do this.`,
        why: `This function can only be used by the contract's owner or an account with a special role, and ${who(a[0] as string)} is neither.`,
        fix: ["Send it from the owner / authorised wallet, or ask the contract's admin to run it or to grant your wallet the role."],
        evidence: [`error ${decoded.errorName}(${a.map(String).join(", ")})`],
      };
    case "EnforcedPause":
      return { cause: "known-error", headline: "The contract is paused.", why: "The contract's admins switched it off for now (a pause), so every call to this function is refused until they switch it back on.", fix: ["Wait for the team to unpause it and check their announcements."], evidence: ["error EnforcedPause()"] };
    case "ExpectedPause":
      return { cause: "known-error", headline: "This action only works while the contract is paused, and it is not.", why: "The function is meant for emergencies and refuses to run while the contract is live.", fix: ["Only the admins can pause the contract: ask them."], evidence: ["error ExpectedPause()"] };
    case "ReentrancyGuardReentrantCall":
      return { cause: "known-error", headline: "The contract blocked a call that re-entered itself.", why: "While the contract was busy it was called again by the same transaction, which its safety guard forbids.", fix: ["Call it from a normal wallet, not from a contract that calls back into it."], evidence: ["error ReentrancyGuardReentrantCall()"] };
    default:
      return {
        cause: "known-error",
        headline: `The contract refused the transaction: ${decoded.errorName}.`,
        why: `The contract stopped the transaction with the error ${decoded.errorName}(${a.map(String).join(", ")}).`,
        fix: ["Check the arguments named in the error (addresses, ids, amounts) and send again with corrected values."],
        evidence: [`error ${decoded.errorName}(${a.map(String).join(", ")})`],
      };
  }
}

/** The contract reverted with no bytes. For the three most common token calls the cause can still be read off the balances. */
async function inferEmptyRevert(c: Ctx): Promise<Pick<Diagnosis, "cause" | "headline" | "why" | "fix" | "evidence"> | null> {
  if (!c.to) return null;
  const sel = c.input.slice(0, 10).toLowerCase();
  const word = (i: number) => BigInt(`0x${c.input.slice(10 + i * 64, 10 + (i + 1) * 64) || "0"}`);
  const addr = (i: number) => getAddress(`0x${c.input.slice(10 + i * 64 + 24, 10 + (i + 1) * 64)}`) as Hex;
  let holder: Hex | null = null;
  let need = 0n;
  let verb = "";
  if (sel === SEL.withdraw && c.input.length >= 10 + 64) [holder, need, verb] = [c.from, word(0), "withdraw"];
  else if (sel === SEL.transfer && c.input.length >= 10 + 128) [holder, need, verb] = [c.from, word(1), "send"];
  else if (sel === SEL.transferFrom && c.input.length >= 10 + 192) [holder, need, verb] = [addr(0), word(2), "move"];
  if (!holder) return null;
  const balance = await viewUint(c.call, c.to, c.before, erc20Abi, "balanceOf", [holder]);
  if (balance === null) return null;
  const who = holder.toLowerCase() === c.from.toLowerCase() ? "your wallet" : `wallet ${holder}`;
  if (balance < need) {
    return {
      cause: "insufficient-balance",
      headline: `${who} does not hold enough${c.token ? ` ${c.token.symbol}` : ""}: it has ${amount(balance, c.token)} and the transaction tried to ${verb} ${amount(need, c.token)}.`,
      why: `The contract did not say why it refused (it returned no message), but the numbers explain it: when the transaction ran, ${who} held ${amount(balance, c.token)} and the transaction tried to ${verb} ${amount(need, c.token)}, which is more than it holds. This cause is inferred from the balance, not reported by the contract.`,
      fix: [topUp(verb, who, balance, need, c.token), "Check the amount's decimals: whole tokens must be multiplied by the token's decimals before sending."],
      evidence: [`revert data was empty (0x)`, `balanceOf(${holder}) at block ${c.before} = ${balance}, amount in the call = ${need}`],
    };
  }
  if (sel === SEL.transferFrom) {
    const allowance = await viewUint(c.call, c.to, c.before, erc20Abi, "allowance", [holder, c.from]);
    if (allowance !== null && allowance < need) {
      return {
        cause: "insufficient-allowance",
        headline: `Your wallet is not approved to move that much${c.token ? ` ${c.token.symbol}` : ""}: it is allowed ${amount(allowance, c.token)} and the transaction needed ${amount(need, c.token)}.`,
        why: `The contract returned no message, but ${holder} had only allowed your wallet to take ${amount(allowance, c.token)}, less than the ${amount(need, c.token)} requested. This cause is inferred from the allowance, not reported by the contract.`,
        fix: [`The token's owner (${holder}) must call approve(${c.from}, ${amount(need, c.token)} or more) on ${getAddress(c.to)}, then send again.`],
        evidence: ["revert data was empty (0x)", `allowance(${holder}, ${c.from}) at block ${c.before} = ${allowance}, amount in the call = ${need}`],
      };
    }
  }
  return null;
}

function outOfGas(c: Ctx, estimate: { needed: bigint } | { revert: string } | null, replayed: boolean): Pick<Diagnosis, "cause" | "headline" | "why" | "fix" | "evidence"> {
  const used = `${num(c.gasUsed)} of ${num(c.gasLimit)}`;
  const need = estimate && "needed" in estimate ? estimate.needed : null;
  return {
    cause: "out-of-gas",
    headline: `The transaction ran out of gas: it was given ${num(c.gasLimit)} units and used all of them before it finished.`,
    why: `Gas is the fee budget a sender sets for a transaction. This one was given ${num(c.gasLimit)} units, the work needed more, so the network stopped it half-way and kept the fee for the work already done (${used} used).${estimate && "revert" in estimate ? ` Note: with more gas it would still fail, because ${estimate.revert}.` : ""}`,
    fix: need !== null
      ? [`Send it again with a higher gas limit: the call needs about ${num(need)} units now, so set at least ${num((need * 125n) / 100n)} (a 25% margin).`, "In a wallet, use the automatic gas estimate instead of typing a limit."]
      : ["Send it again with a higher gas limit (try double), or use the wallet's automatic gas estimate.", ...(estimate && "revert" in estimate ? [`Then fix the second problem: ${estimate.revert}.`] : [])],
    evidence: [`gasUsed ${c.gasUsed} = gas limit ${c.gasLimit}`, replayed ? "replaying the call with the same gas limit at the block before fails with an out-of-gas error" : "the call used its whole gas limit", ...(need !== null ? [`estimate_gas now: ${need}`] : [])],
  };
}

/** What an archive-less node says when the block's state is gone. */
const STATE_GONE = /missing trie node|state (?:is )?(?:not available|pruned|unavailable)|pruned|no state available|historical state/i;

/** Diagnose `hash` on the network `call` is connected to. */
export async function diagnose(call: Call, hash: Hex): Promise<Diagnosis> {
  const base = { hash } as const;
  const tx = await call("get_transaction", { hash });
  if (!tx) {
    return { ...base, outcome: "not-found", cause: "not-found", headline: "The network has no transaction with this hash.", why: "Either the hash has a typo, the transaction was never sent, it was dropped before it was mined, or it is on a different network.", fix: ["Check the hash character by character (66 characters, starting 0x).", "Try the other network (--network atlantic or --network pharos)."], evidence: ["get_transaction returned null"], facts: {} };
  }
  const receipt = await call("get_transaction_receipt", { hash });
  if (!receipt) {
    return { ...base, outcome: "pending", cause: "pending", headline: "The transaction has not been mined yet, so it has not failed (or succeeded).", why: "The network knows the transaction but has not put it in a block. If it stays this way, the fee offered may be too low.", fix: ["Wait a few blocks and ask again.", "If it stays pending, resend the same transaction with a higher fee."], evidence: ["get_transaction found it, get_transaction_receipt returned null"], facts: { from: tx.from } };
  }
  const block = BigInt(receipt.blockNumber);
  const gasLimit = BigInt(tx.gas);
  const gasUsed = BigInt(receipt.gasUsed);
  const facts = { from: tx.from, to: tx.to ?? null, block: block.toString(), gasLimit: gasLimit.toString(), gasUsed: gasUsed.toString(), value: BigInt(tx.value).toString() };
  if (receipt.status === "0x1") {
    return { ...base, outcome: "succeeded", cause: "succeeded", headline: "This transaction did not fail.", why: `It was mined in block ${block} with status success (used ${num(gasUsed)} of ${num(gasLimit)} gas).`, fix: ["Nothing to fix. If something still looks wrong in the app, it is not a failed transaction: check the app's own status or the token's balance."], evidence: [`receipt status 0x1`], facts };
  }
  const before = (block - 1n).toString();
  const to = (tx.to as Hex | null) ?? null;
  const c: Ctx = { call, hash, from: tx.from as Hex, to, input: tx.input as Hex, value: BigInt(tx.value), gasLimit, gasUsed, block, before, token: to ? await tokenAt(call, to, before) : null };
  const failed = (d: Pick<Diagnosis, "cause" | "headline" | "why" | "fix" | "evidence">, extra: Diagnosis["facts"] = {}): Diagnosis => ({
    ...base,
    outcome: "failed",
    ...d,
    headline: cap(d.headline),
    why: cap(d.why),
    evidence: [`receipt status 0x0 in block ${block}`, `replayed with eth_call at block ${before} (the state the transaction started from), same sender, value, data and gas limit`, ...d.evidence],
    facts: { ...facts, ...extra },
  });

  // Replay the exact call one block earlier: a revert comes back as JSON-RPC code 3 with the reason bytes.
  const replay = { from: c.from, ...(to ? { to } : {}), value: tx.value, data: tx.input, gas: tx.gas };
  try {
    await call("eth_call", { transaction: replay, block: before });
  } catch (e) {
    if (!(e instanceof ChainToolError)) throw e;
    if (e.code === 3) {
      const data = typeof e.data === "string" ? (e.data as Hex) : "0x";
      if (data !== "0x") return failed(explainRevert(c, data), { revertData: data });
      const inferred = await inferEmptyRevert(c);
      if (inferred) return failed(inferred, { revertData: "0x", inferred: true });
      return failed({
        cause: "empty-revert",
        headline: "The contract refused the transaction without saying why.",
        why: "The contract stopped the transaction and returned no message. That usually means a plain check inside it failed (a wrong amount, a missing permission, a closed sale, a paused feature or too little balance) and its author did not write a message for it. The network fee for the attempt was spent.",
        fix: ["Check your wallet balance of every token and of the native coin, and any approval the dApp needs.", "Try again with a smaller or different amount.", "Ask the dApp's support, quoting the transaction link: only the contract's source tells which check failed."],
        evidence: ["revert data was empty (0x)"],
      }, { revertData: "0x" });
    }
    if (e.code === -32015 || OUT_OF_GAS.test(e.reason)) {
      let est: { needed: bigint } | { revert: string } | null = null;
      try {
        est = { needed: BigInt((await call("estimate_gas", { transaction: { from: c.from, ...(to ? { to } : {}), value: tx.value, data: tx.input } })).gas) };
      } catch (err) {
        if (err instanceof ChainToolError && err.code === 3) est = { revert: typeof err.data === "string" && err.data !== "0x" ? explainRevert(c, err.data as Hex).headline.replace(/\.$/, "") : "the contract also refuses the call itself" };
      }
      return failed(outOfGas(c, est, true));
    }
    if (STATE_GONE.test(e.reason)) {
      // the node no longer keeps this block's state: say so, and still report what the receipt alone proves
      const gone = `this node no longer keeps the state of block ${before}, so the call cannot be replayed (${e.reason})`;
      const d = gasUsed >= gasLimit ? outOfGas(c, null, false) : { cause: "state-unavailable" as const, headline: "The transaction failed, but this node no longer keeps the state needed to replay it, so the cause cannot be read from here.", why: `The receipt says the transaction failed (status 0x0 in block ${block}, used ${num(gasUsed)} of ${num(gasLimit)} gas). Finding the reason means replaying it against the state of block ${before}, and the node no longer has that state.`, fix: ["Look at the transaction on the explorer: it may show the reason.", "Ask the dApp's support, quoting the transaction link."], evidence: [] };
      return { ...failed(d), evidence: [`receipt status 0x0 in block ${block}`, gone, ...d.evidence.filter((x) => !x.startsWith("replaying"))] };
    }
    return failed({
      cause: "unknown-error",
      headline: "The transaction failed but the network's replay gave an error this agent cannot classify.",
      why: `Replaying the call returned: ${e.reason}.`,
      fix: ["Look at the transaction on the explorer for more detail.", "Ask the dApp's support, quoting the transaction link."],
      evidence: [`eth_call error ${e.code ?? "?"}: ${e.reason}`],
    });
  }
  // The replay ran to the end without an error.
  if (gasUsed >= gasLimit) return failed(outOfGas(c, null, false));
  return failed({
    cause: "not-reproduced",
    headline: "The transaction failed, but replaying it one block earlier succeeds, so the cause cannot be read from here.",
    why: `Something changed between block ${before} and the transaction's turn in block ${block} (another transaction in the same block, for example one that used up the balance or the allowance).`,
    fix: ["Send it again: it may work now.", "If it fails again, ask the dApp's support, quoting both transaction links."],
    evidence: [`the replay at block ${before} succeeded and gasUsed ${gasUsed} < gas limit ${gasLimit}`],
  });
}

/** The report a person reads. */
export function formatDiagnosis(d: Diagnosis, network: { label: string; explorer: string }): string {
  const lines = [`Transaction  ${d.hash}`, `Network      ${network.label}`, `Explorer     ${network.explorer}/tx/${d.hash}`, ""];
  const tag = { failed: "FAILED", succeeded: "DID NOT FAIL", pending: "NOT MINED YET", "not-found": "NOT FOUND" }[d.outcome];
  lines.push(`Result       ${tag}`, `Cause        ${d.cause}`, "", `What happened`, `  ${d.headline}`, "", `Why`, `  ${d.why}`, "", `What you can do`, ...d.fix.map((f) => `  - ${f}`), "", `Evidence (for the curious)`, ...d.evidence.map((e) => `  · ${e}`));
  return lines.join("\n");
}
