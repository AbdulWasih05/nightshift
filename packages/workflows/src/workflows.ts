// nightlyTriage: collect -> embed -> triage (chunked, resumable) -> digest. Deterministic orchestration only;
// all I/O is in activities. A failed repo or phase degrades the night to "partial" instead of failing it,
// and the digest is always written so the maintainer sees what happened.
import { ActivityFailure, ApplicationFailure, log, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from './activities.ts';

const quick = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { initialInterval: '10s', backoffCoefficient: 2, maximumAttempts: 5 },
});

// GitHub: rate limits fail the request after 120s (see github/client.ts); back off and retry here.
const github = proxyActivities<typeof activities>({
  startToCloseTimeout: '45 minutes',
  retry: { initialInterval: '1 minute', backoffCoefficient: 2, maximumInterval: '15 minutes', maximumAttempts: 6 },
});

// Ollama: the 4B model takes ~50-60s per item. Heartbeat per item; a heartbeat gap means the worker or
// laptop stopped, and the retry resumes at the first untriaged item.
const model = proxyActivities<typeof activities>({
  startToCloseTimeout: '3 hours',
  heartbeatTimeout: '20 minutes',
  retry: { initialInterval: '1 minute', backoffCoefficient: 2, maximumInterval: '10 minutes', maximumAttempts: 10 },
});

export interface NightlyInput {
  /** Override the configured repos (e.g. a test run on one repo). */
  repos?: string[];
  chunkSize?: number;
}

export interface NightlyResult {
  nightId: number;
  status: 'ok' | 'partial' | 'failed';
  collected: Record<string, number>;
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
  const config = await quick.loadNightConfig();
  const repos = input.repos?.length ? input.repos : config.repos;
  const unknown = repos.filter((r) => !config.repos.includes(r));
  if (unknown.length) throw ApplicationFailure.nonRetryable(`repos not in nightshift.config.json: ${unknown.join(', ')}`);

  const nightId = await quick.startNight({ repos, promptVersion: config.promptVersion });
  log.info('night started', { nightId, repos, run: workflowInfo().runId });
  const notes: string[] = [];
  const result: NightlyResult = {
    nightId, status: 'ok', collected: {}, failedRepos: [], triaged: 0, triageFailed: 0, digestPath: null, summary: null,
  };

  // 1. Collect, one activity per repo so one repo's outage does not cost the others.
  await Promise.all(
    repos.map(async (repo) => {
      try {
        const c = await github.collect({ repo, nightId, maxItems: config.maxItemsPerRepo, initialLookbackHours: config.initialLookbackHours });
        result.collected[repo] = c.collected;
        if (c.capped) notes.push(`${repo} capped at ${config.maxItemsPerRepo}; rest next night`);
        if (c.errors) notes.push(`${repo}: ${c.errors} items failed enrichment`);
      } catch (err) {
        result.failedRepos.push(repo);
        notes.push(`collect ${repo} failed: ${describe(err)}`);
      }
    }),
  );

  // 2. Embed for duplicate search. Non-fatal: triage still runs, with weaker duplicate evidence.
  try {
    await model.embed({ repos });
  } catch (err) {
    notes.push(`embed failed: ${describe(err)}`);
  }

  // 3. Triage in chunks until the night's queue is empty. Each chunk is a separately retried activity.
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

  if (result.failedRepos.length === repos.length) result.status = 'failed';
  else if (notes.some((n) => /failed|unprocessed/.test(n)) || result.triageFailed > 0) result.status = 'partial';

  // 4. Digest, always, even for a partial night.
  try {
    const d = await quick.writeDigest({ nightId });
    result.digestPath = d.path;
    result.summary = d.summary;
  } catch (err) {
    notes.push(`digest failed: ${describe(err)}`);
    if (result.status === 'ok') result.status = 'partial';
  }

  await quick.finishNight({ nightId, status: result.status, notes: notes.join('\n') || 'clean run' });
  return result;
}
