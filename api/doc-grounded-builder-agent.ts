// Vercel Function (Node runtime) for the Doc-Grounded Builder Agent demo page. Plans from the hosted Docs MCP, executes reads
// on chain and prepares (never signs) a send. ?action=info · ?action=run&preset=… — see tasks/doc-grounded-builder-agent/web.ts.
import { handle } from "../tasks/doc-grounded-builder-agent/web.js";

export const config = { maxDuration: 120 };
export const GET = handle;
