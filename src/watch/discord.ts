import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envOr } from "../lib/env.js";
import { wait } from "../lib/net.js";

// Delivery to a Discord channel through an incoming webhook. The webhook URL is a credential: it is read at run time
// from DISCORD_WEBHOOK_URL or ~/.config/discord/webhook-alerts, validated, and never printed, logged or put in an error.

export interface Delivered {
  /** Discord's message id (the webhook is called with ?wait=true so the message comes back); none for the console. */
  id?: string;
  timestamp: string;
  content: string;
}

export interface Notifier {
  name: string;
  send(text: string): Promise<Delivered>;
}

const HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);

export function webhookUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("the Discord webhook is not a URL");
  }
  if (u.protocol !== "https:" || !HOSTS.has(u.hostname) || !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(u.pathname)) {
    throw new Error("the Discord webhook must look like https://discord.com/api/webhooks/<id>/<token>");
  }
  return u;
}

/** From DISCORD_WEBHOOK_URL, else the file (default ~/.config/discord/webhook-alerts). */
export function loadWebhook(file = join(homedir(), ".config/discord/webhook-alerts")): URL {
  const fromEnv = envOr("DISCORD_WEBHOOK_URL", "");
  if (fromEnv) return webhookUrl(fromEnv);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`no Discord webhook: set DISCORD_WEBHOOK_URL or put the URL in ${file.replace(homedir(), "~")}`);
  }
  return webhookUrl(text);
}

export function consoleNotifier(print: (s: string) => void = console.log): Notifier {
  return {
    name: "console",
    async send(text) {
      print(text);
      return { timestamp: new Date().toISOString(), content: text };
    },
  };
}

export function discordNotifier(hook: URL, opts: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): Notifier {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? wait;
  const url = new URL(hook);
  url.searchParams.set("wait", "true");
  return {
    name: "discord",
    async send(text) {
      const body = JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] }, flags: 4 }); // flags 4 = no link embed clutter
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
        } catch (e) {
          if (attempt >= 2) throw new Error(`Discord delivery failed: ${(e as { cause?: { code?: string } }).cause?.code ?? "network error"}`);
          await sleep(500 * 3 ** attempt);
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= 3) throw new Error(`Discord delivery failed: HTTP ${res.status} after ${attempt + 1} tries`);
          const retry = Number((await res.json().catch(() => ({})) as { retry_after?: number }).retry_after);
          await sleep(Number.isFinite(retry) && retry > 0 ? Math.ceil(retry * 1000) : 500 * 3 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`Discord delivery failed: HTTP ${res.status}`);
        const m = (await res.json()) as { id?: string; timestamp?: string; content?: string };
        if (!m.id) throw new Error("Discord accepted the message but returned no message id");
        return { id: m.id, timestamp: m.timestamp ?? new Date().toISOString(), content: m.content ?? text };
      }
    },
  };
}
