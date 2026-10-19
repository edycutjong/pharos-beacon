// Settings and keys for the x402 API (requirement 06: keys only in env vars or a file, never in code or prompts).
// On Vercel they are environment variables. Locally: the shell, then ~/.config/pharos/x402.env, then the shared testnet.env
// (src/lib/env.ts). Keys are read into this module's scope only, never copied into process.env, and never printed.
import { homedir } from "node:os";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readEnvFiles, secret } from "../../src/lib/env.js";
import { X402_USDC } from "../../src/lib/networks.js";
import { addressSetting } from "./config.js";

const x402File = readEnvFiles([join(homedir(), ".config/pharos/x402.env")]);
const nonBlank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

/** A setting or key: the shell / Vercel env first, then ~/.config/pharos/x402.env, then testnet.env and the repo .env. */
export function setting(name: string): string | undefined {
  return nonBlank(process.env[name]) ?? nonBlank(x402File[name]) ?? secret(name);
}

function key(name: string, fallback?: string): Hex {
  const v = setting(name) ?? (fallback ? setting(fallback) : undefined);
  if (!v) throw new Error(`${name} is not set${fallback ? ` (nor ${fallback})` : ""}: put it in ~/.config/pharos/x402.env or the Vercel env`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} is not a 32-byte hex private key`);
  return v as Hex;
}

/** The payee of every paid route. */
export const payTo = (): Hex => addressSetting("PAY_TO_ADDRESS", setting("PAY_TO_ADDRESS"));

/** The facilitator's signer: it pays the gas for transferWithAuthorization. Never the payee or the buyer. */
export const facilitatorKey = (): Hex => key("FACILITATOR_PRIVATE_KEY");

/** The demo buyer (Vercel: BUYER_PRIVATE_KEY; locally it falls back to wallet 1, PRIVATE_KEY). */
export const buyerKey = (): Hex => key("BUYER_PRIVATE_KEY", "PRIVATE_KEY");

export const addressOf = (k: Hex): Hex => privateKeyToAccount(k).address;

/** USDC_ADDRESS, when set, must name the token this API is priced in; a different token is a configuration error. */
export function checkUsdcSetting(): void {
  const v = setting("USDC_ADDRESS");
  if (v && getAddress(v) !== getAddress(X402_USDC.address)) {
    throw new Error(`USDC_ADDRESS ${v} is not the EIP-3009 USDC this API settles in (${X402_USDC.address})`);
  }
}

/** The public origin used in links and as the 402's resource URL (the requests themselves go to the origin they arrived on). */
export const publicBaseUrl = (fallback: string): string => (setting("PUBLIC_BASE_URL") ?? fallback).replace(/\/+$/, "");
