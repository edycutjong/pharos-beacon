// x402 Paywalled API: the price table, the network and the token, in one place. Every other module reads them from here.
import { formatUnits, getAddress, isAddress, type Hex } from "viem";
import type { PaymentRequirements } from "@x402/core/types";
import { X402_USDC, atlantic } from "../../src/lib/networks.js";

/** CAIP-2 id of Pharos Atlantic testnet (requirement 01). */
export const NETWORK = `eip155:${atlantic.id}` as const;
/** Where the API lives, on Vercel and on the local server alike. */
export const BASE_PATH = "/api/x402-paywalled-api";
/** Seconds a signed authorization stays valid for. */
export const MAX_TIMEOUT_SECONDS = 120;

export interface PaidRoute {
  path: string;
  /** Price in USDC atomic units (6 decimals). */
  amount: bigint;
  description: string;
}

/** The two paid routes, at different prices (requirement 02). `GET health` is the free one. */
export const PAID_ROUTES = {
  "gas-snapshot": { path: "gas-snapshot", amount: 1_000n, description: "Atlantic gas price, priority fee and latest block" },
  "whale-brief": { path: "whale-brief", amount: 10_000n, description: "Largest USDC transfers on Pharos mainnet in the last ~1,000 blocks" },
} as const satisfies Record<string, PaidRoute>;
export type PaidRouteName = keyof typeof PAID_ROUTES;
export const FREE_ROUTES = ["health"] as const;

export const isPaidRoute = (name: string): name is PaidRouteName => Object.hasOwn(PAID_ROUTES, name);

/** "0.001 USDC" from atomic units. */
export const usdc = (amount: bigint | string) => `${formatUnits(BigInt(amount), X402_USDC.decimals)} USDC`;

/** The x402 `price` for a route: an exact asset amount in the registry USDC, with the EIP-712 domain the client signs against. */
export function priceOf(name: PaidRouteName) {
  return {
    amount: PAID_ROUTES[name].amount.toString(),
    asset: X402_USDC.address,
    extra: { name: X402_USDC.name, version: X402_USDC.version },
  };
}

/** What the 402 should contain for a route, as the facilitator will check it. Used by tests and by the buyer's sanity check. */
export function requirementsFor(name: PaidRouteName, payTo: Hex): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: X402_USDC.address,
    amount: PAID_ROUTES[name].amount.toString(),
    payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: X402_USDC.name, version: X402_USDC.version },
  };
}

/** The 402 in plain words: price, asset and payee, so an agent or a person can decide before signing (one of "what's ours"). */
export function plainWords(name: PaidRouteName, payTo: string): string {
  return `This route costs ${usdc(PAID_ROUTES[name].amount)} (test USDC ${X402_USDC.address} on Pharos Atlantic, ${NETWORK}), paid to ${payTo}. `
    + "Sign an EIP-3009 transferWithAuthorization for exactly that amount and send it in the PAYMENT-SIGNATURE header.";
}

/** A checksummed address from a setting, or an error naming the setting. */
export function addressSetting(name: string, value: string | undefined): Hex {
  if (!value || !isAddress(value)) throw new Error(`${name} is not set to an address`);
  return getAddress(value);
}
