import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { enforceQuote } from "../src/judge.ts";
import type { FieldCitation } from "../src/groundcheck.ts";

// Real judge quotes and real Highlights passages from the 25-question benchmark run.
const bench = JSON.parse(readFileSync("results/benchmark.json", "utf8"));
const quoted: FieldCitation[] = bench.runs.flatMap((r: any) => Object.values(r.result?.citations ?? {})).filter((c: any) => c.evidence);

/** Change the quote the way a sloppy judge would: bump the first digit, or else drop in a word. */
function mutate(q: string): string {
  const d = q.search(/\d/);
  if (d >= 0) return q.slice(0, d) + ((Number(q[d]) + 1) % 10) + q.slice(d + 1);
  const mid = q.indexOf(" ", Math.floor(q.length / 2));
  return mid > 0 ? `${q.slice(0, mid)} never${q.slice(mid)}` : `${q} never`;
}

describe("verbatim check on real benchmark data", () => {
  it("has real quotes to check", () => {
    expect(quoted.length).toBeGreaterThan(50);
  });

  it("accepts every quote the judge actually copied from a real passage", () => {
    const rejected = quoted.filter(
      (c) => enforceQuote({ verdict: "supported", evidence_quote: c.evidence, best_source_url: c.source, reason: "" }, c.passages).verdict !== "supported",
    );
    expect(rejected.map((c) => c.evidence)).toEqual([]);
  });

  it("downgrades every quote altered by one digit or word", () => {
    const missed = quoted.filter(
      (c) => enforceQuote({ verdict: "supported", evidence_quote: mutate(c.evidence!), best_source_url: c.source, reason: "" }, c.passages).verdict === "supported",
    );
    expect(missed.map((c) => mutate(c.evidence!))).toEqual([]);
  });
});
