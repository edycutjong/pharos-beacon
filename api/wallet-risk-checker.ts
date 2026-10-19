// Vercel Function (Node runtime) for the Wallet Risk Checker demo page: read-only checks, routed by ?action= (see tasks/wallet-risk-checker/web.ts).
import { handle } from "../tasks/wallet-risk-checker/web.js";

export const GET = (req: Request) => handle(req);
