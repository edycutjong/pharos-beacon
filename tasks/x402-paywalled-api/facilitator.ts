// Our own x402 facilitator (requirement 03): POST verify, POST settle, GET supported. Signer = FACILITATOR_PRIVATE_KEY, which
// pays the gas for USDC transferWithAuthorization on Atlantic. Built on the x402 SDK (x402Facilitator + ExactEvmScheme), plus:
//   - replay refused: before verify and before settle, the EIP-3009 nonce is read on chain (authorizationState); a used nonce is
//     refused as invalid_exact_evm_nonce_already_used, so a re-sent PAYMENT-SIGNATURE gets a 402 and never a second settle;
//   - scope: it only verifies and settles payments to our payee in our USDC on Atlantic, so a stranger cannot spend its gas.
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorEvmSigner, type FacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { createWalletClient, getAddress, http, publicActions, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { X402_USDC, atlantic } from "../../src/lib/networks.js";
import { NETWORK } from "./config.js";

export const NONCE_USED = "invalid_exact_evm_nonce_already_used";
export const OUT_OF_SCOPE = "beacon_out_of_scope";

const authorizationStateAbi = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Reads the chain for the facilitator's own checks (injected in tests). */
export interface NonceReader {
  nonceUsed(token: Hex, from: Hex, nonce: Hex): Promise<boolean>;
}

/** The EIP-3009 authorization inside an "exact" payload, or undefined for any other payload shape. */
export function authorizationOf(p: PaymentPayload): { from: Hex; to: Hex; value: string; nonce: Hex } | undefined {
  const a = (p.payload as { authorization?: Record<string, unknown> } | undefined)?.authorization;
  if (!a || typeof a.from !== "string" || typeof a.nonce !== "string" || typeof a.to !== "string") return undefined;
  return { from: a.from as Hex, to: a.to as Hex, value: String(a.value), nonce: a.nonce as Hex };
}

/** Why our facilitator refuses this payment before the SDK looks at it, or undefined to let it through. */
export async function preCheck(p: PaymentPayload, r: PaymentRequirements, payTo: Hex, chain: NonceReader): Promise<string | undefined> {
  if (r.network !== NETWORK || getAddress(r.asset) !== getAddress(X402_USDC.address) || getAddress(r.payTo) !== payTo) return OUT_OF_SCOPE;
  const auth = authorizationOf(p);
  if (!auth) return undefined; // not an EIP-3009 payload: the SDK names what is wrong with it
  return (await chain.nonceUsed(getAddress(r.asset), auth.from, auth.nonce)) ? NONCE_USED : undefined;
}

export interface Facilitator {
  facilitator: x402Facilitator;
  address: Hex;
}

/** The facilitator for Atlantic, signing with `key`. `payTo` is the only payee it serves. */
export function createFacilitator(key: Hex, payTo: Hex, rpcUrl = atlantic.rpcUrls.default.http[0]): Facilitator {
  const account = privateKeyToAccount(key);
  const client = createWalletClient({ account, chain: atlantic, transport: http(rpcUrl, { timeout: 30_000, retryCount: 3, retryDelay: 800 }) }).extend(publicActions);
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    getCode: (a) => client.getCode(a),
    readContract: (a) => client.readContract({ ...a, args: a.args ?? [] } as Parameters<typeof client.readContract>[0]),
    verifyTypedData: (a) => client.verifyTypedData(a as Parameters<typeof client.verifyTypedData>[0]),
    writeContract: (a) => client.writeContract({ ...a, args: a.args ?? [] } as Parameters<typeof client.writeContract>[0]),
    sendTransaction: (a) => client.sendTransaction(a),
    waitForTransactionReceipt: (a) => client.waitForTransactionReceipt({ ...a, pollingInterval: 500, timeout: 45_000 }),
  });
  const chain: NonceReader = {
    nonceUsed: (token, from, nonce) => client.readContract({ address: token, abi: authorizationStateAbi, functionName: "authorizationState", args: [from, nonce] }),
  };
  return { facilitator: buildFacilitator(signer, chain, payTo), address: account.address };
}

/** The facilitator around any signer and chain reader (tests inject both). */
export function buildFacilitator(signer: FacilitatorEvmSigner, chain: NonceReader, payTo: Hex): x402Facilitator {
  const facilitator = new x402Facilitator().register(NETWORK, new ExactEvmScheme(signer));
  facilitator.onBeforeVerify(async ({ paymentPayload, requirements }) => {
    const reason = await preCheck(paymentPayload, requirements, payTo, chain);
    return reason ? { abort: true, reason } : undefined;
  });
  facilitator.onBeforeSettle(async ({ paymentPayload, requirements }) => {
    const reason = await preCheck(paymentPayload, requirements, payTo, chain);
    return reason ? { abort: true, reason } : undefined;
  });
  return facilitator;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function readBody(req: Request): Promise<{ paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } | undefined> {
  try {
    const b = (await req.json()) as { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements };
    return b?.paymentPayload && b.paymentRequirements ? { paymentPayload: b.paymentPayload, paymentRequirements: b.paymentRequirements } : undefined;
  } catch {
    return undefined;
  }
}

/** The three facilitator endpoints as Request → Response. `op` is the last path segment. */
export async function facilitatorRoute(f: Facilitator, op: "verify" | "settle" | "supported", req: Request): Promise<Response> {
  if (op === "supported") {
    if (req.method !== "GET") return json({ error: "use GET" }, 405);
    return json(f.facilitator.getSupported());
  }
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  const body = await readBody(req);
  if (!body) return json({ error: "body must be JSON with paymentPayload and paymentRequirements" }, 400);
  try {
    if (op === "verify") return json(await f.facilitator.verify(body.paymentPayload, body.paymentRequirements));
    return json(await f.facilitator.settle(body.paymentPayload, body.paymentRequirements));
  } catch (e) {
    // The SDK throws "Settlement aborted: <reason>" when a before-settle check refuses: that is a refusal, not a crash.
    const msg = (e as Error).message;
    const aborted = /aborted: (\S+)/.exec(msg)?.[1];
    if (op === "settle" && aborted) {
      const auth = authorizationOf(body.paymentPayload);
      return json({ success: false, errorReason: aborted, transaction: "", network: body.paymentRequirements.network, payer: auth?.from });
    }
    return json({ error: msg }, 500);
  }
}
