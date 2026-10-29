import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import { Credits, groundcheck, type GroundcheckResult, type Verdict } from "./groundcheck.ts";

try {
  process.loadEnvFile();
} catch {}

export const BADGE: Record<Verdict, (s: string) => string> = {
  supported: (s) => pc.green(s),
  partial: (s) => pc.yellow(s),
  unsupported: (s) => pc.red(s),
  no_evidence: (s) => pc.gray(s),
};

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function printTable(r: GroundcheckResult) {
  const rows = Object.entries(r.citations);
  const w = Math.min(40, Math.max(5, ...rows.map(([p]) => p.length)));
  console.log();
  for (const [path, c] of rows) {
    console.log(`${BADGE[c.verdict](c.verdict.padEnd(12))} ${pc.bold(cut(path, w).padEnd(w))}  ${cut(String(c.value), 40)}`);
    const detail = c.evidence ? `“${cut(c.evidence.replace(/\s+/g, " "), 90)}”  ${pc.dim(c.source ?? "")}` : c.reason;
    console.log(`${" ".repeat(13)}${pc.dim(cut(detail, 140))}`);
  }
  const s = r.summary;
  console.log(
    `\n${s.fields} fields: ${pc.green(`${s.supported} supported`)}, ${pc.yellow(`${s.partial} partial`)}, ${pc.red(`${s.unsupported} unsupported`)}, ${pc.gray(`${s.no_evidence} no evidence`)}`,
  );
  console.log(pc.dim(`${r.sources.length} sources returned by Answers · ${r.credits_used} Context.dev credits used this run (0 = all cached)`));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const program = new Command()
    .name("groundcheck")
    .description("Check that each field of a Context.dev Answers response is supported by a cited source.")
    .argument("<question>", "research question for the Answers API")
    .requiredOption("-s, --schema <file>", "JSON file with the example answer shape (json_format)")
    .option("-o, --out <file>", "where to write the JSON result", "results/last.json")
    .option("--max-sources <n>", "sources to check per claim", "3")
    .option("--budget <credits>", "stop if this run would spend more Context.dev credits", "200")
    .action(async (question: string, o) => {
      const schema = JSON.parse(readFileSync(o.schema, "utf8"));
      const r = await groundcheck(question, schema, {
        maxSourcesPerClaim: Number(o.maxSources),
        credits: new Credits(Number(o.budget)),
        onEvent: (e) => {
          if (e.type === "answer") console.log(pc.dim(`Answers returned ${e.fields.length} fields from ${e.sources.length} sources. Checking…`));
        },
      });
      printTable(r);
      writeFileSync(o.out, JSON.stringify(r, null, 2));
      console.log(pc.dim(`Wrote ${o.out}`));
    });
  program.parseAsync().catch((e) => {
    console.error(pc.red(e?.message ?? e));
    process.exit(1);
  });
}
