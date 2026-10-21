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
