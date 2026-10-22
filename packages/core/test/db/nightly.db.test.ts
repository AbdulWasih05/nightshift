// Night queue and outage handling against a real Postgres.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { claimBacklog, startNight } from '../../src/nights.ts';
import { ModelsUnavailableError } from '../../src/triage/agent.ts';
import { triageBatch } from '../../src/triage/batch.ts';
import { selectPending } from '../../src/triage/store.ts';
import type { ModelSpec } from '../../src/triage/models.ts';
import { freshTestDb } from './helpers.ts';

let db: pg.Pool | null = null;
const models: ModelSpec[] = [{ path: 'gemma3:4b', id: 'ollama/gemma3:4b', url: 'http://x/v1', apiKey: 'k' }];

async function item(number: number, opts: { night?: number | null; state?: string; corpus?: boolean } = {}) {
  await db!.query(
    `INSERT INTO items (repo, number, kind, title, body, author, state, created_at, updated_at, raw, last_seen_night, corpus_only)
     VALUES ('t/r', $1, 'issue', 'title', 'body', 'u', $2, now(), now(), '{}', $3, $4)`,
    [number, opts.state ?? 'open', opts.night ?? null, opts.corpus ?? false],
  );
}

beforeAll(async () => {
  db = await freshTestDb('nightly');
});
afterAll(async () => {
  await db?.end();
});

describe.skipIf(!process.env.DATABASE_URL)('night queue (needs Postgres)', () => {
  it('claims items collected outside a night and leftovers of an earlier night, not closed or corpus items', async () => {
    if (!db) return;
    const n1 = await startNight(db, ['t/r'], 'v1');
    await item(1); // collected by the CLI, never in a night
    await item(2, { night: n1 }); // left over: night 1 stopped before triaging it
    await item(3, { state: 'closed' });
    await item(4, { corpus: true });
    const n2 = await startNight(db, ['t/r'], 'v1');
    expect(await claimBacklog(db, n2, ['t/r'], 'v1')).toBe(2);
    const pending = await selectPending(db, { repos: ['t/r'], promptVersion: 'v1', nightId: n2, limit: 10 });
    expect(pending.map((p) => p.number).sort()).toEqual([1, 2]);
  });

  it('when no model answers, nothing is stored and the batch throws so the night can retry', async () => {
    if (!db) return;
    const n3 = await startNight(db, ['t/r'], 'v1');
    await claimBacklog(db, n3, ['t/r'], 'v1');
    const pending = await selectPending(db, { repos: ['t/r'], promptVersion: 'v1', nightId: n3, limit: 10 });
    await expect(
      triageBatch(db, pending, {
        promptVersion: 'v1', nightId: n3, repos: ['t/r'], skipEmbed: true, models,
        generate: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
        },
      }),
    ).rejects.toBeInstanceOf(ModelsUnavailableError);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM triage WHERE night_id = $1', [n3]);
    expect(rows[0].n).toBe(0);
  });

  it('startNight is idempotent per workflow run id', async () => {
    if (!db) return;
    const a = await startNight(db, ['t/r'], 'v1', 'run-abc', 'scheduled');
    const b = await startNight(db, ['t/r'], 'v1', 'run-abc', 'scheduled');
    expect(a).toBe(b);
  });
});
