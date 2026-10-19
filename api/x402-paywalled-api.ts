// Vercel Function (Node runtime) for the x402 Paywalled API. vercel.json rewrites /api/x402-paywalled-api/<route> here with
// ?path=<route>; the router and every route live in tasks/x402-paywalled-api/app.ts (the same code `npm run x402-paywalled-api -- serve` runs).
import { handle } from "../tasks/x402-paywalled-api/app.js";

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
