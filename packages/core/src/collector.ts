// Collector: pulls PRs and issues updated since the repo's cursor, enriches PRs with diff stats,
// test-file presence and CI, enriches authors with account age and prior merged PRs, upserts into `items`.
// One bad item never stops a repo: failures are recorded in `collect_errors` and the run continues.
import type pg from 'pg';
import type { GitHub } from './github/client.ts';
import { daysBetween, mapIssue, summariseCi, type AuthorFacts, type GhIssue, type PrDetails } from './github/map.ts';
import { PAGE_SIZE, scanSince } from './paginate.ts';
import { scrubDeep } from './scrub.ts';
import type { Item } from './types.ts';

export interface CollectOptions {
  repo: string;
  nightId: number | null;
  initialLookbackHours: number;
  maxItems: number;
  /** Override the stored cursor (e.g. `--since 2026-10-20`). */
  since?: string;
  now?: Date;
  /**
   * Duplicate-search history only: store title/body/state without PR or author enrichment, never move the
   * cursor and never assign a night, so backfilled items do not enter the triage queue.
   */
  corpusOnly?: boolean;
}

export interface CollectError {
  number: number;
  stage: 'enrich' | 'upsert';
  error: string;
}

export interface CollectResult {
  repo: string;
  since: string;
  collected: number;
  prs: number;
  issues: number;
  /** True if maxItems was hit; the cursor then stops at the last processed item, so the rest is picked up next run. */
  capped: boolean;
  newCursor: string;
  errors: CollectError[];
}

const ACCOUNT_CACHE_DAYS = 7;
const ENRICH_CONCURRENCY = 4;
const MAX_PR_FILES = 300;

export async function collectRepo(gh: GitHub, db: pg.Pool, opts: CollectOptions): Promise<CollectResult> {
  const now = opts.now ?? new Date();
  const [owner, repo] = opts.repo.split('/') as [string, string];
  const since = opts.since ?? (await readCursor(db, opts.repo)) ?? new Date(now.getTime() - opts.initialLookbackHours * 3_600_000).toISOString();

  const scan = await scanSince<GhIssue>({
    since,
    max: opts.maxItems,
    fetchPage: async (s, page) =>
      (await gh.issues.listForRepo({ owner, repo, state: 'all', since: s, sort: 'updated', direction: 'asc', per_page: PAGE_SIZE, page }))
        .data as GhIssue[],
    unchanged: (issues) => unchangedNumbers(db, opts.repo, issues),
  });

  const accountAge = new Map<string, Promise<number | null>>();
  const ageFor = (login: string) => {
    if (!accountAge.has(login)) accountAge.set(login, fetchAccountAgeDays(gh, db, login, now));
    return accountAge.get(login)!;
  };

  const errors: CollectError[] = [];
  const items: Item[] = [];
  if (opts.corpusOnly) {
    for (const issue of scan.changed) items.push(mapIssue(opts.repo, issue, null, { accountAgeDays: null, priorMerged: null }));
    let stored = 0;
    for (const item of items) {
      try {
        await upsertItem(db, item, null, { corpusOnly: true });
        stored++;
      } catch (err) {
        console.warn(`[backfill] ${opts.repo}#${item.number} skipped: ${(err as Error).message}`);
      }
    }
    return {
      repo: opts.repo, since, collected: stored, prs: items.filter((i) => i.kind === 'pr').length,
      issues: items.filter((i) => i.kind === 'issue').length, capped: scan.capped, newCursor: scan.cursor, errors,
    };
  }
  await mapLimit(scan.changed, ENRICH_CONCURRENCY, async (issue) => {
    const login = issue.user?.login ?? 'ghost';
    let pr: PrDetails | null = null;
    let author: AuthorFacts = { accountAgeDays: null, priorMerged: null };
    try {
      [pr, author] = await Promise.all([
        issue.pull_request ? fetchPrDetails(gh, owner, repo, issue.number) : Promise.resolve(null),
        ageFor(login).then(async (accountAgeDays) => ({
          accountAgeDays,
          priorMerged: await fetchPriorMerged(gh, opts.repo, login, issue.created_at),
        })),
      ]);
    } catch (err) {
      // Store the item anyway with null enrichment; triage sees the gaps and leans to NEEDS_HUMAN.
      errors.push({ number: issue.number, stage: 'enrich', error: (err as Error).message });
    }
    items.push(mapIssue(opts.repo, issue, pr, author));
  });

  for (const item of items) {
    try {
      await upsertItem(db, item, opts.nightId);
    } catch (err) {
      errors.push({ number: item.number, stage: 'upsert', error: (err as Error).message });
    }
  }
  for (const e of errors) {
    console.warn(`[collect] ${opts.repo}#${e.number} ${e.stage} failed: ${e.error}`);
    await db.query(
      'INSERT INTO collect_errors (repo, number, night_id, stage, error) VALUES ($1, $2, $3, $4, $5)',
      [opts.repo, e.number, opts.nightId, e.stage, e.error.slice(0, 2000)],
    );
  }

  await db.query(
    `INSERT INTO sync_state (repo, last_since) VALUES ($1, $2)
     ON CONFLICT (repo) DO UPDATE SET last_since = EXCLUDED.last_since, updated_at = now()`,
    [opts.repo, scan.cursor],
  );

  return {
    repo: opts.repo,
    since,
    collected: items.length,
    prs: items.filter((i) => i.kind === 'pr').length,
    issues: items.filter((i) => i.kind === 'issue').length,
    capped: scan.capped,
    newCursor: scan.cursor,
    errors,
  };
}

async function readCursor(db: pg.Pool, repo: string): Promise<string | null> {
  const { rows } = await db.query<{ last_since: Date }>('SELECT last_since FROM sync_state WHERE repo = $1', [repo]);
  return rows[0]?.last_since.toISOString() ?? null;
}

/** Numbers we already hold at exactly this updated_at: re-listed because `since` is inclusive, nothing new. */
async function unchangedNumbers(db: pg.Pool, repo: string, issues: GhIssue[]): Promise<Set<number>> {
  if (issues.length === 0) return new Set();
  const { rows } = await db.query<{ number: number; updated_at: Date }>(
    'SELECT number, updated_at FROM items WHERE repo = $1 AND number = ANY($2::int[])',
    [repo, issues.map((i) => i.number)],
  );
  const stored = new Map(rows.map((r) => [r.number, r.updated_at.getTime()]));
  return new Set(issues.filter((i) => stored.get(i.number) === new Date(i.updated_at).getTime()).map((i) => i.number));
}

async function fetchPrDetails(gh: GitHub, owner: string, repo: string, number: number): Promise<PrDetails> {
  const { data: pr } = await gh.pulls.get({ owner, repo, pull_number: number });
  const files: string[] = [];
  for await (const page of gh.paginate.iterator(gh.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 })) {
    files.push(...page.data.map((f) => f.filename));
    if (files.length >= MAX_PR_FILES) break; // changed_files carries the true count
  }
  let ci: PrDetails['ci'] = 'none';
  try {
    const [checkRuns, combined] = await Promise.all([
      gh.paginate(gh.checks.listForRef, { owner, repo, ref: pr.head.sha, per_page: 100 }),
      gh.repos.getCombinedStatusForRef({ owner, repo, ref: pr.head.sha }),
    ]);
    ci = summariseCi(checkRuns, combined.data.total_count > 0 ? combined.data.state : null);
  } catch (err) {
    // Head commit can vanish after a force-push from a fork; CI is evidence, not a requirement.
    console.warn(`[collect] CI lookup failed for ${owner}/${repo}#${number}: ${(err as Error).message}`);
  }
  return {
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    draft: pr.draft,
    merged_at: pr.merged_at,
    files,
    ci,
  };
}

function isBot(login: string): boolean {
  return login === 'ghost' || login.endsWith('[bot]');
}

/** Account age, cached per login. Failed lookups are not cached, so a transient error costs one night, not a week. */
async function fetchAccountAgeDays(gh: GitHub, db: pg.Pool, login: string, now: Date): Promise<number | null> {
  if (isBot(login)) return null;
  const cached = await db.query<{ account_created_at: Date }>(
    `SELECT account_created_at FROM account_cache
     WHERE login = $1 AND fetched_at > now() - make_interval(days => $2)`,
    [login, ACCOUNT_CACHE_DAYS],
  );
  if (cached.rows[0]) return daysBetween(cached.rows[0].account_created_at.toISOString(), now);
  try {
    const createdAt = (await gh.users.getByUsername({ username: login })).data.created_at;
    await db.query(
      `INSERT INTO account_cache (login, account_created_at) VALUES ($1, $2)
       ON CONFLICT (login) DO UPDATE SET account_created_at = EXCLUDED.account_created_at, fetched_at = now()`,
      [login, createdAt],
    );
    return daysBetween(createdAt, now);
  } catch (err) {
    console.warn(`[collect] user lookup failed for ${login}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * PRs by this author merged in this repo *before this item was opened*. Bounding by created_at keeps the
 * item's own outcome (and later merges) out of the feature, which matters for TabPFN's P(merged).
 */
async function fetchPriorMerged(gh: GitHub, repo: string, login: string, createdAt: string): Promise<number | null> {
  if (isBot(login)) return null;
  try {
    const res = await gh.request('GET /search/issues', {
      q: `repo:${repo} is:pr is:merged author:${login} merged:<${createdAt}`,
      per_page: 1,
    });
    return res.data.total_count;
  } catch (err) {
    console.warn(`[collect] merged-PR search failed for ${login}: ${(err as Error).message}`);
    return null;
  }
}

export async function upsertItem(db: pg.Pool, raw: Item, nightId: number | null, opts: { corpusOnly?: boolean } = {}): Promise<void> {
  const i = scrubDeep(raw);
  const corpusOnly = opts.corpusOnly ?? false;
  await db.query(
    `INSERT INTO items (repo, number, kind, title, body, author, author_association, author_account_age_days,
       author_prior_merged, state, draft, labels, additions, deletions, files_changed, has_tests, ci_status,
       created_at, updated_at, closed_at, merged_at, raw, first_seen_night, last_seen_night, corpus_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23,$24)
     ON CONFLICT (repo, number) DO UPDATE SET
       kind = EXCLUDED.kind, title = EXCLUDED.title, body = EXCLUDED.body,
       author_association = EXCLUDED.author_association,
       author_account_age_days = COALESCE(EXCLUDED.author_account_age_days, items.author_account_age_days),
       author_prior_merged = COALESCE(EXCLUDED.author_prior_merged, items.author_prior_merged),
       state = EXCLUDED.state, draft = EXCLUDED.draft, labels = EXCLUDED.labels,
       additions = COALESCE(EXCLUDED.additions, items.additions),
       deletions = COALESCE(EXCLUDED.deletions, items.deletions),
       files_changed = COALESCE(EXCLUDED.files_changed, items.files_changed),
       has_tests = COALESCE(EXCLUDED.has_tests, items.has_tests),
       ci_status = COALESCE(EXCLUDED.ci_status, items.ci_status),
       updated_at = EXCLUDED.updated_at,
       closed_at = EXCLUDED.closed_at, merged_at = EXCLUDED.merged_at, raw = EXCLUDED.raw,
       first_seen_night = COALESCE(items.first_seen_night, EXCLUDED.first_seen_night),
       last_seen_night = COALESCE(EXCLUDED.last_seen_night, items.last_seen_night),
       -- A backfill never demotes an item the real collector already queued.
       corpus_only = items.corpus_only AND EXCLUDED.corpus_only,
       collected_at = now()`,
    [
      i.repo, i.number, i.kind, i.title, i.body, i.author, i.authorAssociation, i.authorAccountAgeDays,
      i.authorPriorMerged, i.state, i.draft, i.labels, i.additions, i.deletions, i.filesChanged, i.hasTests,
      i.ciStatus, i.createdAt, i.updatedAt, i.closedAt, i.mergedAt, JSON.stringify(i.raw), nightId, corpusOnly,
    ],
  );
}

async function mapLimit<T>(xs: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (next < xs.length) await fn(xs[next++]!);
  });
  await Promise.all(workers);
}
