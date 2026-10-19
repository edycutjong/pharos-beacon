// Vercel Function (Node runtime) for the Gas Fee Optimizer demo page. Read-only: samples Atlantic gas and runs the hold
// loop up to its decision; it never signs or sends. ?action=info · sample · hold — see tasks/gas-fee-optimizer/web.ts.
import { handle } from "../tasks/gas-fee-optimizer/web.js";

export const config = { maxDuration: 60 };
export const GET = handle;
