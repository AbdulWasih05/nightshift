# Build loop log

One entry per unit: plan before, reflect after. The post's "How I Built It" is written from this file.

## 2026-10-21 · unit 0+1: scaffold, schema, collector

**Plan**
- Acceptance: `pnpm nightshift collect` stores items for the own repo and `temporalio/temporal`, and `SELECT kind, count(*) FROM items GROUP BY repo, kind` matches the GitHub UI's "updated in last 24h" count. `pnpm test` green, including allowlist enforcement.
- Could go wrong: GitHub search API (30 req/min) throttles the per-author merged-PR lookup on mastra (~150 items/day); Docker Desktop on Windows slow to start; Tiger Cloud signup takes longer than planned.
- Cut if it does: author_prior_merged becomes null for uncached authors (TabPFN tolerates missing values); run Postgres locally in the timescaledb-ha image (same image Tiger Cloud runs) until the Tiger service is up.

**Verify** (22:55 GST, after Docker restart)
- `pnpm nightshift collect --repo temporalio/temporal`: 66 items (62 PRs, 4 issues) in 155s, 0 rows in `collect_errors`. All 62 PRs have diff stats; 26 have failing CI. The 2 PRs with null author facts are `claude[bot]` and `temporal-cicd[bot]` (by design).
- Immediate second run: 1 item in 4.9s. Unchanged items are skipped, so the cursor does not re-collect.
- Own repo: 404, as expected. It is created after midnight.

**Reflect**
- Slower than planned: Docker Desktop/WSL wedged and never came up, which cost about an hour before a manual WSL restart fixed it. The GitHub half was verified separately with a smoke script on temporalio/temporal and timescale/timescaledb.
- Next unit: write the pure core (pagination, scrubbing, mapping) as functions with fakes first. The reviewer's three blockers were all in I/O glue that the first tests never touched.
- For the post: "The first review found a way past my own write allowlist: GitHub's client checked the owner/repo parameters, not the URL actually sent. The guard now checks the resolved URL, and the bypass is a regression test." 

## 2026-10-22 · unit 2+3: triage agent + hybrid duplicate search

**Plan**
- Acceptance: `pnpm nightshift triage --repo temporalio/temporal --limit 5` stores 5 triage rows with a parsed bucket, model path, tokens and latency. `pnpm nightshift dups` returns a real duplicate pair. Tests: contract parser + NEEDS_HUMAN fallback, fallback chain, seeded duplicate pair (keyword-only and vector-only catches).
- Could go wrong: Mastra structured output not working with Ollama's OpenAI endpoint; gemma3:4b too slow on this laptop; vector similarities too uniform to separate duplicates.
- Cut if it does: call Ollama directly from a Mastra tool; cap mastra at 100 items/night; keyword-only duplicates.

**Verify**
- Mastra 1.79 + Ollama `/v1` + structuredOutput work. Cold start 93s, warm 14.5s on a tiny prompt.
- Real items: 48-61s each, ~1,100 tokens in / ~130 out, 5/5 parsed. GPU is an MX130 (4 GB) with 61% offload.
- Backfill of 90 days for temporal + timescaledb: 2,409 corpus items, 2,476 embedded, 11m22s.
- 62 tests green, including 4 against a real throwaway Postgres.
- After review fixes: 70 tests. A 5-item re-run with candidates: 2 oversized "trivial" calls demoted, 1 draft dropped from NEEDS_HUMAN, 1 false DUPLICATE (temporal#12622, keyword-only on a common phrase), which led to the coverage gate. Latency 57-164s per item, worse than the morning's 48-61s.

**Reflect**
- Slower than planned: duplicate-gate calibration. The 0.80 cosine gate would have offered a "duplicate" for 89% of temporal items, because same-repo text is all alike. Measured the nearest-neighbour distribution before choosing 0.92.
- Next unit: measure the real data distribution before picking any threshold.
- For the post: "gemma3:4b called a 414-line concurrency fix TRIVIAL_SAFE at 0.95 confidence. The fix isn't a better prompt; the parser enforces the rules a 4B model can't be trusted with: duplicates must cite a candidate, spam needs two tells, and 'trivial' means under 40 lines."
