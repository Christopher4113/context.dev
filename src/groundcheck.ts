import { answers, Credits, highlights, type Highlights } from "./context.ts";
import { flatten, label, templateClaim } from "./flatten.ts";
import { claimLLM, defaultLLM, judge, phraseClaims, suggestShape, VERDICTS, type Citation, type LLM, type Verdict } from "./judge.ts";

export { Credits } from "./context.ts";
export type { Verdict } from "./judge.ts";

export type FieldCitation = Citation & {
  claim: string;
  value: string | number | boolean;
  label: string;
  passages: Highlights[];
};

/** What became of each link Answers returned. */
export type SourceStatus = "verified" | "partial" | "no_support" | "blocked" | "not_checked";
export type SourceReport = { url: string; status: SourceStatus; supports: string[]; partially_supports: string[]; error?: string };

export type GroundcheckResult = {
  question: string;
  json_format: Record<string, unknown>;
  json_content: Record<string, unknown>;
  sources: string[];
  partial?: boolean;
  request_id: string;
  citations: Record<string, FieldCitation>;
  source_report: SourceReport[];
  summary: { fields: number } & Record<Verdict, number>;
  credits_used: number;
};

export type GroundcheckEvent =
  | { type: "shape"; json_format: Record<string, unknown> }
  | { type: "answer"; json_content: Record<string, unknown>; sources: string[]; fields: { path: string; label: string; claim: string }[] }
  | { type: "field"; path: string; citation: FieldCitation; source_report: SourceReport[] }
  | { type: "done"; result: GroundcheckResult };

export type Options = {
  maxSourcesPerClaim?: number;
  credits?: Credits;
  llm?: LLM;
  concurrency?: number;
  onEvent?: (e: GroundcheckEvent) => void;
};

/** Run `fn` over `items` with at most `n` in flight. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// Personal profiles (blocked for scraping in the benchmark) and social feeds (posts, rarely the fact itself).
const SOCIAL_HOSTS = /(^|\.)(x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|youtube\.com)$/;
const isProfile = (u: URL) => SOCIAL_HOSTS.test(u.hostname) || (/(^|\.)linkedin\.com$/.test(u.hostname) && u.pathname.startsWith("/in/"));

// Question words that are also site names (about.me) and must not count as "the entity asked about".
// ponytail: tiny stopword list and name matching; an entity resolver would do this properly.
const STOP = new Set(["about", "what", "which", "when", "where", "does", "latest", "current", "company", "facts", "price", "pricing", "plan", "plans", "news", "blog", "docs", "help"]);

/** Names in the question, single words and adjacent pairs, so "Y Combinator" also matches ycombinator.com. */
function names(question: string): Set<string> {
  const words = question.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const all = [...words, ...words.slice(1).map((w, i) => words[i] + w)];
  return new Set(all.filter((w) => w.length >= 3 && !STOP.has(w)));
}

/**
 * Check the entity's own site first (anthropic.com for a question about Anthropic), then other pages in Answers' order,
 * then personal profiles and social feeds. Only the first few sources are scraped per claim, so order decides what gets verified.
 */
export function rankSources(urls: string[], question = ""): string[] {
  const http = [...new Set(urls)].filter((u) => URL.canParse(u) && /^https?:\/\//.test(u));
  const wanted = names(question);
  const tier = (s: string) => {
    const u = new URL(s);
    if (isProfile(u)) return 2;
    const site = u.hostname.replace(/^www\./, "").split(".").slice(-2)[0];
    return wanted.has(site) ? 0 : 1;
  };
  return http.map((u, i) => ({ u, i, t: tier(u) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.u);
}

/** Every source Answers returned, with the fields it backs. Links past the per-claim cap are `not_checked`. */
export function sourceReport(all: string[], checked: string[], citations: Record<string, FieldCitation>): SourceReport[] {
  return [...new Set(all)].map((url) => {
    if (!checked.includes(url)) return { url, status: "not_checked", supports: [], partially_supports: [] };
    const cs = Object.entries(citations);
    const supports = cs.filter(([, c]) => c.source === url && c.verdict === "supported").map(([p]) => p);
    const partially_supports = cs.filter(([, c]) => c.source === url && c.verdict === "partial").map(([p]) => p);
    const scrapes = cs.flatMap(([, c]) => c.passages.filter((h) => h.url === url));
    const error = scrapes.find((h) => h.error)?.error;
    const read = scrapes.some((h) => h.passages.length);
    const status: SourceStatus = supports.length ? "verified" : partially_supports.length ? "partial" : !read && error ? "blocked" : "no_support";
    return { url, status, supports, partially_supports, ...(error ? { error } : {}) };
  });
}

/** `schema` is the Answers json_format; leave it out and one is drafted from the question. */
export async function groundcheck(question: string, schema?: Record<string, unknown>, opts: Options = {}): Promise<GroundcheckResult> {
  const { maxSourcesPerClaim = 3, credits = new Credits(), concurrency = 4, onEvent } = opts;
  const llm = opts.llm ?? defaultLLM();
  const phraser = opts.llm ?? claimLLM();
  const startCredits = credits.used;

  // 0. Shape (only when none was given)
  const json_format = schema && Object.keys(schema).length ? schema : await suggestShape(phraser, question);
  if (json_format !== schema) onEvent?.({ type: "shape", json_format });

  // 1. Ask
  const { data: answer } = await answers(question, json_format, credits);
  const root = answer.json_content;

  // 2. Flatten into claims
  const leaves = flatten(root);
  const labelled = leaves.map((l) => ({ ...l, label: label(root, l.path) }));
  const phrased = leaves.length ? await phraseClaims(phraser, question, labelled) : new Map<string, string>();
  const fields = labelled.map((l) => ({ ...l, claim: phrased.get(l.path) ?? templateClaim(root, l) }));
  const sources = rankSources(answer.sources, question).slice(0, maxSourcesPerClaim);
  onEvent?.({ type: "answer", json_content: root, sources: answer.sources, fields: fields.map(({ path, label, claim }) => ({ path, label, claim })) });

  // 3 + 4. Gather evidence per claim, then judge it
  const citations: Record<string, FieldCitation> = {};
  await pool(fields, concurrency, async (f) => {
    const passages = await Promise.all(sources.map((url) => highlights(url, f.claim, credits)));
    const c = await judge(llm, question, f.claim, f.value, passages);
    citations[f.path] = { ...c, claim: f.claim, value: f.value, label: f.label, passages };
    onEvent?.({ type: "field", path: f.path, citation: citations[f.path], source_report: sourceReport(answer.sources, sources, citations) });
  });

  // 5. Per-field citation map, in field order
  const ordered = Object.fromEntries(fields.map((f) => [f.path, citations[f.path]]));
  const summary = { fields: fields.length, ...Object.fromEntries(VERDICTS.map((v) => [v, 0])) } as GroundcheckResult["summary"];
  for (const c of Object.values(ordered)) summary[c.verdict]++;

  const result: GroundcheckResult = {
    question,
    json_format,
    json_content: root,
    sources: answer.sources,
    ...(answer.partial ? { partial: true } : {}),
    request_id: answer.request_id,
    citations: ordered,
    source_report: sourceReport(answer.sources, sources, ordered),
    summary,
    credits_used: credits.used - startCredits,
  };
  onEvent?.({ type: "done", result });
  return result;
}
