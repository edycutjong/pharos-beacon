// One router for the whole API, Request → Response, so the Vercel Function (api/x402-paywalled-api.ts) and the local server
// (`npm run x402-paywalled-api -- serve`) run the same code. Paths, under /api/x402-paywalled-api/:
//   GET  health                  free
//   GET  gas-snapshot            0.001 USDC        GET whale-brief   0.01 USDC
//   GET  whale-range?blocks=N    quoted: 0.005 USDC per started 1,000 blocks (1–3 windows); GET quote?blocks=N is the free price check
//   POST verify · POST settle · GET supported      our facilitator
//   GET  demo-run?scenario=a|b|under|replay|free   a server-side demo buyer, streamed as NDJSON
//   GET  runs                    the last 10 payments, read from the chain
import { X402_USDC } from "../../src/lib/networks.js";
import { runScenario, isScenario, SCENARIOS, type RunEvent } from "./buyer.js";
import { BASE_PATH, FREE_ROUTES, NETWORK, PAID_ROUTES, QUOTE, isPaidRoute, parseBlocks, quoteFor, usdc } from "./config.js";
import { gasSnapshot, whaleBrief } from "./data.js";
import { createFacilitator, facilitatorRoute, type Facilitator } from "./facilitator.js";
import { createPaywall, jsonResponse } from "./resource.js";
import { recentPayments, rpcLogSource } from "./runs.js";
import { addressOf, buyerKey, checkUsdcSetting, facilitatorKey, payTo, publicBaseUrl } from "./settings.js";

/** A paid demo run at most every PAID_RUN_GAP_MS, per server instance (best effort: Vercel may run several instances). */
export const PAID_RUN_GAP_MS = 10_000;

export interface RateGate {
  /** ms to wait, or 0 and the slot is taken. */
  take(now: number): number;
  release(): void;
}

export function rateGate(gapMs = PAID_RUN_GAP_MS): RateGate {
  let last = -Infinity;
  let busy = false;
  return {
    take(now) {
      if (busy) return gapMs;
      const wait = last + gapMs - now;
      if (wait > 0) return wait;
      last = now;
      busy = true;
      return 0;
    },
    release() {
      busy = false;
    },
  };
}

const gate = rateGate();
let facilitator: Facilitator | undefined;
let paywall: ReturnType<typeof createPaywall> | undefined;
let paywallFor: string | undefined;
let runsCache: { at: number; body: unknown } | undefined;

/** Headers that let this deployment call itself through Vercel's deployment protection (preview URLs). */
function selfHeaders(): Record<string, string> {
  const s = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return s ? { "x-vercel-protection-bypass": s } : {};
}

/** The route name: the `path` query a rewrite adds, else the path after BASE_PATH. */
export function routeName(url: URL): string {
  const q = url.searchParams.get("path");
  if (q) return q.replace(/^\/+|\/+$/g, "");
  return url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length).replace(/^\/+|\/+$/g, "") : "";
}

function getFacilitator(): Facilitator {
  facilitator ??= createFacilitator(facilitatorKey(), payTo());
  return facilitator;
}

function getPaywall(origin: string) {
  if (!paywall || paywallFor !== origin) {
    paywall = createPaywall({ payTo: payTo(), facilitatorUrl: `${origin}${BASE_PATH}`, facilitatorHeaders: selfHeaders(), publicBase: publicBaseUrl(origin) });
    paywallFor = origin;
  }
  return paywall;
}

function deployInfo() {
  return {
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    env: process.env.VERCEL_ENV ?? "local",
    region: process.env.VERCEL_REGION ?? null,
  };
}

function health(origin: string) {
  return {
    status: "ok",
    network: NETWORK,
    asset: { symbol: "USDC (test)", address: X402_USDC.address, decimals: X402_USDC.decimals, eip712: { name: X402_USDC.name, version: X402_USDC.version } },
    payTo: payTo(),
    facilitator: { url: `${publicBaseUrl(origin)}${BASE_PATH}`, endpoints: ["POST verify", "POST settle", "GET supported"], signer: getFacilitator().address },
    routes: {
      free: FREE_ROUTES.map((r) => `GET ${BASE_PATH}/${r}`),
      paid: Object.entries(PAID_ROUTES).map(([name, r]) => ({ route: `GET ${BASE_PATH}/${name}`, price: usdc(r.amount), amount: r.amount.toString(), description: r.description })),
    },
    demo: { scenarios: SCENARIOS, buyer: safeBuyer() },
    deploy: deployInfo(),
  };
}

/** GET quote?blocks=N: the price of whale-range for N blocks, free, so a buyer can decide before it asks for the 402. */
function quote(url: URL): Response {
  const parsed = parseBlocks(url.searchParams.get("blocks"));
  if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
  const q = quoteFor(parsed.blocks);
  return jsonResponse({ route: `GET ${BASE_PATH}/${QUOTE.route}?blocks=${q.blocks}`, blocks: q.blocks, windows: q.windows, perWindow: usdc(QUOTE.perWindow), price: usdc(q.amount), amount: q.amount.toString(), rule: `${usdc(QUOTE.perWindow)} per started ${QUOTE.window} blocks, 1 to ${QUOTE.maxWindows} windows` });
}

function safeBuyer(): string | null {
  try {
    return addressOf(buyerKey());
  } catch {
    return null;
  }
}

function demoRun(req: Request, url: URL, origin: string): Response {
  const scenario = url.searchParams.get("scenario") ?? "a";
  if (!isScenario(scenario)) return jsonResponse({ error: `scenario must be one of ${SCENARIOS.join(", ")}` }, 400);
  const gated = scenario !== "free";
  if (gated) {
    const wait = gate.take(Date.now());
    if (wait > 0) {
      const s = Math.ceil(wait / 1000);
      return jsonResponse({ error: `one paid demo run every ${PAID_RUN_GAP_MS / 1000} s; try again in ${s} s`, retryAfterSeconds: s }, 429, { "retry-after": String(s) });
    }
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: RunEvent) => controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`));
      try {
        await runScenario({ base: origin, scenario, key: buyerKey(), emit, headers: selfHeaders() });
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      } finally {
        if (gated) gate.release();
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

async function runs(): Promise<Response> {
  if (runsCache && Date.now() - runsCache.at < 15_000) return jsonResponse(runsCache.body);
  let found;
  try {
    found = await recentPayments(rpcLogSource(), payTo());
  } catch (e) {
    // viem's message carries the whole request; the first line (and the RPC's own reason) is enough.
    const m = (e as Error).message;
    const detail = /Details: (.*)/.exec(m)?.[1];
    return jsonResponse({ error: `could not read the payments from Atlantic: ${detail ?? m.split("\n")[0]}` }, 503, { "retry-after": "10" });
  }
  const body = { ...found, readAt: new Date().toISOString(), source: "USDC Transfer logs to the payee, Atlantic eth_getLogs" };
  runsCache = { at: Date.now(), body };
  return jsonResponse(body);
}

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const name = routeName(url);
  try {
    checkUsdcSetting();
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "PAYMENT-SIGNATURE, X-PAYMENT, content-type", "access-control-allow-methods": "GET, POST" } });
    if (name === "verify" || name === "settle" || name === "supported") return await facilitatorRoute(getFacilitator(), name, req);
    if (req.method !== "GET") return jsonResponse({ error: "use GET" }, 405);
    if (name === "health") return jsonResponse(health(origin));
    if (name === "demo-run") return demoRun(req, url, origin);
    if (name === "runs") return await runs();
    if (name === "quote") return quote(url);
    if (isPaidRoute(name)) {
      let blocks = 1_000;
      if (name === QUOTE.route) {
        // A bad ?blocks= is refused before any 402, so nobody signs a payment for a request that cannot be served.
        const parsed = parseBlocks(url.searchParams.get("blocks"));
        if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
        blocks = parsed.blocks;
      }
      return await getPaywall(origin)(name, req, name === "gas-snapshot" ? gasSnapshot : () => whaleBrief(undefined, blocks));
    }
    return jsonResponse({ error: `no route ${JSON.stringify(name)}`, routes: ["health", "quote", ...Object.keys(PAID_ROUTES), "verify", "settle", "supported", "demo-run", "runs"] }, 404);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
}
