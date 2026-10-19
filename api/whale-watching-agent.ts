// Vercel Function (Node runtime) for the Whale-Watching Agent demo page: read-only, Pacific mainnet. Routes by ?action= (see tasks/whale-watching-agent/web.ts).
import { handle } from "../tasks/whale-watching-agent/web.js";

export const GET = (req: Request) => handle(req);
