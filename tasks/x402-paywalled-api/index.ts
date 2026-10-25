// x402 Paywalled API (Medium · 100 pts): an API on Pharos Atlantic that charges per request in test USDC, with its own facilitator.
//   npm run x402-paywalled-api -- pay a|b|under|replay|free|quote [--base https://pharos.edycu.dev] [--json] [--proof name]
//   npm run x402-paywalled-api -- serve [--port 4021]      (the same API locally; then pay with --base http://localhost:4021)
// The deployed API is the Vercel Function api/router.ts, which runs app.ts like `serve` does.
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { atlantic } from "../../src/lib/networks.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { handle } from "./app.js";
import { SCENARIOS, runScenario, type RunEvent } from "./buyer.js";
import { buyerKey, setting } from "./settings.js";

const TASK = "x402-paywalled-api";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const USAGE = "x402-paywalled-api pay a|b|under|replay|free|quote [--base URL] [--json] [--proof name] | serve [--port 4021]";
const DEFAULT_BASE = "https://pharos.edycu.dev";

const MARK: Record<string, string> = { ok: "✓", refused: "402", failed: "✗", skip: "·" };

/** One terminal line per event. */
export function formatEvent(e: RunEvent): string | undefined {
  switch (e.type) {
    case "start":
      return `${e.route}${e.price ? ` · ${e.price} · payer ${e.payer}` : " · free"}\n  ${e.url}`;
    case "step":
      return e.state === "skip" ? undefined : `  ${MARK[e.state]!.padEnd(4)}${e.id.padEnd(7)} ${e.label}${e.ms ? `  (${e.ms} ms)` : ""}`;
    case "error":
      return `  error: ${e.message}`;
    case "done": {
      const out = [`${e.outcome.toUpperCase()} in ${e.totalMs} ms: ${e.summary}`];
      if (e.tx) out.push(`  settle tx ${e.explorer} (block ${e.block})`);
      if (e.receipt) out.push(`  receipt check: ${e.receipt.reason}`);
      if (e.data && e.outcome !== "refused") out.push(`  data: ${JSON.stringify(e.data)}`);
      return out.join("\n");
    }
  }
}

/** Node http ⇄ Request/Response, for `serve`. */
function serve(port: number, ctx: RunContext): Promise<number> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v] as [string, string]])),
      ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
    });
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(port, () => console.log(`x402 Paywalled API on http://localhost:${port}/api/x402-paywalled-api/health (Ctrl-C to stop)`));
    ctx.onExit(() => new Promise((r) => server.close(() => r(undefined))));
    ctx.signal.addEventListener("abort", () => resolve(0));
  });
}

export async function main(ctx: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    { usage: USAGE, positionals: [1, 2], options: { base: { type: "string" }, port: { type: "string" }, json: { type: "boolean", default: false }, proof: { type: "string" } } },
    argv,
  );
  const [cmd, arg] = positionals;
  if (cmd === "serve") {
    const port = Number(values.port ?? 4021);
    if (!Number.isInteger(port) || port <= 0) throw new UsageError(`--port must be a port number\nusage: ${USAGE}`);
    return serve(port, ctx);
  }
  if (cmd !== "pay") throw new UsageError(`unknown command ${JSON.stringify(cmd)}\nusage: ${USAGE}`);
  const scenario = choice("scenario", arg, SCENARIOS);
  const base = values.base ?? setting("PUBLIC_BASE_URL") ?? DEFAULT_BASE;
  const events: RunEvent[] = [];
  const done = await runScenario({
    base,
    scenario,
    key: buyerKey(),
    emit: (e) => {
      events.push(e);
      const line = values.json ? JSON.stringify(e) : formatEvent(e);
      if (line) console.log(line);
    },
  });
  if (values.proof) {
    const meta = proofMeta(TASK, { network: "atlantic", chainId: atlantic.id, endpoint: `${new URL(base).origin} (x402 API) + Atlantic RPC (receipt check)` });
    console.log(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), { scenario, base: new URL(base).origin, events }, meta)}`);
  }
  // Exit codes: 0 = the scenario showed what it should (paid / refused for under / free), 1 = anything else.
  const expected = scenario === "under" ? "refused" : scenario === "free" ? "free" : "paid";
  return done.outcome === expected ? 0 : 1;
}

if (isMain(import.meta.url)) await runCli(main);
