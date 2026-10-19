// Vercel Function (Node runtime) for the Event/Log Monitor demo page. Actions by query string (?action=health|run), so no
// rewrite is needed; the logic lives in tasks/event-log-monitor/web.ts and runs the CLI's own watcher. Read-only.
import { handle } from "../tasks/event-log-monitor/web.js";

export const GET = handle;
