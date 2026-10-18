import { decodeFunctionResult, encodeFunctionData, erc20Abi, type Hex } from "viem";
import { ChainToolError, type ChainMcp } from "../lib/mcp.js";

/** decimals() and symbol() of an ERC-20, or undefined when the contract has no such view (then amounts stay raw). */
export async function tokenInfo(call: ChainMcp["call"], contract: Hex): Promise<{ decimals: number; symbol: string } | undefined> {
  const view = async (functionName: "decimals" | "symbol") => {
    const { result } = await call("eth_call", { transaction: { to: contract, data: encodeFunctionData({ abi: erc20Abi, functionName }) } });
    if (typeof result !== "string" || result === "0x") throw new ChainToolError("eth_call", `${functionName}() returned no data`);
    return decodeFunctionResult({ abi: erc20Abi, functionName, data: result as Hex });
  };
  try {
    return { decimals: Number(await view("decimals")), symbol: String(await view("symbol")) };
  } catch (e) {
    if (e instanceof ChainToolError) return undefined; // not an ERC-20: reverted or empty
    throw e; // a network or rate-limit failure is a real failure
  }
}
