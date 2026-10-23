// Hybrid search on a seeded corpus in a throwaway database. Vectors are hand-built so each case is
// unambiguous: one pair both halves find, one only the vector half finds, one only the keyword half finds,
// plus the false positives the gate must reject (PR vs the issue it fixes, newer items, other repos).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { findDuplicates } from '../../src/duplicates.ts';
import { toVectorLiteral, EMBED_DIMS } from '../../src/embed.ts';
import { freshTestDb } from './helpers.ts';

let db: pg.Pool | null = null;

/** Unit vector along axis `a`, nudged slightly toward axis `b` so near-duplicates are close but not identical. */
function vec(a: number, nudge = 0, b = (a + 1) % EMBED_DIMS): number[] {
  const v = new Array(EMBED_DIMS).fill(0);
  v[a] = 1;
  v[b] = nudge;
  return v;
}

// `number` order = creation order: a duplicate must be OLDER than the item it duplicates.
const corpus: { number: number; kind: 'issue' | 'pr'; title: string; body?: string; v: number[] }[] = [
  { number: 1, kind: 'issue', title: 'Workflow retry policy ignored when activity times out', v: vec(0) },
  { number: 2, kind: 'issue', title: 'Retry policy not applied after activity timeout in workflow', v: vec(0, 0.15) },
  { number: 3, kind: 'issue', title: 'Crash on startup with nil pointer in matching service', v: vec(10) },
  { number: 4, kind: 'issue', title: 'Matching panics at boot', v: vec(10, 0.2) },
  { number: 5, kind: 'issue', title: 'Docs: explain workflow retry policy for activity timeouts', v: vec(20) },
  { number: 6, kind: 'issue', title: 'Bump grpc to 1.66', v: vec(30) },
  { number: 7, kind: 'pr', title: 'Fix retry policy ignored when activity times out', body: 'Fixes #1', v: vec(0, 0.1) },
  { number: 8, kind: 'issue', title: 'Per-namespace limits for per-namespace workers', v: vec(40) },
  { number: 9, kind: 'issue', title: 'Per-namespace worker options', v: vec(50) },
];

beforeAll(async () => {
  db = await freshTestDb('duplicates');
  if (!db) return;
  for (const c of corpus) {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO items (repo, number, kind, title, body, author, state, created_at, updated_at, raw)
       VALUES ('t/r', $1, $2, $3, $4, 'u', 'open', now() - make_interval(mins => 100 - $1), now(), '{}') RETURNING id`,
      [c.number, c.kind, c.title, c.body ?? ''],
    );
    await db.query(`INSERT INTO embeddings (item_id, model, input_hash, embedding) VALUES ($1, 'test', 'h', $2::vector)`, [
      rows[0]!.id,
      toVectorLiteral(c.v),
    ]);
  }
  // Same title in another repo must never be offered.
  await db.query(
    `INSERT INTO items (repo, number, kind, title, body, author, state, created_at, updated_at, raw)
     VALUES ('other/repo', 1, 'issue', 'Retry policy not applied after activity timeout in workflow', '', 'u', 'open', now() - interval '1 day', now(), '{}')`,
  );
});

afterAll(async () => {
  await db?.end();
});

async function dupsOf(number: number) {
  const { rows } = await db!.query<{ id: number }>(`SELECT id FROM items WHERE repo = 't/r' AND number = $1`, [number]);
  return findDuplicates(db!, rows[0]!.id, 5);
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('hybrid duplicate search (needs Postgres)', () => {
  it('finds the known duplicate pair with both halves', async () => {
    if (!db) return;
    const d = await dupsOf(2);
    expect(d[0]).toMatchObject({ number: 1, source: 'both' });
    expect(d[0]!.similarity).toBeGreaterThan(0.9);
  });

  it('vector-only catch: same bug, no shared title words', async () => {
    if (!db) return;
    const hit = (await dupsOf(4)).find((x) => x.number === 3);
    expect(hit?.source).toBe('vector');
  });

  it('keyword-only catch: shares 4+ title terms, different embedding; similarity is null, not 0', async () => {
    if (!db) return;
    const hit = (await dupsOf(5)).find((x) => x.number === 1);
    expect(hit?.source).toBe('keyword');
    expect(hit?.similarity).toBeNull();
  });

  it('a PR is never offered the issue it fixes (different kind, and referenced)', async () => {
    if (!db) return;
    expect((await dupsOf(7)).map((x) => x.number)).not.toContain(1);
  });

  it('only older items are candidates', async () => {
    if (!db) return;
    expect((await dupsOf(1)).map((x) => x.number)).toEqual([]);
  });

  it('a hyphenated word does not count as three shared terms', async () => {
    if (!db) return;
    // "per-namespace" + "worker" overlap only: 2 real terms, below every keyword gate, orthogonal vectors.
    expect((await dupsOf(9)).map((x) => x.number)).not.toContain(8);
  });

  it('unrelated item gets no candidates, other repos are never offered', async () => {
    if (!db) return;
    expect(await dupsOf(6)).toEqual([]);
  });
});
