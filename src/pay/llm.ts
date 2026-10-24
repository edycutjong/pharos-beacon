// A free-tier LLM for the two payment agents. Keys are read at runtime from ~/.config/gemini/credentials.json (never
// printed, never in the tree). The model only EXTRACTS fields from text; everything it says is checked by src/pay/parse.ts
// before it can become a transaction.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LlmJson = (system: string, user: string) => Promise<{ json: unknown; model: string }>;

interface Creds { keys: Array<string | { key: string }>; model?: string }

export function loadGeminiCreds(path = join(homedir(), ".config/gemini/credentials.json")): { keys: string[]; model: string } | undefined {
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as Creds;
    const keys = c.keys.map((k) => (typeof k === "string" ? k : k.key)).filter(Boolean);
    return keys.length ? { keys, model: c.model ?? "gemini-3.5-flash" } : undefined;
  } catch {
    return undefined;
  }
}

/** Gemini REST in JSON mode. Rotates keys and backs off on 429/503. Returns undefined when no key is configured. */
export function geminiJson(opts: { creds?: ReturnType<typeof loadGeminiCreds>; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): LlmJson | undefined {
  const creds = "creds" in opts ? opts.creds : loadGeminiCreds();
  if (!creds) return undefined;
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return async (system, user) => {
    let last = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const key = creds.keys[attempt % creds.keys.length];
      try {
        const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${creds.model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ parts: [{ text: user }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0 },
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const body = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
          return { json: JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")), model: creds.model };
        }
        last = `HTTP ${res.status}`;
        if (res.status !== 429 && res.status !== 503 && res.status < 500) break;
      } catch (e) {
        last = (e as Error).message;
      }
      await sleep(Math.min(20_000, 2_000 * 2 ** attempt));
    }
    throw new Error(`LLM unavailable (${last})`);
  };
}
