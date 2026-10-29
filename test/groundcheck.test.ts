import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { flatten, label, templateClaim } from "../src/flatten.ts";
import { enforceQuote, judge, normalize, type LLM } from "../src/judge.ts";

const answersFx = JSON.parse(readFileSync("fixtures/answers-linear-pricing.json", "utf8"));
const highlightsFx = JSON.parse(readFileSync("fixtures/highlights-linear-business.json", "utf8"));
const root = answersFx.response.json_content;
const evidence = [{ url: "https://linear.app/pricing", passages: highlightsFx.response.highlights.data as string[] }];

vi.mock("../src/context.ts", async (orig) => ({
  ...(await orig<typeof import("../src/context.ts")>()),
  answers: async () => ({ data: answersFx.response, hit: true }),
  highlights: async () => evidence[0],
}));

describe("flatten", () => {
  it("turns json_content into leaf fields and skips nulls", () => {
    const paths = flatten(root).map((l) => l.path);
    expect(paths).toContain("plans[2].price_per_user_monthly");
    expect(paths).toContain("free_plan_available");
    expect(paths).not.toContain("plans[3].price_per_user_monthly"); // Enterprise price is null
    expect(paths).toHaveLength(9);
  });

  it("labels array items by their name", () => {
    expect(label(root, "plans[2].price_per_user_monthly")).toBe("plans › Business › price per user monthly");
    expect(label({ xs: [{ v: 1 }] }, "xs[0].v")).toBe("xs › #1 › v");
    expect(templateClaim(root, { path: "plans[2].price_per_user_monthly", value: "$16" })).toBe("plans › Business › price per user monthly: $16");
  });

  it("handles primitive arrays and empty input", () => {
    expect(flatten({ tags: ["a", "", "b"] })).toEqual([
      { path: "tags[0]", value: "a" },
      { path: "tags[2]", value: "b" },
    ]);
    expect(flatten(null)).toEqual([]);
  });
});

describe("verbatim quote check", () => {
  const out = (verdict: any, evidence_quote: string | null) => ({ verdict, evidence_quote, best_source_url: "https://linear.app/pricing", reason: "r" });

  it("accepts a quote that appears in a passage, forgiving whitespace and markdown", () => {
    const c = enforceQuote(out("supported", "$16 per user/month\n\n  Billed yearly"), evidence);
    expect(c).toMatchObject({ verdict: "supported", quote_verified: true, source: "https://linear.app/pricing" });
    expect(normalize("**Team** plan — [$59](https://x)")).toBe(normalize("Team plan - $59"));
  });

  it("downgrades supported to unsupported when the quote was never retrieved", () => {
    const c = enforceQuote(out("supported", "Business plan — $12 per user / month"), evidence);
    expect(c.verdict).toBe("unsupported");
    expect(c.quote_verified).toBe(false);
    expect(c.reason).toMatch(/Downgraded from supported/);
  });

  it("downgrades partial with a missing quote, and does not forgive changed numbers or case", () => {
    expect(enforceQuote(out("partial", null), evidence).verdict).toBe("unsupported");
    expect(enforceQuote(out("supported", "$15 per user/month"), evidence).verdict).toBe("unsupported");
    expect(enforceQuote(out("supported", "billed yearly"), evidence).verdict).toBe("unsupported");
  });

  it("re-points the source to the page the quote actually came from", () => {
    const two = [{ url: "https://other.example", passages: ["nothing here"] }, ...evidence];
    const c = enforceQuote({ ...out("supported", "Billed yearly"), best_source_url: "https://other.example" }, two);
    expect(c.source).toBe("https://linear.app/pricing");
  });

  it("leaves unsupported/no_evidence verdicts alone", () => {
    expect(enforceQuote(out("unsupported", null), evidence)).toMatchObject({ verdict: "unsupported", quote_verified: true });
  });
});

describe("judge", () => {
  const fake = (reply: string): LLM => vi.fn(async () => reply);

  it("returns no_evidence without calling the model when there are no passages", async () => {
    const llm = fake("{}");
    const c = await judge(llm, "q", "claim", 1, [{ url: "https://x", passages: [], error: "WEBSITE_BLOCKED" }]);
    expect(c.verdict).toBe("no_evidence");
    expect(c.reason).toMatch(/WEBSITE_BLOCKED/);
    expect(llm).not.toHaveBeenCalled();
  });

  it("parses fenced JSON and enforces the quote", async () => {
    const reply = '```json\n{"verdict":"supported","best_source_url":"https://linear.app/pricing","evidence_quote":"$16 per user/month","reason":"Listed."}\n```';
    const c = await judge(fake(reply), "q", "Business is $16", "$16", evidence);
    expect(c).toMatchObject({ verdict: "supported", evidence: "$16 per user/month" });
  });

  it("treats malformed judge output as no_evidence instead of crashing", async () => {
    const c = await judge(fake('{"verdict":"maybe"}'), "q", "c", 1, evidence);
    expect(c.verdict).toBe("no_evidence");
    expect(c.quote_verified).toBe(false);
  });
});

describe("pipeline", () => {
  it("produces a per-field citation map and summary from recorded responses", async () => {
    const { groundcheck } = await import("../src/groundcheck.ts");
    const llm: LLM = async (system, user) => {
      if (system.startsWith("Rewrite")) return '{"claims":[]}'; // fall back to template claims
      const quote = /Business|16/.test(user.split("\n")[1]) ? '"$16 per user/month"' : '"made up text"';
      return `{"verdict":"supported","best_source_url":"https://linear.app/pricing","evidence_quote":${quote},"reason":"r"}`;
    };
    const r = await groundcheck(answersFx.request.task, answersFx.request.json_format, { llm });
    expect(r.summary.fields).toBe(9);
    expect(r.citations["plans[2].price_per_user_monthly"]).toMatchObject({ verdict: "supported", evidence: "$16 per user/month" });
    expect(r.citations["company"].verdict).toBe("unsupported"); // fabricated quote downgraded
    expect(r.summary.supported + r.summary.partial + r.summary.unsupported + r.summary.no_evidence).toBe(9);
    expect(r.source_report).toEqual([
      expect.objectContaining({ url: "https://linear.app/pricing", status: "verified", supports: expect.arrayContaining(["plans[2].price_per_user_monthly"]) }),
    ]);
  });

  it("ranks the entity's own site first and profiles last, otherwise keeping order", async () => {
    const { rankSources } = await import("../src/groundcheck.ts");
    const urls = [
      "https://www.linkedin.com/in/sam-altman/",
      "https://x.com/openai",
      "https://www.linkedin.com/company/openai-sora/",
      "https://about.me/",
      "not-a-url",
      "https://openai.com/index/leadership-team-update/",
      "https://openai.com/index/leadership-team-update/",
    ];
    expect(rankSources(urls, "Company facts about OpenAI: who is the CEO?")).toEqual([
      "https://openai.com/index/leadership-team-update/",
      "https://www.linkedin.com/company/openai-sora/",
      "https://about.me/",
      "https://www.linkedin.com/in/sam-altman/",
      "https://x.com/openai",
    ]);
    expect(rankSources(["https://news.example.com", "https://www.ycombinator.com/people"], "Who runs Y Combinator?")[0]).toBe("https://www.ycombinator.com/people");
  });

  it("marks sources past the cap as not_checked and unreadable ones as blocked", async () => {
    const { sourceReport } = await import("../src/groundcheck.ts");
    const c = { verdict: "no_evidence", source: null, passages: [{ url: "https://a", passages: [], error: "WEBSITE_BLOCKED" }] } as any;
    expect(sourceReport(["https://a", "https://b"], ["https://a"], { x: c }).map((s) => s.status)).toEqual(["blocked", "not_checked"]);
  });
});
