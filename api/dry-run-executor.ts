// Vercel Function (Node runtime) for the Dry-Run Executor demo page. Read-only: simulates on Atlantic, never signs or sends.
// Actions by query string (no rewrite): ?action=info · ?action=run&scenario=… — see tasks/dry-run-executor/web.ts.
import { handle } from "../tasks/dry-run-executor/web.js";

export const config = { maxDuration: 60 };
export const GET = handle;
