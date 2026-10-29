import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ContextDev from "context.dev";

const CACHE_DIR = process.env.GROUNDCHECK_CACHE_DIR ?? ".cache";

/** Tracks credits spent in this process and refuses to go past the budget. */
export class Credits {
  used = 0;
  constructor(public budget = Infinity) {}
  check() {
    if (this.used >= this.budget) throw new Error(`Credit budget of ${this.budget} reached (used ${this.used}). Stopping.`);
  }
  add(n: number) {
    this.used += n;
  }
}

// ponytail: one JSON file per request, no eviction; delete .cache/ to refresh.
export async function cached<T>(kind: string, request: unknown, fetcher: () => Promise<T>): Promise<{ data: T; hit: boolean }> {
  const key = createHash("sha1").update(JSON.stringify(request)).digest("hex");
  const file = `${CACHE_DIR}/${kind}-${key}.json`;
  try {
    return { data: JSON.parse(await readFile(file, "utf8")).response, hit: true };
  } catch {}
  const data = await fetcher();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify({ request, response: data }, null, 2));
  return { data, hit: false };
}

// Context.dev allows 2 in-flight requests per organization; more come back as 429.
const MAX_IN_FLIGHT = Number(process.env.CONTEXT_DEV_CONCURRENCY ?? 2);
let inFlight = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

let client: ContextDev | undefined;
// Extra retries: 429s from the org concurrency limit clear once in-flight requests finish (SDK honors Retry-After).
const ctx = () => (client ??= new ContextDev({ maxRetries: 6 })); // reads CONTEXT_DEV_API_KEY

/** Prefer the X-Credits-Used header, fall back to key_metadata in the body. */
function creditsOf(response: Response, body: { key_metadata?: { credits_consumed: number } }): number {
  const header = Number(response.headers.get("x-credits-used"));
  return Number.isFinite(header) && response.headers.has("x-credits-used") ? header : (body.key_metadata?.credits_consumed ?? 0);
}

export type AnswersResult = {
  json_content: Record<string, unknown>;
  sources: string[];
  partial?: boolean;
  request_id: string;
};

export async function answers(task: string, json_format: Record<string, unknown>, credits: Credits, mode: "fast" | "ultra" = "fast") {
  const request = { task, json_format, mode };
  return cached("answers", request, async (): Promise<AnswersResult> => {
    credits.check();
    const { data, response } = await limited(() => ctx().web.answers({ ...request, tags: ["groundcheck"] }).withResponse());
    credits.add(creditsOf(response, data));
    return data;
  });
}

export type Highlights = { url: string; passages: string[]; error?: string };

export async function highlights(url: string, query: string, credits: Credits): Promise<Highlights> {
  const request = { url, formats: { highlights: true }, highlightsParams: { query, maxCharacters: 2000 } };
  try {
    const { data } = await cached("highlights", request, async (): Promise<Highlights> => {
      credits.check();
      const { data, response } = await limited(() => ctx().web.scrape(request).withResponse());
      credits.add(creditsOf(response, data));
      const h = data.highlights;
      return { url, passages: h.data ?? [], ...(h.success === false ? { error: h.error_code ?? "HIGHLIGHTS_FAILED" } : {}) };
    });
    return data;
  } catch (e: any) {
    // Auth, credit, and rate-limit errors must stop the run. A bad source URL is a finding, not a crash.
    if (!e?.status || [401, 402, 403, 429].includes(e.status) || e.status >= 500) throw e;
    return { url, passages: [], error: `HTTP_${e.status}` };
  }
}
