// Vercel Function (Node runtime) for the Trend Watcher demo page: read-only replays and samples, routed by ?action= (see tasks/trend-watcher/web.ts).
import { handle } from "../tasks/trend-watcher/web.js";

export const GET = (req: Request) => handle(req);
