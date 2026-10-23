# Nightshift

The maintainer's night shift. A local agent reads your PR and issue pile overnight, buckets each item (duplicate, spam/slop, out of scope, needs tests or info, trivial and safe, needs a human), drafts a reply, and leaves you one morning digest.

**It never posts, labels, closes or merges anything without your explicit approval.** Partner repos are read-only by construction: the write allowlist is a frozen source constant (`packages/core/src/allowlist.ts`), and the collector's GitHub client rejects every non-GET request.

Runs on a laptop with Gemma 3 via Ollama. $0.00 per night. Contributor data stays on your machine.

> Built for the DEV Hacktoberfest Open-Source AI Challenge, Week 3 ("Slow and Steady"). Challenge window: Oct 19 to Oct 25, 2026 (PDT). Repo created 2026-10-21. Any commits after publishing are listed under "Post-deadline changes" below.

## Hosted dashboard

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AbdulWasih05/nightshift)

The dashboard lists last night's items with bucket, reason, evidence and draft, with Approve / Edit / Skip / Post. Login is Auth0, restricted to `ALLOWED_EMAILS`. Posting uses a GitHub token fetched from **Auth0 Token Vault** at the moment you press Post; the app never stores a GitHub token. Post works only on the hard-allowlisted own repo, only after an approval of the exact text shown, and at most once per item.

Setup: create an Auth0 Regular Web Application with the Token Vault grant, a GitHub App installed only on your repo, a GitHub social connection with "Connected Accounts for Token Vault", and the My Account API authorized for the app (see `docs/AUTH0_SETUP.md`). Then click the button and fill in the variables.

## Status

Work in progress. See `docs/LOOP.md` for the build log and `docs/DECISIONS.md` for every cut and change.

## Quick start (laptop mode)

```bash
pnpm install
cp .env.example .env            # set GITHUB_TOKEN (fine-grained PAT, own repo only)
pnpm db:up && pnpm db:migrate   # or point DATABASE_URL at a Tiger Data service
ollama pull gemma3:4b && ollama pull gemma3:1b && ollama pull nomic-embed-text
pnpm nightshift collect --repo temporalio/temporal
pnpm test
```

## Post-deadline changes

None yet.
