// Vercel Function (Node runtime) for the Batch Executor demo page: read-only batch simulation, routed by ?action= (see tasks/batch-executor/web.ts).
import { handle } from "../tasks/batch-executor/web.js";

export const GET = (req: Request) => handle(req);
