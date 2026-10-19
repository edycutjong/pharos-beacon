// Vercel Function (Node runtime) for the Docs MCP Onboarding demo page. Actions by query string
// (?action=health|recheck|first-read); the logic lives in tasks/docs-mcp-onboarding/web.ts. Read-only, keyless.
import { handle } from "../tasks/docs-mcp-onboarding/web.js";

export const GET = handle;
