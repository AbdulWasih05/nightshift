# Decisions

Dated log of every cut, failure, prompt change and reverted change.

## 2026-10-21

- **Name: Nightshift.** First choice in the brief, no "sloth". `.tech` deferred; see the late entry below.
- **Partner repos (read-only):** `mastra-ai/mastra`, `temporalio/temporal`, `timescale/timescaledb`. Traffic for 2026-10-14 to 2026-10-21 from the GitHub search API: mastra 798 PRs / 273 issues, temporal 97 / 6, timescaledb 50 / 10. `temporalio/samples-typescript` (3 / 0) and `timescale/pgai` (0 / 0) dropped: too quiet to measure anything.
- **Own repo (write mode):** `AbdulWasih05/nightshift`, the project repo itself. It is the only entry in the hard write allowlist (`packages/core/src/allowlist.ts`), a frozen source constant. Config cannot widen it, and a partner repo in write mode fails config load.
- **Two GitHub clients.** The collector's client rejects every non-GET request in an Octokit `before` hook. The write client is bound to one allowlisted repo and rejects mutations targeting any other owner/repo. This is the second fence behind the approval gate.
- **Per-repo cap 200 items/night, oldest-first.** When the cap is hit, the cursor stops at the last processed item, so the remainder is collected next run and nothing is skipped.
- **Local Postgres = `timescale/timescaledb-ha:pg17` in Docker** until the Tiger Cloud service URL is in `.env`. Same image Tiger Cloud runs, so pgvector/tsvector behave the same. Switching means changing only `DATABASE_URL`.
- **Model: `gemma3:4b`**, per the brief. `gemma4:e4b` is already on the laptop, but the stack is fixed; revisit only if 4B accuracy is poor after night 1, and log it here if so.
- **Docker Desktop/WSL wedged on the build laptop** (engine pipe missing, `wsl --shutdown` hung). The DB-backed collector run is blocked until Docker or the Tiger service is reachable. The GitHub half is verified separately with `scripts/dev/smoke-github.ts`: temporalio/temporal had 68 items updated in 24h (63 PRs), and diff stats, test detection, CI and prior-merged counts came back correct.
- **CLI exits explicitly**: the Octokit throttling plugin (Bottleneck) holds the event loop open, so a script never exits on its own. Found in the smoke test.
- **Commits:** feature branch only, at most 5 commits/day, so units are batched per commit rather than one commit each.

### Builder-review of unit 0+1 (2026-10-21, before first commit)
Fixed:
- **Blocker: the write allowlist could be bypassed** with a literal URL (`POST /repos/mastra-ai/mastra/...` while passing allowlisted owner/repo params) or a per-request `baseUrl`. The hook now checks the fully resolved URL against `https://api.github.com/repos/<own repo>/`. Regression tests cover the literal-URL, baseUrl and `/gists` cases.
- **Blocker: one bad item could block a repo every night.** A NUL byte or lone surrogate in a body broke the upsert, or a failing PR enrichment rejected the whole batch. Strings are now scrubbed before insert, enrichment and upsert errors are caught per item and stored in `collect_errors` (surfaced in the digest), and the run continues.
- **Offset pagination over a moving sort could skip items.** Replaced with keyset pagination on `since` (`packages/core/src/paginate.ts`). It dedupes by number, keeps the newer snapshot if an item is updated mid-scan, and steps by offset only when a whole page shares one timestamp. The cursor is now the max GitHub `updated_at` seen, not laptop time. Items whose stored `updated_at` is unchanged are skipped, so re-listed items cost nothing and do not count toward the cap.
- **"Prior merged" leaked the label into TabPFN.** It counted the PR's own merge and any later ones. Now per item: `merged:<created_at`. Account age is cached only on successful lookups.
- **The token is now required.** Rate-limit waits over 120s fail the request instead of sleeping for an hour; the Temporal retry handles it.
- `--max` and `--since` are validated. PR files are paginated up to 300 and check runs fully.

Not fixed, by choice:
- **CLI `collect` creates no `nights` row.** Manual collection is not a night. NIGHTS.md counts triage rows per night created by the workflow, so manual runs cannot inflate it.
- **`createWriteClient` does not check approvals.** The `post` command (unit 6) must refuse without an `approvals` row. That is its acceptance check, with a test.
- **Token scope is the server-side fence.** `.env.example` now asks for a fine-grained PAT limited to the own repo. Still to do: create that PAT before night 1 (Wasih).

### 2026-10-21, late
- **Fine-grained PAT:** it can only be scoped to the repo once the repo exists, so it gets created right after the repo is created (Oct 22). Until then, read-only collection uses the `gh` login token passed inline, never saved, through the read client that refuses non-GET requests. Night 1 must run on the scoped PAT.
- **.tech domain: deferred.** Waiting to see what last week's .tech category winner did, then choosing the approach (dashboard on `<name>.tech` vs dropping the category). Nothing in core depends on it.
