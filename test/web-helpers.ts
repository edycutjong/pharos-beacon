// Helpers for the read-only demo endpoint tests (tasks/<task>/web.ts): a fake GitHub raw fetch and an NDJSON reader.
export function fakeRaw(files: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(files).find(([path]) => url.endsWith(`/${path}`));
    return hit ? Response.json(hit[1]) : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export async function events(res: Response): Promise<Record<string, any>[]> {
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export const req = (q: string) => new Request(`http://localhost/api/x?${q}`);
