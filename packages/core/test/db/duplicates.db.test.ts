// Hybrid search on a seeded corpus in a throwaway database. Vectors are hand-built so each case is
// unambiguous: one pair both halves find, one only the vector half finds, one only the keyword half finds.
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

const corpus = [
  { number: 1, title: 'Workflow retry policy ignored when activity times out', v: vec(0) },
  { number: 2, title: 'Retry policy not applied after activity timeout in workflow', v: vec(0, 0.15) },
  { number: 3, title: 'Crash on startup with nil pointer in matching service', v: vec(10) },
  { number: 4, title: 'Matching panics at boot', v: vec(10, 0.2) },
  { number: 5, title: 'Docs: explain workflow retry policy for activity timeouts', v: vec(20) },
  { number: 6, title: 'Bump grpc to 1.66', v: vec(30) },
];

beforeAll(async () => {
  db = await freshTestDb();
  if (!db) return;
  for (const c of corpus) {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO items (repo, number, kind, title, body, author, state, created_at, updated_at, raw)
       VALUES ('t/r', $1, 'issue', $2, '', 'u', 'open', now(), now(), '{}') RETURNING id`,
      [c.number, c.title],
    );
    await db.query(`INSERT INTO embeddings (item_id, model, input_hash, embedding) VALUES ($1, 'test', 'h', $2::vector)`, [
      rows[0]!.id,
      toVectorLiteral(c.v),
    ]);
  }
  // Same title in another repo must never be offered.
  await db.query(
    `INSERT INTO items (repo, number, kind, title, body, author, state, created_at, updated_at, raw)
     VALUES ('other/repo', 1, 'issue', 'Workflow retry policy ignored when activity times out', '', 'u', 'open', now(), now(), '{}')`,
  );
});

afterAll(async () => {
  await db?.end();
});

async function dupsOf(number: number) {
  const { rows } = await db!.query<{ id: number }>(`SELECT id FROM items WHERE repo = 't/r' AND number = $1`, [number]);
  return findDuplicates(db!, rows[0]!.id, 5);
}

describe.skipIf(!process.env.DATABASE_URL)('hybrid duplicate search (needs Postgres)', () => {
  it('finds the known duplicate pair with both halves', async () => {
    if (!db) return;
    const d = await dupsOf(1);
    expect(d[0]).toMatchObject({ number: 2, source: 'both' });
  });

  it('vector-only catch: same bug, no shared title words', async () => {
    if (!db) return;
    const d = await dupsOf(3);
    const hit = d.find((x) => x.number === 4);
    expect(hit?.source).toBe('vector');
    expect(hit!.sharedTerms.length).toBeLessThan(3);
  });

  it('keyword-only catch: shares the terms, different embedding', async () => {
    if (!db) return;
    const d = await dupsOf(1);
    expect(d.find((x) => x.number === 5)?.source).toBe('keyword');
  });

  it('unrelated item gets no candidates, other repos are never offered', async () => {
    if (!db) return;
    expect(await dupsOf(6)).toEqual([]);
    const d = await dupsOf(1);
    expect(d.every((x) => x.number !== 1)).toBe(true);
  });
});
