import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { cached, type Highlights } from "./context.ts";

export const VERDICTS = ["supported", "partial", "unsupported", "no_evidence"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** A model call that returns JSON text matching `schema`. Claude by default, or any OpenAI-compatible endpoint. */
export type LLM = (system: string, user: string, schema: Record<string, unknown>) => Promise<string>;

const openai = () => process.env.JUDGE_PROVIDER === "openai";

/**
 * Same prompt + model = same answer from disk, so reruns are free and the demo replays instantly.
 * `model` defaults to JUDGE_MODEL, then Claude Opus 5.5.
 */
export function defaultLLM(model = process.env.JUDGE_MODEL ?? (openai() ? "" : "claude-opus-5-5")): LLM {
  const llm = rawLLM(model);
  const key = `${openai() ? "openai" : "anthropic"}:${model}`;
  return async (system, user, schema) => (await cached("llm", { model: key, system, user, schema }, () => llm(system, user, schema))).data;
}

/** Claim phrasing stays on Opus when only the judge is swapped, so claims (and the cached Highlights queries) don't change. */
export const claimLLM = () => defaultLLM(process.env.CLAIM_MODEL ?? (openai() ? undefined : "claude-opus-5-5"));

function rawLLM(model: string): LLM {
  if (openai()) {
    const base = process.env.JUDGE_BASE_URL ?? "https://api.openai.com/v1";
    return async (system, user) => {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.JUDGE_API_KEY ?? ""}` },
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Judge endpoint ${res.status}: ${await res.text()}`);
      return (await res.json()).choices[0].message.content;
    };
  }
  const client = new Anthropic();
  return async (system, user, schema) => {
    const msg = await client.beta.messages.create({
      model,
      max_tokens: 8000,
      // Haiku has no server-side refusal fallback.
      ...(model.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
      output_config: { effort: "medium", format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content: user }],
    });
    if (msg.stop_reason === "refusal") throw new Error("Judge refused");
    return msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  };
}

const jsonSchema = (s: z.ZodType) => {
  const { $schema, ...rest } = z.toJSONSchema(s);
  return rest;
};

/** Pull the first JSON object out of a reply (small models like to wrap it in prose or fences). */
function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(text.slice(start, end + 1));
}

// ---------- Claim phrasing ----------

const PhrasedSchema = z.object({ claims: z.array(z.object({ path: z.string(), claim: z.string() })) });

/** One call per answer: rewrite every field as a standalone factual sentence. Falls back to `fallback` per field. */
export async function phraseClaims(llm: LLM, question: string, fields: { path: string; label: string; value: unknown }[]) {
  const system =
    "Rewrite each field of a research answer as one standalone, checkable factual sentence. Name the subject explicitly (e.g. the company). Keep the value exactly as given. Do not add facts.";
  const user = `Question: ${question}\n\nFields:\n${fields.map((f) => `- ${f.path} (${f.label}) = ${JSON.stringify(f.value)}`).join("\n")}\n\nReturn {"claims":[{"path","claim"}]} with one entry per field.`;
  const schema = jsonSchema(PhrasedSchema);
  try {
    const out = PhrasedSchema.parse(parseJson(await llm(system, user, schema)));
    return new Map(out.claims.map((c) => [c.path, c.claim]));
  } catch {
    return new Map<string, string>();
  }
}

// ---------- Judging ----------

const JudgeSchema = z.object({
  verdict: z.enum(VERDICTS),
  best_source_url: z.string().nullable(),
  evidence_quote: z.string().nullable(),
  reason: z.string(),
});
export type JudgeOutput = z.infer<typeof JudgeSchema>;

export type Citation = {
  verdict: Verdict;
  source: string | null;
  evidence: string | null;
  reason: string;
  /** False when the judge's quote could not be found verbatim in any passage and the verdict was downgraded. */
  quote_verified: boolean;
};

const JUDGE_SYSTEM = `You verify one claim against evidence passages scraped from the cited sources. Judge only from the passages, never from your own knowledge.
Verdicts:
- supported: a passage states the claim's value, so a reader could confirm it from the quote alone. Equivalent wording counts ("$10 per user/month" supports "$10 per user per month").
- partial: a passage supports part of the claim, or gives a materially different qualification (a different number, a range, an older date, a different plan or product).
- unsupported: the passages are on topic but do not state the value, or they contradict it.
- no_evidence: the passages are irrelevant or empty.
A passage that only mentions a word in another sense (e.g. a product name in a feature list) does not support a claim about it.
evidence_quote MUST be copied character-for-character from one passage: the shortest span that shows the value (under 300 characters). Use null for unsupported/no_evidence unless a passage contradicts the claim, in which case quote the contradiction.
reason: one sentence. If the passage contradicts the claim, say what it actually says.`;

export function judgePrompt(question: string, claim: string, value: unknown, evidence: Highlights[]): string {
  const passages = evidence.flatMap((e) => e.passages.map((p) => `<passage source="${e.url}">\n${p}\n</passage>`));
  return `Research question: ${question}\nClaim: ${claim}\nValue being checked: ${JSON.stringify(value)}\n\n${passages.join("\n\n")}`;
}

/**
 * Whitespace, curly quotes, dashes, and Markdown syntax (passages are Markdown) vary between what a model
 * copies and what the page has. Words, numbers, and case are not forgiven.
 */
export const normalize = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The Auditor lesson: never trust a citation the model says it read. The quote must appear in a passage
 * we actually retrieved, or a supported/partial verdict is downgraded to unsupported.
 */
export function enforceQuote(out: JudgeOutput, evidence: Highlights[]): Citation {
  const quote = out.evidence_quote?.trim() || null;
  const found = quote ? evidence.find((e) => e.passages.some((p) => normalize(p).includes(normalize(quote)))) : undefined;
  const positive = out.verdict === "supported" || out.verdict === "partial";

  if (positive && !found) {
    return {
      verdict: "unsupported",
      source: out.best_source_url,
      evidence: quote,
      reason: `Downgraded from ${out.verdict}: the quoted evidence does not appear in any retrieved passage. Judge said: ${out.reason}`,
      quote_verified: false,
    };
  }
  // Re-point the source at the page the quote actually came from.
  return { verdict: out.verdict, source: found?.url ?? out.best_source_url, evidence: found ? quote : null, reason: out.reason, quote_verified: true };
}

export async function judge(llm: LLM, question: string, claim: string, value: unknown, evidence: Highlights[]): Promise<Citation> {
  if (!evidence.some((e) => e.passages.length)) {
    const errors = evidence.filter((e) => e.error).map((e) => `${e.url} (${e.error})`);
    return {
      verdict: "no_evidence",
      source: null,
      evidence: null,
      reason: errors.length ? `No passages returned; failed: ${errors.join(", ")}.` : "No relevant passages were returned from any cited source.",
      quote_verified: true,
    };
  }
  let out: JudgeOutput;
  try {
    out = JudgeSchema.parse(parseJson(await llm(JUDGE_SYSTEM, judgePrompt(question, claim, value, evidence), jsonSchema(JudgeSchema))));
  } catch (e: any) {
    if (e?.status) throw e; // API errors surface; malformed JSON becomes a verdict
    return { verdict: "no_evidence", source: null, evidence: null, reason: `Judge returned invalid JSON: ${String(e?.message ?? e).slice(0, 120)}`, quote_verified: false };
  }
  return enforceQuote(out, evidence);
}
