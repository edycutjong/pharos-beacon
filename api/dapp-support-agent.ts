// Vercel Function (Node runtime) for the dApp Support Agent demo page. Actions by query string (?action=health|diagnose);
// the logic lives in tasks/dapp-support-agent/web.ts and runs the agent's own diagnose(). Read-only: it never sends.
import { handle } from "../tasks/dapp-support-agent/web.js";

export const GET = handle;
