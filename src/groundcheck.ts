import { answers, Credits, highlights, type Highlights } from "./context.ts";
import { flatten, label, templateClaim } from "./flatten.ts";
import { defaultLLM, judge, phraseClaims, VERDICTS, type Citation, type LLM, type Verdict } from "./judge.ts";

export { Credits } from "./context.ts";
export type { Verdict } from "./judge.ts";

export type FieldCitation = Citation & {
  claim: string;
  value: string | number | boolean;
  label: string;
  passages: Highlights[];
};

export type GroundcheckResult = {
  question: string;
  json_content: Record<string, unknown>;
  sources: string[];
  partial?: boolean;
  request_id: string;
  citations: Record<string, FieldCitation>;
  summary: { fields: number } & Record<Verdict, number>;
  credits_used: number;
};

export type GroundcheckEvent =
  | { type: "answer"; json_content: Record<string, unknown>; sources: string[]; fields: { path: string; label: string; claim: string }[] }
  | { type: "field"; path: string; citation: FieldCitation }
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

export async function groundcheck(question: string, schema: Record<string, unknown>, opts: Options = {}): Promise<GroundcheckResult> {
  const { maxSourcesPerClaim = 3, credits = new Credits(), concurrency = 4, onEvent } = opts;
  const llm = opts.llm ?? defaultLLM();
  const startCredits = credits.used;

  // 1. Ask
  const { data: answer } = await answers(question, schema, credits);
  const root = answer.json_content;

  // 2. Flatten into claims
  const leaves = flatten(root);
  const labelled = leaves.map((l) => ({ ...l, label: label(root, l.path) }));
  const phrased = leaves.length ? await phraseClaims(llm, question, labelled) : new Map<string, string>();
  const fields = labelled.map((l) => ({ ...l, claim: phrased.get(l.path) ?? templateClaim(root, l) }));
  const sources = [...new Set(answer.sources.filter((u) => /^https?:\/\//.test(u)))].slice(0, maxSourcesPerClaim);
  onEvent?.({ type: "answer", json_content: root, sources: answer.sources, fields: fields.map(({ path, label, claim }) => ({ path, label, claim })) });

  // 3 + 4. Gather evidence per claim, then judge it
  const citations: Record<string, FieldCitation> = {};
  await pool(fields, concurrency, async (f) => {
    const passages = await Promise.all(sources.map((url) => highlights(url, f.claim, credits)));
    const c = await judge(llm, question, f.claim, f.value, passages);
    citations[f.path] = { ...c, claim: f.claim, value: f.value, label: f.label, passages };
    onEvent?.({ type: "field", path: f.path, citation: citations[f.path] });
  });

  // 5. Per-field citation map, in field order
  const ordered = Object.fromEntries(fields.map((f) => [f.path, citations[f.path]]));
  const summary = { fields: fields.length, ...Object.fromEntries(VERDICTS.map((v) => [v, 0])) } as GroundcheckResult["summary"];
  for (const c of Object.values(ordered)) summary[c.verdict]++;

  const result: GroundcheckResult = {
    question,
    json_content: root,
    sources: answer.sources,
    ...(answer.partial ? { partial: true } : {}),
    request_id: answer.request_id,
    citations: ordered,
    summary,
    credits_used: credits.used - startCredits,
  };
  onEvent?.({ type: "done", result });
  return result;
}
