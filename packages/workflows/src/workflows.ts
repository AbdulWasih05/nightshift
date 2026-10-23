// nightlyTriage: collect -> claim backlog -> embed -> triage (chunked, resumable) -> digest. Deterministic
// orchestration only; all I/O is in activities. A failed repo or phase degrades the night to "partial" instead of
// failing it, the digest is always attempted, and finishNight always runs once the night row exists.
import { ActivityFailure, ApplicationFailure, log, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from './activities.ts';

// DB-only steps: retry until Postgres is back (Docker restarting after wake can take minutes), up to 3 hours.
const db = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '3 hours',
  retry: { initialInterval: '10s', backoffCoefficient: 2, maximumInterval: '5 minutes' }, // unlimited attempts, bounded by scheduleToClose
});

// GitHub: rate limits fail the request after 120s (see github/client.ts); back off and retry here.
// Heartbeats per page and per item, so after laptop sleep the stale attempt is cancelled, not raced.
const github = proxyActivities<typeof activities>({
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '5 minutes',
  retry: { initialInterval: '1 minute', backoffCoefficient: 2, maximumInterval: '15 minutes', maximumAttempts: 6 },
});

// Ollama: ~50-60s per item. Heartbeat per item; a gap means the worker or laptop stopped, and the retry resumes at
// the first untriaged item. "No model answered" also fails the activity, so Temporal backs off until Ollama is back.
// No attempt cap: night 5 used up 10 attempts (~1h) while the laptop was starved for memory, and stopped with
// 280 items untriaged. Retry for as long as the night can still be useful, every 10 minutes at most.
const model = proxyActivities<typeof activities>({
  startToCloseTimeout: '3 hours',
  scheduleToCloseTimeout: '10 hours',
  heartbeatTimeout: '20 minutes',
  retry: { initialInterval: '1 minute', backoffCoefficient: 2, maximumInterval: '10 minutes' },
});

export interface NightlyInput {
  /** Override the configured repos (e.g. a test run on one repo). */
  repos?: string[];
  chunkSize?: number;
  /** Override the per-repo cap (test runs). When capped, the cursor stops early and the rest is collected next night. */
  maxItemsPerRepo?: number;
}

export interface NightlyResult {
  nightId: number;
  status: 'ok' | 'partial' | 'failed';
  collected: Record<string, number>;
  backlogClaimed: number;
  failedRepos: string[];
  triaged: number;
  triageFailed: number;
  digestPath: string | null;
  summary: string | null;
}

function describe(err: unknown): string {
  if (err instanceof ActivityFailure) return `${err.activityType}: ${err.cause?.message ?? err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export async function nightlyTriage(input: NightlyInput = {}): Promise<NightlyResult> {
  const config = await db.loadNightConfig();
  const repos = input.repos?.length ? input.repos : config.repos;
  const unknown = repos.filter((r) => !config.repos.includes(r));
  if (unknown.length) throw ApplicationFailure.nonRetryable(`repos not in nightshift.config.json: ${unknown.join(', ')}`);

  // Set by Temporal on schedule-started runs (including `temporal schedule trigger`).
  const scheduledBy = workflowInfo().searchAttributes?.TemporalScheduledById;
  const trigger = Array.isArray(scheduledBy) && scheduledBy.length > 0 ? 'scheduled' : 'manual';
  const nightId = await db.startNight({ repos, promptVersion: config.promptVersion, trigger });
  log.info('night started', { nightId, repos, trigger });

  const notes: string[] = [];
  const result: NightlyResult = {
    nightId, status: 'ok', collected: {}, backlogClaimed: 0, failedRepos: [], triaged: 0, triageFailed: 0, digestPath: null, summary: null,
  };
  let crashed: unknown = null;

  try {
    // 1. Collect, one repo at a time: GitHub is not the bottleneck, and parallel repos share one search budget.
    for (const repo of repos) {
      try {
        const maxItems = input.maxItemsPerRepo ?? config.maxItemsPerRepo;
        const c = await github.collect({ repo, nightId, maxItems, initialLookbackHours: config.initialLookbackHours });
        result.collected[repo] = c.collected;
        if (c.capped) notes.push(`${repo} capped at ${maxItems}; rest next night`);
        if (c.errors) notes.push(`${repo}: ${c.errors} items failed enrichment`);
      } catch (err) {
        result.failedRepos.push(repo);
        notes.push(`collect ${repo} failed: ${describe(err)}`);
      }
    }

    // 2. Claim the backlog: items collected outside a night, or left over by a partial night.
    result.backlogClaimed = await db.claimBacklog({ nightId, repos, promptVersion: config.promptVersion });
    if (result.backlogClaimed) notes.push(`claimed ${result.backlogClaimed} backlog items`);

    // 3. Embed for duplicate search. Non-fatal: triage still runs, with weaker duplicate evidence.
    try {
      await model.embed({ repos });
    } catch (err) {
      notes.push(`embed failed: ${describe(err)}`);
    }

    // 4. Triage in chunks until the night's queue is empty. Each chunk is a separately retried activity.
    const size = input.chunkSize ?? 10;
    try {
      for (;;) {
        const chunk = await model.triageChunk({ nightId, repos, promptVersion: config.promptVersion, size });
        result.triaged += chunk.processed;
        result.triageFailed += chunk.failed;
        if (chunk.remaining === 0) break;
        if (chunk.processed === 0) {
          notes.push(`triage stopped with ${chunk.remaining} items unprocessed (a whole chunk failed)`);
          break;
        }
      }
    } catch (err) {
      notes.push(`triage failed: ${describe(err)}`);
    }
  } catch (err) {
    crashed = err;
    notes.push(`night crashed: ${describe(err)}`);
  } finally {
    if (crashed || result.failedRepos.length === repos.length) result.status = 'failed';
    else if (notes.some((n) => /failed|unprocessed/.test(n)) || result.triageFailed > 0) result.status = 'partial';

    // 5. Digest, always attempted, even for a partial or failed night.
    try {
      const d = await db.writeDigest({ nightId });
      result.digestPath = d.path;
      result.summary = d.summary;
    } catch (err) {
      notes.push(`digest failed: ${describe(err)}`);
      if (result.status === 'ok') result.status = 'partial';
    }
    await db.finishNight({ nightId, status: result.status, notes: notes.join('\n') || 'clean run' });
  }
  if (crashed) throw crashed;
  return result;
}
