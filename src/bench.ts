import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import pc from "picocolors";
import { printTable } from "./cli.ts";
import { Credits, groundcheck, type GroundcheckResult, type Verdict } from "./groundcheck.ts";

try {
  process.loadEnvFile();
} catch {}

type Q = { id: string; category: string; question: string; schema: Record<string, unknown> };

const questions: Q[] = JSON.parse(readFileSync("bench/questions.json", "utf8"));
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const budget = Number(process.argv.find((a) => a.startsWith("--budget="))?.split("=")[1] ?? 600);
const credits = new Credits(budget);

const runs: (Q & { result?: GroundcheckResult; error?: string })[] = [];
for (const q of questions.filter((q) => !only.length || only.includes(q.id))) {
  console.log(pc.bold(`\n[${q.id}] ${q.question}`));
  try {
    const result = await groundcheck(q.question, q.schema, { credits });
    printTable(result);
    runs.push({ ...q, result });
  } catch (e: any) {
    console.log(pc.red(`  failed: ${e?.message ?? e}`));
    runs.push({ ...q, error: String(e?.message ?? e) });
    if (/budget/.test(String(e?.message))) break;
  }
  console.log(pc.dim(`  running total: ${credits.used} credits`));
}

const tally = (rs: typeof runs) => {
  const t = { fields: 0, supported: 0, partial: 0, unsupported: 0, no_evidence: 0 } as Record<"fields" | Verdict, number>;
  for (const r of rs) for (const [k, v] of Object.entries(r.result?.summary ?? {})) t[k as Verdict] += v;
  return t;
};
const pct = (t: ReturnType<typeof tally>) =>
  Object.fromEntries((["supported", "partial", "unsupported", "no_evidence"] as const).map((v) => [v, t.fields ? Math.round((1000 * t[v]) / t.fields) / 10 : 0]));

const overall = tally(runs);
const byCategory = Object.fromEntries([...new Set(runs.map((r) => r.category))].map((c) => [c, { ...tally(runs.filter((r) => r.category === c)), pct: pct(tally(runs.filter((r) => r.category === c))) }]));

mkdirSync("results", { recursive: true });
writeFileSync(
  "results/benchmark.json",
  JSON.stringify({ ran_at: new Date().toISOString(), mode: "fast", max_sources_per_claim: 3, credits_used: credits.used, overall: { ...overall, pct: pct(overall) }, by_category: byCategory, runs }, null, 2),
);
console.log(pc.bold(`\nOverall: ${overall.fields} fields`), pct(overall), pc.dim(`· ${credits.used} credits · wrote results/benchmark.json`));
