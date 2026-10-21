# CLAUDE.md

Read `BUILD_BRIEF.md` first. It is the source of truth for scope, schedule and the write-up. This file is the operating constraints.

## The one thing that matters
Hard deadline: **Mon Oct 26, 10:59 AM Gulf Standard Time** (Oct 25, 11:59 PM PDT). Target publish Sun Oct 25, 10 PM GST. Code freeze Sun 6 PM GST. If a feature is not on track by its slot in the brief's schedule, cut it and say so in `DECISIONS.md`. Shipping a smaller thing with four nights of real data beats a bigger thing with none.

## Non-negotiables
- The agent **never** posts, comments, labels, closes or merges on GitHub without an explicit human approval action. Partner repos are **read-only, always**. Only Wasih's own repo is ever in write mode. Code this as a hard allowlist in config, not a flag.
- No fabricated numbers anywhere. `docs/NIGHTS.md` is written from the database after each run by a script, not by hand.
- Unparseable model output goes to `NEEDS_HUMAN`. Never drop an item.
- Secrets: local `.env` for laptop mode only; the hosted dashboard gets the GitHub token through Auth0 Token Vault. Never commit tokens. `.env.example` lists every variable.

## Stack (do not re-litigate)
TypeScript, Node 20+, pnpm. Mastra (agent, tools, workflow steps). Temporal TS SDK (durability, schedule). Octokit. Ollama: `gemma3:4b` primary, `gemma3:1b` fallback, `nomic-embed-text` for embeddings; Render-hosted model as the last fallback and for the hosted demo. Tiger Data Postgres with pgvector + tsvector (hybrid search). Next.js dashboard on Render. Auth0 for AI Agents. Sentry agent monitoring. TabPFN via a small Python sidecar. ElevenLabs only in the should-ship slot.

Partner docs linked on the challenge page: use them, don't guess APIs. If a partner SDK blocks for more than 45 minutes, write the blocker in `DECISIONS.md`, stub it, move on, and return only after core is green.

## Repo layout
```
apps/cli         commander-based CLI (run, digest, approve, post)
apps/dashboard   Next.js on Render
packages/core    collector, embed, triage agent, digest, tabpfn client, shared types
packages/workflows  Temporal workflow + activities + schedule
sidecars/tabpfn  Python FastAPI, requirements.txt
db/              SQL migrations
docs/            NIGHTS.md, digests/, POST.md, DECISIONS.md, reviews/
.github/workflows/nightshift.yml
```

## How this session works: build in a loop, not in a line

You do not build a feature and move on. Every unit of work goes through the same cycle, and the cycle's outputs feed the next cycle. The loop is the method; the brief's schedule is only the order of the units.

### The loop (one iteration = one unit from BUILD_BRIEF section 4)

1. **Plan** (5 min, written): append to `docs/LOOP.md` a dated entry: unit name, acceptance check (one command or one observable), what could go wrong, what you will cut if it does.
2. **Build**: smallest version that passes the acceptance check. Commit.
3. **Verify**: run the check and the test suite. Add a test for the thing just built before calling it done. If verification fails, fix; if it fails three times, cut scope and log why in `DECISIONS.md`.
4. **Review**: spawn the `builder-reviewer` subagent (defined below) on the diff. It returns a numbered list of defects and risks, ranked. Fix every item ranked "blocker" or "likely to bite on a nightly run" before the next unit. Log items you chose not to fix, with the reason.
5. **Reflect**: append three lines to `docs/LOOP.md`: what was slower than planned, what you will do differently in the next unit, one sentence that could go in the post. The post is written from these lines.

Never skip step 4 or 5 to save time. They are the time savings.

### The nightly loop (one iteration per run)

After every nightly run, before any new feature work:

1. `pnpm nights:update` regenerates `docs/NIGHTS.md` from the database.
2. Read the digest as the maintainer would. For every item in the digest, record a human label in `labels_human` (bucket + one-line reason). This is the review, the TabPFN/Tinker data, and the accuracy measurement at once.
3. `pnpm eval` scores the model's buckets against `labels_human` for that night and writes `docs/eval/YYYY-MM-DD.md`: accuracy per bucket, confusion matrix, the ten worst misses with the model's reason beside the human's.
4. Read the ten worst misses. Change **one thing** in the prompt, the evidence passed in, or the fallback order. One, so the next night's delta is attributable. Record the change and the hypothesis in `DECISIONS.md`.
5. Re-run `pnpm eval` on all previous nights' labelled items with the new prompt (offline, against stored inputs) and confirm it did not regress them. If it did, revert and try a different single change.
6. Spawn the `judge-reviewer` agent on the current state of `docs/POST.md`, `docs/NIGHTS.md` and the repo. Fold its top three suggestions into the next day's plan.

The sequence of prompt versions, their hypotheses, and the per-night accuracy curve is the "How I Built It" section. Keep prompt versions as `packages/core/prompts/triage.v1.md`, `v2`, `v3`; never overwrite.

### Subagents (create these in `.claude/agents/` on day 1)

- **builder-reviewer**: read-only. Given a diff or a package path, reviews for correctness, the non-negotiables above (allowlist, no-act-without-approval, no fabricated numbers), error handling on every GitHub/Ollama/DB call, and whether the acceptance check actually proves the thing. Returns ranked defects. Skeptical by default; it has not seen the code before.
- **judge-reviewer**: reads the post draft and repo the way a DEV judge and each partner's judge would, scores against the rubric in `docs/JUDGE_RUBRIC.md`, searches the live `#hf26challenge` tag for competing Week 3 entries, and returns the ranked changes that raise the odds of a category win. Run after: first digest, dashboard live, post first draft, and two hours before publishing.
- **eval-runner**: runs `pnpm eval` across stored nights with a candidate prompt and reports deltas per bucket. Use it in step 5 of the nightly loop so you can try two candidate changes in parallel and keep the better one.

### Working rules
- Commit small and often from the first hour; the challenge requires the repo be created inside the window. Commit message prefix: the unit name from `docs/LOOP.md`.
- Before each nightly run: Sentry DSN set, DB migrated, allowlist checked, prompt version pinned in config. After each run: the nightly loop, in full.
- `docs/DECISIONS.md` is a dated log of every cut, failure, prompt change and reverted change. `docs/LOOP.md` is the per-unit plan/reflect log. Both are the raw material for the write-up; the post's best paragraphs come from them.
- Required tests: JSON contract parsing and fallback, hybrid search on a seeded duplicate pair, Temporal replay after a failed activity, allowlist enforcement, eval scorer on a fixture night. Add one test per unit on top.
- If the loop reveals a unit is not worth building (the reviewer keeps flagging it, or the eval shows it adds nothing), cut it. Cutting with a written reason scores higher than shipping it half-done.

## Definition of done
See BUILD_BRIEF.md section 9. Do not mark anything done that is not in that list and demonstrably working.
