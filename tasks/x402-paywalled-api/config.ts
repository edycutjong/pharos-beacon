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
  /** Price in USDC atomic units (6 decimals). For a quoted route this is the minimum, see QUOTE. */
  amount: bigint;
  description: string;
  /** True when the price depends on the request (U1). */
  quoted?: boolean;
}

/** The quoted route: 0.005 USDC per started 1,000 blocks of mainnet history, 1–3 windows. The 402 says how it got the number. */
export const QUOTE = { route: "whale-range", perWindow: 5_000n, window: 1_000, maxWindows: 3, defaultBlocks: 2_500 } as const;
export const MAX_BLOCKS = QUOTE.window * QUOTE.maxWindows;

/** `blocks` from the query: absent → the default; anything but a whole number in 1..MAX_BLOCKS → an error message. */
export function parseBlocks(raw: string | null | undefined): { blocks: number } | { error: string } {
  if (raw == null || raw === "") return { blocks: QUOTE.defaultBlocks };
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > MAX_BLOCKS) return { error: `blocks must be a whole number from 1 to ${MAX_BLOCKS}, got ${JSON.stringify(raw)}` };
  return { blocks: n };
}

/** The quote: how many 1,000-block windows `blocks` needs, and what they cost. */
export function quoteFor(blocks: number) {
  const windows = Math.ceil(blocks / QUOTE.window);
  return { blocks, windows, amount: QUOTE.perWindow * BigInt(windows) };
}

/** The two paid routes, at different prices (requirement 02). `GET health` is the free one. */
export const PAID_ROUTES = {
  "gas-snapshot": { path: "gas-snapshot", amount: 1_000n, description: "Atlantic gas price, priority fee and latest block" },
  "whale-brief": { path: "whale-brief", amount: 10_000n, description: "Largest USDC transfers on Pharos mainnet in the last ~1,000 blocks" },
  "whale-range": { path: "whale-range", amount: 5_000n, quoted: true, description: "Largest USDC transfers on Pharos mainnet over ?blocks=N blocks (quoted: 0.005 USDC per started 1,000 blocks, up to 3,000)" },
} as const satisfies Record<string, PaidRoute>;
export type PaidRouteName = keyof typeof PAID_ROUTES;
export const FREE_ROUTES = ["health"] as const;

export const isPaidRoute = (name: string): name is PaidRouteName => Object.hasOwn(PAID_ROUTES, name);

/** "0.001 USDC" from atomic units. */
export const usdc = (amount: bigint | string) => `${formatUnits(BigInt(amount), X402_USDC.decimals)} USDC`;

/** The x402 `price` for a route: an exact asset amount in the registry USDC, with the EIP-712 domain the client signs against. */
export function priceOf(name: PaidRouteName, amount: bigint = PAID_ROUTES[name].amount) {
  return {
    amount: amount.toString(),
    asset: X402_USDC.address,
    extra: { name: X402_USDC.name, version: X402_USDC.version },
  };
}

/** What the 402 should contain for a route, as the facilitator will check it. Used by tests and by the buyer's sanity check. */
export function requirementsFor(name: PaidRouteName, payTo: Hex, amount: bigint = PAID_ROUTES[name].amount): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: X402_USDC.address,
    amount: amount.toString(),
    payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: X402_USDC.name, version: X402_USDC.version },
  };
}

/** The 402 in plain words: price, asset and payee, so an agent or a person can decide before signing (one of "what's ours"). */
export function plainWords(name: PaidRouteName, payTo: string, amount: bigint = PAID_ROUTES[name].amount, why = ""): string {
  return `This route costs ${usdc(amount)}${why} (test USDC ${X402_USDC.address} on Pharos Atlantic, ${NETWORK}), paid to ${payTo}. `
    + "Sign an EIP-3009 transferWithAuthorization for exactly that amount and send it in the PAYMENT-SIGNATURE header.";
}

/** A checksummed address from a setting, or an error naming the setting. */
export function addressSetting(name: string, value: string | undefined): Hex {
  if (!value || !isAddress(value)) throw new Error(`${name} is not set to an address`);
  return getAddress(value);
}
