# BUILD BRIEF: the maintainer's night-shift agent
## Hacktoberfest Open-Source AI Challenge, Week 3: "Slow and Steady"

Builder: Wasih (solo). Advisor: Usman.
Challenge: https://dev.to/challenges/hacktoberfest-week3-2026-10-19
Deadline: **Sat Oct 25, 11:59 PM PDT = Mon Oct 26, 10:59 AM Gulf Standard Time.** Target publish: **Sun Oct 25, 10 PM GST.** Hard stop for code: Sun 6 PM GST. Everything after that is write-up and demo.

---

## 0. Name (decide on day 1, before the repo is created)

"Sloth" is already used by at least six Week 3 entries ("Sloth", SlothOps, SlothSort, SlothSummary, SlothFlow, Sloth Digest). Do not put "sloth" in the name.

Candidates, in order of preference:
1. **Nightshift** (nightshift.tech if available): "the maintainer who works while you sleep"
2. **Hammock**: "put your backlog in a hammock"
3. **Dozer**: it dozes until it's needed
4. **Snooze**: "hit snooze on your PR queue"

Check `.tech` availability at hacktoberfest.com/my/promos before committing. Repo name = project name, lowercase.

---

## 1. One-paragraph pitch

Open-source maintainers wake up to a pile: new PRs, review requests, issue notifications, most of it noise, duplicates, or AI-generated slop. This year Hacktoberfest itself stopped counting pull requests because that pile burned maintainers out. **[Name]** is a local agent that reads the pile overnight, buckets every PR and issue (duplicate, spam, out of scope, needs tests, trivial and safe, needs a human), drafts the reply for each, and hands the maintainer one morning digest: "4 need you (about 10 minutes), 7 drafted replies waiting for one click, 3 auto-labelled." It never posts to GitHub without approval. It runs on a laptop with Gemma 3 through Ollama, costs nothing per night, and keeps contributor data on the maintainer's own machine.

## 2. Who it is for, and the lazy payoff

- The maintainer of a 500-star repo who checks GitHub on their phone in bed and feels dread.
- The payoff is measurable: minutes spent on triage per morning, before vs with the agent; PRs/issues triaged per night; drafts accepted unedited vs edited vs rejected.
- We will run it for **four consecutive nights (Thu, Fri, Sat, Sun)** on:
  - Wasih's own repo (write mode: approve and post flow for the demo video)
  - Two or three partner repos, **read-only, drafts only, nothing ever posted**: `mastra-ai/mastra`, `temporalio/temporal` or `temporalio/samples-typescript`, `timescale/timescaledb` or `timescale/pgai`. Pick the ones with the most daily PR/issue traffic on day 1.
- Record every night's numbers in `docs/NIGHTS.md`. This file becomes "The Lazy Payoff" section. Do not invent numbers. If a night fails, say so in the post; honesty about a failed run is a writing-quality win.

## 3. Competitive position (from the Oct 21 scan)

| Entry | What it is | What we have that it doesn't |
|---|---|---|
| RepoRelief AI | On-demand, read-only *issue* classifier with maintainer checklists, Streamlit-style UI | PRs as well as issues; overnight durable run; duplicate detection against repo history; drafted replies; approve-and-post; four nights of real usage data |
| SlothOps | Broad "auto-approve routine PRs, triage email, distill meetings" | Narrow and real; explicit "never acts without a human"; measured results; partner-repo validation |
| Sloth Digest, Siesta, SlothSort, etc. | Inbox/file/task digests with local Gemma | Different domain (maintainers); the Hacktoberfest-PR-fatigue hook; dev audience feels this pain personally |

The post must state the "never auto-approves, never auto-closes" stance in the first screen. It is our answer to SlothOps and to every maintainer's fear of bots.

## 4. Scope

### Must ship (core, by Sat 6 PM)
1. **Collector**: pulls new/updated PRs and issues since last run for N repos via GitHub REST (Octokit). Stores raw JSON + diff stats + CI status in Postgres (Tiger Data).
2. **Triage agent (Mastra)**: for each item, calls Gemma 3 4B via Ollama with a rigid output contract (JSON: `bucket`, `confidence`, `reason`, `evidence[]`, `draft_reply`). Buckets: `DUPLICATE`, `SPAM_OR_SLOP`, `OUT_OF_SCOPE`, `NEEDS_TESTS_OR_INFO`, `TRIVIAL_SAFE`, `NEEDS_HUMAN`. Anything unparseable lands in `NEEDS_HUMAN`. Never silently drop.
3. **Duplicate detector**: embed title + first 400 chars of body (local embedding model via Ollama, e.g. `nomic-embed-text`), hybrid search in Tiger Data (pgvector cosine + Postgres full-text), top-3 candidates passed to the model as evidence. Hybrid, not vector-only; the post should show one example where keyword matched and vector didn't, and one the other way.
4. **Nightly workflow (Temporal)**: `nightlyTriage(repos[])` workflow with activities `collect`, `embed`, `triage`, `digest`. Retries on GitHub rate limits, survives Ollama restarts and laptop sleep, resumes where it left off. Scheduled via Temporal Schedule at 02:00 local. Local Temporal dev server is fine; note it in the post.
5. **Morning digest**: `docs/digests/YYYY-MM-DD.md` plus terminal output: headline counts, "needs you" list with one-line reasons, drafted replies ready to approve, what was auto-labelled. Keep it under one screen. Two lines at the top is the sloth promise.
6. **CLI**: `nightshift run`, `nightshift digest`, `nightshift approve <id>`, `nightshift post <id>` (write mode, own repo only).
7. **Dashboard** (Next.js, hosted on Render): list of last night's items with bucket, reason, evidence, draft; buttons Approve / Edit / Skip / Post. Auth0 login. Reads from Tiger Data. Model calls go to the Render-hosted model when the laptop is off, so the hosted demo works for judges; the post is explicit that local is the primary mode.
8. **Approval gate (Auth0 for AI Agents)**: `post` and `close` are "risky actions" requiring a human approval step; GitHub token held in Token Vault, never in `.env` for the hosted dashboard.
9. **Sentry Agent Tracing**: every triage call traced: model, tokens in/out, latency, bucket. The post includes one trace screenshot and the per-night cost line ($0.00 local vs the Render-hosted equivalent).
10. **TabPFN**: from each partner repo's closed PR history (CSV: additions, deletions, files changed, author account age, author prior merged PRs, has tests, has description, time to first comment), predict P(merged) for open PRs. Surfaces as "likely to be abandoned" flag in the digest. Report accuracy on a held-out slice. This is honest tabular use, not decoration.

### Should ship (Sat afternoon, if core is green)
- **Changelog draft**: merged PRs since last tag to a changelog section. One extra activity in the workflow, big "lazy" win, small code.
- **ElevenLabs**: 90-second spoken morning digest, `digest.mp3`. Laziest possible consumption. One function.
- **GitHub Action**: `.github/workflows/nightshift.yml` that runs the collector + hosted-model triage on a schedule, as the "I don't even own a laptop" mode. Also use Copilot CLI during the build and keep the session for the Copilot section.
- **Entire**: record the agent sessions behind the build and link them.
- **.tech domain**: dashboard live at `<name>.tech`.

### Stretch (Sat night, go/no-go at 4 PM Sat)
- **Tinker fine-tune**: Go only if by Fri night there are 250+ human-labelled items (Wasih labels bucket + one-line reason on real partner-repo items while reviewing digests; this is also the review step, so it's not wasted time). LoRA on Gemma 3 4B or Qwen2.5 3B via Tinker, held-out 60, report base vs tuned accuracy and the confusion matrix. If the gain is under 5 points, don't enter the category; mention the attempt honestly in the post instead.

### Not building
- Auto-merge, auto-close, auto-comment without approval. Ever.
- Multi-user SaaS, billing, onboarding.
- Slack/Discord integrations.
- MongoDB (Tiger is the data layer; one not both).
- Browserbase, SerpApi, Ultramarine, Arduino, DigitalOcean (Render is the host).

## 5. Architecture

```
          +------------------+         +------------------+
 GitHub   |  collect (Temporal activity)  |  -->  |  Tiger Data (Postgres + pgvector + FTS) |
 REST --> |  Octokit, since=last_run      |       |  items, embeddings, buckets, drafts,     |
          +------------------+         |  nights, labels_human                    |
                   |                   +------------------+
                   v                              ^
          +------------------+                    |
          |  embed (Ollama nomic-embed-text)      |
          +------------------+                    |
                   v                              |
          +------------------+   evidence (top-3 dups, CI, diff stats, TabPFN p_merge)
          |  triage (Mastra agent -> Ollama gemma3:4b, JSON contract, temp 0)
          +------------------+
                   v
          +------------------+       +------------------+
          |  digest (md + mp3)       |  dashboard (Next.js on Render, Auth0, approve/post)
          +------------------+       +------------------+
 Temporal workflow nightlyTriage wraps collect -> embed -> triage -> digest, scheduled 02:00
 Sentry traces every model call. GitHub token only in Auth0 Token Vault for hosted mode.
```

Stack: TypeScript end to end (Wasih's strength). Node 20+, pnpm. Mastra for agent + tools + workflow steps, Temporal TS SDK for durability, Octokit, Ollama (`gemma3:4b`, `nomic-embed-text`), Tiger Data Postgres (pgvector + tsvector), Next.js 15 dashboard, Auth0 (Auth for AI Agents SDK), Sentry (`@sentry/node` agent monitoring), TabPFN (Python, called as a small FastAPI sidecar or via the Prior Labs API; local via the open weights after signing the non-commercial licence), ElevenLabs TS SDK.

Model fallback order: `gemma3:4b` local -> `gemma3:1b` local -> Render-hosted model (already deployed) -> `NEEDS_HUMAN`. Log which path was used; the post shows the share per night.

## 6. Prompt contract (triage)

System: you are a maintainer's assistant. You classify, you never decide. Output one JSON object only.

Input fields: repo, type (pr|issue), title, body (truncated 1500 chars), author, author_account_age_days, author_prior_merged, additions, deletions, files_changed, has_tests, ci_status, top_duplicates [{number, title, similarity, why}], p_merge (TabPFN).

Output: `{"bucket": "...", "confidence": 0-1, "reason": "one sentence, cite evidence fields", "evidence": ["..."], "draft_reply": "polite, under 80 words, in the maintainer's voice, or null"}`

Rules in prompt: duplicates must cite the number; SPAM_OR_SLOP needs two independent tells (generic title, body unrelated to diff, mass-identical PRs from same author, 400+ line "typo fix"); when unsure, NEEDS_HUMAN. Temperature 0.

Spam/slop tells worth naming in the post: the Hacktoberfest-2024/2025 spam patterns maintainers actually complained about. Cite the MLH/DEV post on why PR counting ended.

## 7. Schedule (GST)

**Wed Oct 21 (tonight)**: name + .tech + repo. `pnpm init`, Ollama models pulled, Tiger Data DB up, schema migrated. Collector working against own repo and one partner repo. Commit early so the window is provable.

**Thu Oct 22**: Mastra triage agent with JSON contract, dup detection with hybrid search, digest markdown. Temporal workflow wrapping it. **Night 1 run at 02:00 Fri on all repos.** Sentry wired before the run so night 1 has traces.

**Fri Oct 23**: Review night 1 digest, label 100+ items (this is both QA and Tinker data). Fix prompt. TabPFN sidecar + CSV from closed-PR history. CLI commands. **Night 2 run.**

**Sat Oct 24**: Dashboard on Render with Auth0 and approval gate. Changelog, ElevenLabs, GitHub Action. 4 PM: Tinker go/no-go. **Night 3 run.** 6 PM: code freeze except bug fixes. Evening: write-up first full draft from the outline below. Record demo video (2 min, own repo, approve-and-post flow).

**Sun Oct 25**: Morning: review night 3, run `docs/NIGHTS.md` totals. Second draft of post, screenshots, trace images, embed repo, DevRelay/Entire session links. Run the judge-reviewer agent. **Night 4 run can be an afternoon run** so numbers are in before publishing. Publish by 10 PM GST. Comment on the launch post with the link.

**Mon Oct 26, before 10:59 AM**: buffer only. Any commits after publishing go in README under "post-deadline changes".

## 8. Write-up outline (the thing that is judged most)

Title options (pick one, no "sloth"):
- "Hacktoberfest stopped counting PRs because maintainers were drowning. I built the night shift."
- "Four nights, three repos, 212 PRs: a local Gemma agent that triages while the maintainer sleeps"
- "[Name]: the maintainer's night shift, running on a laptop, never merging anything"

Structure, following the template exactly:
1. **What I Built**: open with the Hacktoberfest-PR-fatigue fact, one sentence. Then the morning digest screenshot, two lines. Then the never-acts-alone promise. Who gets lazier: the maintainer.
2. **Demo**: live dashboard link on `.tech`, 2-minute video.
3. **Code**: embedded repo.
4. **How I Built It**: the pipeline diagram, then four short sub-sections: Gemma + Ollama (the contract, the fallback order, why 4B over 1B with one example), Mastra (agent, tools, workflow steps), Temporal (what failed on night 2 and how it resumed; keep a real failure), Tiger Data (hybrid search with one keyword-only and one vector-only catch). Then shorter paragraphs for Auth0, Sentry, TabPFN, ElevenLabs, GitHub Action, each with one image.
5. **Why Open Innovation Matters**: three concrete claims with evidence: (a) contributor data and private-repo diffs never leave the laptop; (b) $0.00 across four nights vs a computed closed-API cost from the Sentry token counts; (c) swapped 1B for 4B and (if Tinker) fine-tuned to the repo's norms, which a closed API can't do. Avoid generic "open source is good" sentences.
6. **My Agent Session**: DevRelay or Entire links.
7. **The Lazy Payoff**: the table from `docs/NIGHTS.md`: per night, items in, buckets, drafts accepted/edited/rejected, minutes the maintainer spent. Plus one sentence on what it got wrong.
8. **Prize Categories**: list exactly the categories with real usage. Core: Mastra, Gemma, Temporal, Tiger Data, Auth0, Sentry, TabPFN, Render, .tech. Add Copilot, ElevenLabs, Entire, Tinker only if shipped.

Writing rules: short paragraphs, one idea each. Numbers over adjectives. Every claim traces to a file in the repo. No emoji walls. No "revolutionary". Credit Usman as advisor by DEV handle in the body.

## 9. Definition of done

- Four nights in `docs/NIGHTS.md` with real numbers (three acceptable if one failed and the failure is written up).
- Dashboard live on `.tech`, Auth0 login works, approve-and-post works on own repo in the video.
- `pnpm test` green; at least: JSON contract parser, bucket fallback to NEEDS_HUMAN, hybrid search returns known duplicate pair, Temporal workflow replays after a simulated activity failure.
- Sentry has traces for every night.
- Post published with required tags `devchallenge, hf26challenge`, every entered category has a paragraph and an image.
- README states the challenge window and lists any post-deadline commits.
