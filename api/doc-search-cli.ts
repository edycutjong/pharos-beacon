// Vercel Function (Node runtime) for the Doc-Search CLI demo page. Actions by query string (?action=health|ask); the logic
// lives in tasks/doc-search-cli/web.ts and runs the CLI's own search() and format() against the hosted Docs MCP.
import { handle } from "../tasks/doc-search-cli/web.js";

export const GET = handle;
