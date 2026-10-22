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

## 2026-10-22

- **Workflow change: one feature branch per unit, PR, squash merge into `main`** (user's call). `main` is the default branch and the repo allows squash merges only. Each unit costs 2 contributions (PR + squash commit); the budget is 7/day.
- **All models go through Mastra's OpenAI-compatible config** (`{id, url, apiKey}`), so local Ollama and the Render-hosted fallback share one code path. `structuredOutput` uses `errorStrategy: 'fallback'` with a sentinel, and our own parser re-reads the raw text. The parser, not the model's JSON mode, is the source of truth.
- **Fallback semantics:** a model that *errors or times out* (240s) hands over to the next model. A model that *answers with garbage* does not: that is NEEDS_HUMAN with `parse_ok=false`, so the 1B model never silently overrides a 4B answer.
- **Post-parse rules enforced in code, not trusted to the prompt:** DUPLICATE must cite a number from the offered candidates; SPAM_OR_SLOP needs two evidence items; TRIVIAL_SAFE over 40 changed lines (non-bot) becomes NEEDS_HUMAN; drafts are trimmed to 80 words. Trigger for the trivial rule: in the pre-flight, v1 put temporal#11774 (+404/-10, a concurrency fix) in TRIVIAL_SAFE at 0.95. Prompt v1 itself is unchanged.
- **Speed:** gemma3:4b takes 48-61s per item on the build laptop. A ~250-item night is 3.5-4h, which fits 02:00-06:00. Offline re-evals are the expensive part; keep labelled sets focused.
- **Duplicate corpus:** the nightly collector only sees the last 24h, but duplicates are usually older. `nightshift backfill` stores 90 days of title/body/state (`corpus_only`, never triaged, cursor untouched). mastra backfill still to do.
- **Duplicate gate calibrated on real data** (temporal, 1,559 items): nearest-neighbour cosine is >= 0.80 for 89% of items, >= 0.90 for 31%, >= 0.93 for 19%. Related-but-distinct pairs sit at 0.87-0.89, and the duplicate request pair #12211/#11497 at 0.96. Gate: vector-only >= 0.92; both halves agree at >= 0.85 with >= 3 shared title terms; keyword-only >= 4 shared title terms.

### Builder-review of unit 2+3 (2026-10-22)
Fixed:
- **Blocker: timeouts never fell through to the next model.** Mastra 1.79 does not throw on abort; it resolves with `text: ''` and `finishReason: 'aborted'`. A hung 4b would have been logged as a parse failure on every item, at 240s each. `mastraGenerate` now throws `ModelTimeoutError`. The test mimics the real resolve-on-abort behaviour, not a rejection. A per-run circuit breaker skips a model after 3 consecutive failures.
- **Duplicate gate too loose on real data.** Candidates must now be the same kind, older than the item, not referenced by it ("Fixes #1"), and, for PRs, still open (a duplicate PR is competing work). Shared terms are counted over titles only, ignoring lexemes under 3 chars and hyphenated compounds. Keyword-only matches need >= 4 shared terms covering >= 60% of the shorter title: temporal#12622 vs #12137 shared only the common phrase "task queue user data", and gemma3:4b called it a DUPLICATE.
- **Demotions kept the model's draft.** A spam call overruled to NEEDS_HUMAN still carried "this looks like spam". Every demotion now clears `draft_reply` and caps confidence at 0.5; NEEDS_HUMAN never carries a draft.
- **TRIVIAL_SAFE now fails closed:** a PR of unknown size is not trivial, and only dependabot/renovate with a dependency-bump title are exempt from the 40-line cap.
- **Per-item isolation** in `triageBatch` (shared by CLI and workflow): duplicate-search failure means no candidates; a failed save is retried once, then recorded in `collect_errors` (stage `triage`) and the item stays pending. Embedding failure is non-fatal, and a failing batch is retried item by item.
- Keyword-only candidates send `similarity: null` instead of 0; confidence 1.5 is out of range, not 1.5%.
- The embedder unloads after each call (`keep_alive: 0`), so it does not take VRAM from gemma3:4b on the 4 GB GPU.

Not fixed, by choice:
- **SPAM_OR_SLOP "two tells" counts evidence items, not independent tells.** Revisit with night-1 data; there are no spam examples yet.
- **Bug found in the latency check: backfill hid items from the collector.** The collector skips items it already holds at the same `updated_at`, and backfilled corpus rows counted as already held. timescaledb collected 5 of 27 items updated in 26h; the other 22 would never have been triaged. Corpus-only rows now never count as unchanged. A DB test covers it, and a re-collect gives 27/27.

### Builder-review of unit 4+5+9: workflow, digest, Sentry (2026-10-22)
Fixed:
- **Blocker: items outside a night were never triaged.** A night only triaged what its own collect stamped: the 69 items collected by the CLI today, and anything left over by a partial night, were lost. New `claimBacklog` step after collect: claims every open, non-corpus item that has no triage row (current prompt) newer than its last collection.
- **Blocker: an Ollama outage was recorded as verdicts.** Every model failed fast, the item was saved as NEEDS_HUMAN with `model_path='none'`, the chunk "succeeded", and the night reported `ok`. Now `ModelsUnavailableError` stores nothing and fails the activity, so Temporal backs off (1 min doubling to 10 min, 10 attempts) and resumes at that item. The breaker half-opens after 5 minutes instead of staying open all night.
- **Stale attempts after laptop sleep.** collect, embed and triage now heartbeat and honour `cancellationSignal`; a cancelled collect can never write the cursor.
- **A night could end with no row, or stuck in `running`.** DB-only steps retry without an attempt limit for up to 3 hours. Everything after `startNight` is in try/finally, so the digest and `finishNight` always run. Found while testing this: the TS SDK rejects `maximumAttempts: 0`; omitting it means unlimited.
- **Repos are collected one at a time** (they share one GitHub search budget). PRs whose enrichment failed are retried next night instead of being stuck un-enriched.
- **Digest:** one file per night (`<date>-night<id>.md`). The file lists every item, every bucket included; only the terminal summary is shortened. The "est." line states its assumptions. The cost line counts hosted calls instead of always printing $0.00.
- **Sentry privacy is now an allowlist**, not a denylist: only named metadata attributes leave the laptop. Breadcrumbs are dropped, URL query strings are off (GitHub search URLs contain logins), and error events keep the exception type only. A unit test asserts that prompt, structured-output, URL-query and SQL attributes are removed.
- **Trigger** comes from Temporal's `TemporalScheduledById` search attribute, not a workflow-id prefix (the TS client's id is `<scheduleId>-workflow-<ts>`).
- **NIGHTS.md** separates scheduled nights from manual runs, and shows "first time" item counts so busy items re-triaged across nights are not double-counted.
- **night-stack.ps1:** probes 127.0.0.1, waits up to 60s for the port, and checks that the worker reached "polling" (with a 15s grace for the cmd→pnpm→tsx→node chain).

Not fixed, by choice:
- **No keep-awake in code**; it needs admin (`powercfg /requestsoverride`). The launcher prints the instruction. If the laptop sleeps past the schedule's 6h catch-up window, the night is skipped, and that will show as a missing night in NIGHTS.md.

### Incident: test night 3 ran uncapped (2026-10-22, ~10:37 IST)
- Intended: a manual night on mastra capped at 4 items (`--max 4`).
- What happened: `TaskStop` on the backgrounded `pnpm nightshift worker` killed the pnpm wrapper, not its node child. The old worker (code without `--max`) kept polling and picked up the workflow, queuing 200 items at ~100-160s each, which would have run into the 02:00 night.
- Action: terminated the workflow after 9 items, marked night 3 `failed` with this note in the DB, and killed both worker processes. The 191 untriaged items carry over through `claimBacklog`.
- Prevention: workers are started only through `scripts/night-stack.ps1`, which detects any running worker process chain.

### Run time is the user's choice (2026-10-22, Wasih's call)
- The digest is not tied to 02:00. `nightshift schedule --at 13:30 [--tz Asia/Dubai]` sets the daily time (saved to `nightshift.config.json`), `--cron` handles anything else, and `nightshift run` gives an immediate summary. `nightshift schedule --once-in N` fires the scheduled path once, N minutes from now, without changing the daily time; that is how night 1 is tested tonight.
- Default stays 02:00 in the machine's timezone (Asia/Kolkata on the build laptop).
- Sentry DSN set; the worker restarted between runs and logs `sentry: on`.

## 2026-10-22 late: compressed schedule, publish Saturday ~19:00 IST (Wasih's call)
- **Cut:** ElevenLabs, GitHub Action, Entire, Tinker fine-tune, changelog draft, .tech. None is core, and each costs hours we now spend on real nights and the write-up. The post mentions none of them as shipped.
- **Kept, time-boxed:** dashboard on Render + Auth0 (Token Vault 45 min, otherwise stubbed and logged). TabPFN ~2h, otherwise cut and logged.
- **Nights:** night 5 (scheduled one-off at 23:01 Thu) and night 6 (Fri). An optional Saturday afternoon run is listed as manual. The post reports exactly the nights in NIGHTS.md.
- **Reversed the same evening (Wasih):** nothing is cut. ElevenLabs, GitHub Action, Entire, Tinker (its Friday-night 250-label go/no-go rule from the brief still applies) and the changelog draft are back in scope, built after core. .tech stays deferred pending last week's winner. Render deploys from a "Deploy to Render" button (render.yaml blueprint) in the README.
