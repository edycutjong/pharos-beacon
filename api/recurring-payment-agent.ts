// Vercel Function (Node runtime) for the Recurring Payment Agent demo page: read-only status and simulation, routed by ?action= (see tasks/recurring-payment-agent/web.ts).
import { handle } from "../tasks/recurring-payment-agent/web.js";

export const GET = (req: Request) => handle(req);
