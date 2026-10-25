// One Vercel Function for every demo API (the Hobby plan allows 12 functions per deployment; there are 27 demos).
// vercel.json rewrites /api/<slug> and /api/x402-paywalled-api/<route> here with ?slug=<slug>; each task's own handler
// receives the request unchanged and routes by its own query string (?action=, or ?path= for x402).
type Handler = (req: Request) => Response | Promise<Response>;

const routes: Record<string, () => Promise<{ handle: Handler }>> = {
  "arbitrage-scanner": () => import("../tasks/arbitrage-scanner/web.js"),
  "audit-log-agent": () => import("../tasks/audit-log-agent/web.js"),
  "batch-executor": () => import("../tasks/batch-executor/web.js"),
  "dapp-support-agent": () => import("../tasks/dapp-support-agent/web.js"),
  "doc-grounded-builder-agent": () => import("../tasks/doc-grounded-builder-agent/web.js"),
  "doc-search-cli": () => import("../tasks/doc-search-cli/web.js"),
  "docs-chain-mcp-agent": () => import("../tasks/docs-chain-mcp-agent/web.js"),
  "docs-mcp-onboarding": () => import("../tasks/docs-mcp-onboarding/web.js"),
  "dry-run-executor": () => import("../tasks/dry-run-executor/web.js"),
  "event-log-monitor": () => import("../tasks/event-log-monitor/web.js"),
  "gas-fee-optimizer": () => import("../tasks/gas-fee-optimizer/web.js"),
  "invoice-to-payment-agent": () => import("../tasks/invoice-to-payment-agent/web.js"),
  "liquidation-watchdog": () => import("../tasks/liquidation-watchdog/web.js"),
  "multi-protocol-aggregator": () => import("../tasks/multi-protocol-aggregator/web.js"),
  "natural-language-payment-agent": () => import("../tasks/natural-language-payment-agent/web.js"),
  "on-chain-alert-bot": () => import("../tasks/on-chain-alert-bot/web.js"),
  "portfolio-assistant": () => import("../tasks/portfolio-assistant/web.js"),
  "recurring-payment-agent": () => import("../tasks/recurring-payment-agent/web.js"),
  "saga-executor": () => import("../tasks/saga-executor/web.js"),
  "skill-chain-mcp-flow": () => import("../tasks/skill-chain-mcp-flow/web.js"),
  "trend-watcher": () => import("../tasks/trend-watcher/web.js"),
  "wallet-risk-checker": () => import("../tasks/wallet-risk-checker/web.js"),
  "weekly-digest-agent": () => import("../tasks/weekly-digest-agent/web.js"),
  "whale-watching-agent": () => import("../tasks/whale-watching-agent/web.js"),
  "x402-agent-buyer": () => import("../tasks/x402-agent-buyer/web.js"),
  "x402-paywalled-api": () => import("../tasks/x402-paywalled-api/app.js"),
  "yield-optimizer": () => import("../tasks/yield-optimizer/web.js"),
};

async function route(req: Request): Promise<Response> {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  const load = Object.hasOwn(routes, slug) ? routes[slug] : undefined;
  if (!load) return Response.json({ error: `no demo API named "${slug}"` }, { status: 404 });
  return (await load()).handle(req);
}

export const GET = route;
export const POST = route;
export const OPTIONS = route;
