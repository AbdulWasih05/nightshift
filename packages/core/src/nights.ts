import type pg from 'pg';

export type NightStatus = 'running' | 'ok' | 'partial' | 'failed';

/** Idempotent per workflow run: a retried activity gets the same night back. */
export async function startNight(
  db: pg.Pool,
  repos: string[],
  promptVersion: string,
  workflowRunId: string | null = null,
  trigger: 'scheduled' | 'manual' = 'manual',
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO nights (repos, prompt_version, workflow_run_id, trigger) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workflow_run_id) DO UPDATE SET workflow_run_id = EXCLUDED.workflow_run_id
     RETURNING id`,
    [repos, promptVersion, workflowRunId, trigger],
  );
  return rows[0]!.id;
}

export async function finishNight(db: pg.Pool, nightId: number, status: Exclude<NightStatus, 'running'>, notes: string): Promise<void> {
  await db.query('UPDATE nights SET finished_at = now(), status = $2, notes = $3 WHERE id = $1', [nightId, status, notes]);
}

/** Open items this night's collection saw change, with no triage row yet for this night. */
export async function countPendingForNight(db: pg.Pool, nightId: number, promptVersion: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM items i
      WHERE i.last_seen_night = $1 AND i.state = 'open' AND NOT i.corpus_only
        AND NOT EXISTS (SELECT 1 FROM triage t WHERE t.item_id = i.id AND t.night_id = $1 AND t.prompt_version = $2)`,
    [nightId, promptVersion],
  );
  return Number(rows[0]!.n);
}
