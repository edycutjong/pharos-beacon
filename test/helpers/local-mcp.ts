// A local Streamable-HTTP MCP server for tests: the real SDK client and transport talk to it over a real socket.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

export type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any };
/** The live docs server answers every POST as text/event-stream, so "sse" mirrors it and "json" is the plain variant. */
export type Mode = "json" | "sse";
export interface ToolReply {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface Local {
  url: string;
  /** Every JSON-RPC message received, in order, including ones an `intercept` failed or stalled. */
  rpcs: Rpc[];
  /** Every HTTP request: method, session header, and the status it got (once answered). */
  requests: { method: string; session?: string; status?: number }[];
  /** Responses not yet finished (a stalled request stays here until the client gives up). */
  open: Set<ServerResponse>;
  /** Live session ids, with `sessions: true`. Clear it to make the server forget them, like a deploy would. */
  sessions: Set<string>;
  close(): Promise<void>;
}

export interface LocalOptions {
  /** Like the hosted Chain MCP: an mcp-session-id at initialize, 404 for an unknown one afterwards, DELETE ends it. */
  sessions?: boolean;
  serverInfo?: { name: string; version: string };
  tools?: { name: string; description?: string }[];
  /** Return true when it has handled (failed or stalled) the request itself. */
  intercept?: (rpc: Rpc, res: ServerResponse) => boolean;
  /** Answer this request normally, but only after this many ms. */
  delay?: (rpc: Rpc) => number;
  tool?: (name: string, args: any) => ToolReply;
}

const started: Local[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((l) => l.close()));
});

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

export async function startLocal(mode: Mode, opts: LocalOptions = {}): Promise<Local> {
  const rpcs: Rpc[] = [];
  const requests: Local["requests"] = [];
  const open = new Set<ServerResponse>();
  const sessions = new Set<string>();
  let nextSession = 1;
  const server = createServer(async (req, res) => {
    const session = req.headers["mcp-session-id"] as string | undefined;
    const entry: Local["requests"][number] = { method: req.method ?? "", ...(session ? { session } : {}) };
    requests.push(entry);
    res.on("finish", () => (entry.status = res.statusCode));
    if (req.method === "DELETE" && opts.sessions) {
      const known = !!session && sessions.delete(session);
      return void res.writeHead(known ? 200 : 404).end();
    }
    if (req.method !== "POST") return void res.writeHead(405).end(); // no server-initiated stream, like the real servers
    const rpc = JSON.parse(await readBody(req)) as Rpc;
    rpcs.push(rpc);
    open.add(res);
    res.on("close", () => open.delete(res));
    const headers: Record<string, string> = {};
    if (opts.sessions) {
      if (rpc.method === "initialize") sessions.add((headers["mcp-session-id"] = `s${nextSession++}`));
      else if (!session || !sessions.has(session)) {
        return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unknown MCP session" }));
      }
    }
    if (opts.intercept?.(rpc, res)) return;
    const reply = (result: unknown) => {
      const message = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
      const send = () => {
        if (res.writableEnded || res.destroyed) return;
        if (mode === "sse") res.writeHead(200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" }).end(`event: message\ndata: ${message}\n\n`);
        else res.writeHead(200, { ...headers, "content-type": "application/json" }).end(message);
      };
      const ms = opts.delay?.(rpc) ?? 0;
      if (ms > 0) setTimeout(send, ms);
      else send();
    };
    switch (rpc.method) {
      case "initialize":
        return reply({
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: opts.serverInfo ?? { name: "local-docs", version: "0.0.1" },
        });
      case "tools/list":
        return reply({ tools: (opts.tools ?? [{ name: "searchDocumentation", description: "Search" }]).map((t) => ({ ...t, inputSchema: { type: "object" } })) });
      case "tools/call":
        return reply(opts.tool?.(rpc.params.name, rpc.params.arguments) ?? { content: [] });
      default:
        return void res.writeHead(202, headers).end(); // notifications/initialized
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const local: Local = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    rpcs,
    requests,
    open,
    sessions,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  started.push(local);
  return local;
}

/** A sleep that returns at once and records what it was asked to wait. */
export const sleeps = () => {
  const waited: number[] = [];
  return { waited, sleep: async (ms: number) => void waited.push(ms) };
};
