# Findings: per-field grounding of Context.dev Answers (fast mode)

I ran 25 questions through Answers in `fast` mode on 2026-10-29. I flattened the answers into **140 fields** and checked each field against up to 3 of the cited sources with Scrape + Highlights, using the claim as the query. Claude Opus 5.5 judged each field, and its quote was then checked verbatim in code. Raw output is in [results/benchmark.json](results/benchmark.json). The run cost 553 credits, plus about 100 in an earlier attempt that hit the 2-request concurrency limit.

This is one small run. It measures whether the cited pages contain each value, not whether the answers are correct. Several "unsupported" fields are true facts that simply aren't in the retrieved passages.

## Results

| Category | Fields | Supported | Partial | Unsupported | No evidence |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pricing | 52 | **88.5%** | 5.8% | 5.8% | 0% |
| Product features | 31 | 74.2% | 16.1% | 9.7% | 0% |
| Company facts | 26 | 50.0% | 11.5% | 15.4% | 23.1% |
| Dates / numbers | 14 | 42.9% | 21.4% | 35.7% | 0% |
| People / roles | 17 | 41.2% | 0% | 0% | 58.8% |
| **All** | **140** | **67.9%** | **10.0%** | **10.7%** | **11.4%** |

**Questions about a specific page ground very well.** Pricing and product-doc questions averaged about 1 source, the vendor's own page, and nearly every field had a quotable passage. Linear, GitHub Copilot, the Claude API, Tailwind v4, and Context.dev's own Scrape formats were all fully or almost fully supported.

**Company and people questions cite mostly profile records.** These averaged 11–12 sources, and 66–74% were LinkedIn, X, Facebook, Instagram, or Crunchbase URLs (80–93% of the first three). Those pages either block scraping or don't contain the field. The official pages often appear later in the list, after the profile records.

## Example failures

**1. The answer contradicts its own cited source (Python).**
Answers returned `latest_version: "3.15.0"` and `release_date: "2026-10-09"`. The only cited source, https://www.python.org/downloads/source/, says:
> "Latest Python 3 Release - Python 3.15.2"

That page lists 3.15.2 as released Oct. 25, 2026. Both fields were judged `unsupported`.

**2. Two cited sources disagree, and the answer follows the older one (Node.js LTS).**
Answers returned `lts_line: "24"`, `end_of_life: "2028-04-30"`. Its first source, https://endoflife.date/nodejs, lists `26 (LTS)` released 05 May 2026, and shows 24's active support ending 20 Oct 2026. Its second source is a July 2026 HeroDevs post that says "Node.js 24 is the Active LTS line" and that 26 "is scheduled to enter LTS in October 2026." The answer matches the stale source, and nothing in the response flags the conflict. The `codename: "Krypton"` field is Node 24's real codename, but it isn't in any retrieved passage.

**3. The right number in the wrong field (Cloudflare Workers).**
Answers returned `paid_plan_max_cpu_limit: "30 million CPU milliseconds per month"`. The cited pricing page says that figure is an included billing allowance, and gives the limit separately:
> "30 million CPU milliseconds included per month +$0.02 per additional million CPU milliseconds Max of 5 minutes of CPU time per invocation (default: 30 seconds)"

Both CPU-limit fields were judged `partial`. The value exists on the page but answers a different question.

**4. Sources that are about other entities (OpenAI and YC leadership).**
For "OpenAI's CEO, CFO, and Chief Research Officer", the first three sources were three Sam Altman LinkedIn profiles: `/in/sam-altman-b54557359`, `/in/sam-altman-891603414`, and `/in/sam-altman/`. At least two look like duplicate or unofficial accounts, and all three are blocked for scraping. The list also includes `linkedin.com/company/openai-chatgpt35`, `/dall-e-open-ai`, and `/collabortivecapitalism`. The pages that would ground the answer, `openai.com/index/openai-welcomes-cfo-cpo/` and `openai.com/index/leadership-team-update/`, were sources #19 and #20.
For "President and CEO of Y Combinator", all 5 sources were LinkedIn profiles of unrelated individuals. `Garry Tan` is correct, but nothing cited supports it.

**5. Values the cited page doesn't show (Notion, Context.dev).**
Notion's monthly-billed prices (`$12`, `$24`) were `unsupported`. The retrieved passages from notion.com/pricing show only the default view (`$10per member / month`), and the monthly price is probably behind a billing toggle. In Context.dev's own company facts, `latest_funding.round: "Seed"` was `unsupported`. The cited X post says "We raised $9M to give your agents the internet" but never names the round. The fact is correct, but the citation doesn't carry it.

## What would help

1. **Per-field citations.** Every example above took a scrape per field to reconstruct. The research agent already knows which page it used for each value, so returning that page (the `verify: true` shape in the README) would let users trust the many fields that are fine and only check the rest.
2. **Put first-party pages first, or label source types.** `sources` currently mixes "profile records read" with "URLs cited in json_content". Ordering official pages first, or tagging each source as `page`, `profile_record`, or `cited`, would make the list useful without a re-scrape.
3. **Flag conflicts on time-sensitive fields.** When two sources disagree (the Node case), returning both values, or preferring the most recently dated source, would catch the stale answers in this run.
4. **Filter out other entities.** Dropping profile records whose entity doesn't match the subject (`stripe-agency`, `incubadoracultura`, extra Sam Altman profiles) would make the source list easier to trust at a glance.

## Caveats

- **Top 3 sources only.** To stay within budget, each claim was checked against the first 3 `sources`. For company and people questions, that meant mostly profile records, and the official page further down the list was often skipped. A source ranker that prefers the subject's own domain would likely raise those scores. This is a limit of Groundcheck, not Answers.
- **The judge is strict and quotes only from passages.** "Unsupported" means "not in what was retrieved", not "false". Highlights returns at most 2,000 characters per query, so a fact elsewhere on a page can be missed.
- **The judge can be lenient on names.** For example, it supported `company: "Linear"` by quoting "Linear Agent" from the pricing page.
- **The verbatim check never fired live** (0 downgrades). Opus 5.5 copied every quote exactly, and a rerun with Claude Haiku 5.5 as judge ([results/benchmark-haiku.json](results/benchmark-haiku.json), 0 credits from cache) did too, even though 15 of its 140 verdicts differed from Opus. The check is tested on the real data instead: all 112 real quotes pass, and all 112 one-character mutations are caught ([test/real-quotes.test.ts](test/real-quotes.test.ts)). It matters most with a small judge model that doesn't enforce JSON output.
- **Sample size.** n = 140 fields from a single run, so treat the percentages as directional.
