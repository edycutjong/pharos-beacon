// The resource server: the paid routes behind x402. Built on the SDK's x402HTTPResourceServer with a small Request → Response
// adapter (the same flow as @x402/hono's middleware: verify → run the handler → settle → 200 with PAYMENT-RESPONSE).
// It talks to OUR facilitator over HTTP (HTTPFacilitatorClient), and reports how long verify and settle took in Server-Timing.
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type HTTPAdapter, type HTTPRequestContext, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Hex } from "viem";
import { BASE_PATH, MAX_TIMEOUT_SECONDS, NETWORK, PAID_ROUTES, plainWords, priceOf, usdc, type PaidRouteName } from "./config.js";

export type Handler = () => Promise<unknown>;

/** Request → the adapter the SDK reads. The Accept header is pinned to JSON so a browser gets the 402 JSON, not a paywall page. */
class RequestAdapter implements HTTPAdapter {
  private readonly url: URL;
  constructor(private readonly req: Request) {
    this.url = new URL(req.url);
  }
  getHeader = (name: string) => this.req.headers.get(name) ?? undefined;
  getMethod = () => this.req.method;
  getPath = () => this.url.pathname;
  getUrl = () => this.req.url;
  getAcceptHeader = () => "application/json";
  getUserAgent = () => this.req.headers.get("user-agent") ?? "";
  getQueryParams = () => Object.fromEntries(this.url.searchParams);
  getQueryParam = (name: string) => this.url.searchParams.get(name) ?? undefined;
}

export interface PaywallOptions {
  payTo: Hex;
  /** Our facilitator's base URL, e.g. https://…/api/x402-paywalled-api (verify, settle and supported live under it). */
  facilitatorUrl: string;
  /** Extra headers for calls to the facilitator (a Vercel protection bypass on preview deploys). */
  facilitatorHeaders?: Record<string, string>;
  /** Public origin, for the 402's resource URL. */
  publicBase: string;
}

/** The body of every 402: the SDK's reason plus the price, asset and payee in plain words. */
export function paymentRequiredBody(name: PaidRouteName, payTo: string, reason: string | undefined) {
  return {
    status: 402,
    reason: reason ?? "Payment required",
    message: plainWords(name, payTo),
    price: usdc(PAID_ROUTES[name].amount),
    amount: PAID_ROUTES[name].amount.toString(),
    network: NETWORK,
    payTo,
  };
}

export function createPaywall(o: PaywallOptions) {
  const headers = o.facilitatorHeaders ?? {};
  const client = new HTTPFacilitatorClient({
    url: o.facilitatorUrl,
    timeoutMs: 50_000,
    createAuthHeaders: async () => ({ verify: headers, settle: headers, supported: headers }),
  });
  const server = new x402ResourceServer(client).register(NETWORK, new ExactEvmScheme());
  const routes: RoutesConfig = Object.fromEntries(
    (Object.keys(PAID_ROUTES) as PaidRouteName[]).map((name) => [
      `GET ${BASE_PATH}/${name}`,
      {
        accepts: { scheme: "exact", network: NETWORK, payTo: o.payTo, price: priceOf(name), maxTimeoutSeconds: MAX_TIMEOUT_SECONDS },
        resource: `${o.publicBase}${BASE_PATH}/${name}`,
        description: PAID_ROUTES[name].description,
        mimeType: "application/json",
        unpaidResponseBody: async () => ({ contentType: "application/json", body: paymentRequiredBody(name, o.payTo, "Payment required") }),
      },
    ]),
  );
  const http = new x402HTTPResourceServer(server, routes);
  let ready: Promise<void> | undefined;

  /** Serve a paid route: 402 until a valid payment arrives, then run `handler`, settle, and answer 200 with PAYMENT-RESPONSE. */
  return async function paid(name: PaidRouteName, req: Request, handler: Handler): Promise<Response> {
    const timing: string[] = [];
    const t = performance.now();
    const adapter = new RequestAdapter(req);
    const ctx: HTTPRequestContext = {
      adapter,
      path: adapter.getPath(),
      method: req.method,
      paymentHeader: adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment"),
    };
    try {
      ready ??= http.initialize().catch((e: unknown) => {
        ready = undefined;
        throw e;
      });
      await ready;
    } catch (e) {
      return jsonResponse({ error: `facilitator unreachable: ${(e as Error).message}` }, 502);
    }
    const result = await http.processHTTPRequest(ctx);
    const verifyMs = performance.now() - t;
    if (result.type === "no-payment-required") return jsonResponse(await handler(), 200);
    if (result.type === "payment-error") {
      const { status, headers: h } = result.response;
      let reason: string | undefined;
      try {
        const pr = h["PAYMENT-REQUIRED"] ?? h["payment-required"];
        reason = pr ? decodePaymentRequiredHeader(pr).error : undefined;
      } catch {
        reason = undefined;
      }
      if (ctx.paymentHeader) timing.push(`verify;dur=${verifyMs.toFixed(0)};desc="facilitator /verify"`);
      const body = status === 402 ? paymentRequiredBody(name, o.payTo, reason) : result.response.body;
      return jsonResponse(body, status, { ...h, ...(timing.length ? { "Server-Timing": timing.join(", ") } : {}) });
    }
    timing.push(`verify;dur=${verifyMs.toFixed(0)};desc="facilitator /verify"`);
    // Verified: run the handler. If it fails, nothing is settled (the payer keeps their money).
    const h0 = performance.now();
    let data: unknown;
    try {
      data = await handler();
    } catch (e) {
      await result.cancellationDispatcher.cancel({ reason: "handler_threw", error: e }).catch(() => undefined);
      return jsonResponse({ error: `the route failed before settling, nothing was charged: ${(e as Error).message}` }, 500);
    }
    timing.push(`data;dur=${(performance.now() - h0).toFixed(0)};desc="route handler"`);
    const body = Buffer.from(JSON.stringify(data));
    const s0 = performance.now();
    const settled = await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, {
      request: ctx,
      responseBody: body,
      responseHeaders: { "content-type": "application/json" },
    });
    timing.push(`settle;dur=${(performance.now() - s0).toFixed(0)};desc="facilitator /settle"`);
    if (!settled.success) {
      const r = settled.response;
      const out = r.status === 402 ? paymentRequiredBody(name, o.payTo, settled.errorReason) : r.body;
      return jsonResponse(out, r.status, { ...r.headers, "Server-Timing": timing.join(", ") });
    }
    return new Response(body, {
      status: 200,
      headers: mergeHeaders(settled.headers, { "content-type": "application/json", "cache-control": "private, no-store", "access-control-expose-headers": EXPOSED_HEADERS, "Server-Timing": timing.join(", ") }),
    });
  };
}

export const EXPOSED_HEADERS = "PAYMENT-REQUIRED, PAYMENT-RESPONSE, Server-Timing";

/** Merge header sets case-insensitively, later sets winning (the SDK sends "Content-Type", we send "content-type"). */
export function mergeHeaders(...sets: Record<string, string>[]): Headers {
  const h = new Headers();
  for (const set of sets) for (const [k, v] of Object.entries(set)) h.set(k, v);
  return h;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const base = { "content-type": "application/json", "cache-control": "no-store", "access-control-expose-headers": EXPOSED_HEADERS };
  return new Response(JSON.stringify(body ?? {}), { status, headers: mergeHeaders(headers, base) });
}

/** Server-Timing → { verify: 132, settle: 1840, … } (ms). */
export function parseServerTiming(h: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (h ?? "").split(",")) {
    const name = part.trim().split(";")[0];
    const dur = /dur=([\d.]+)/.exec(part)?.[1];
    if (name && dur) out[name] = Number(dur);
  }
  return out;
}
