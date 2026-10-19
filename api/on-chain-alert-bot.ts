// Vercel Function (Node runtime) for the On-Chain Alert Bot demo page. Actions by query string (?action=health|run|blocktimes);
// the logic lives in tasks/on-chain-alert-bot/web.ts and runs the bot's own rules and watcher. Read-only, posts nowhere.
import { handle } from "../tasks/on-chain-alert-bot/web.js";

export const GET = handle;
