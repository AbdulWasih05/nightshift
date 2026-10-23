// Backfilled (corpus-only) items must not be mistaken for already-collected ones.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { unchangedNumbers, upsertItem } from '../../src/collector.ts';
import type { GhIssue } from '../../src/github/map.ts';
import { mapIssue } from '../../src/github/map.ts';
import { freshTestDb } from './helpers.ts';

let db: pg.Pool | null = null;
const issue = (number: number, updated_at: string): GhIssue => ({
  number, title: `t${number}`, body: '', user: { login: 'u' }, state: 'open', labels: [],
  created_at: '2026-10-01T00:00:00Z', updated_at, closed_at: null,
});
const facts = { accountAgeDays: null, priorMerged: null };

beforeAll(async () => {
  db = await freshTestDb('collector');
});
afterAll(async () => {
  await db?.end();
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('collector vs backfill (needs Postgres)', () => {
  it('a backfilled item at the same updated_at is still collected, then becomes unchanged', async () => {
    if (!db) return;
    const i = issue(1, '2026-10-21T10:00:00Z');
    await upsertItem(db, mapIssue('t/r', i, null, facts), null, { corpusOnly: true });
    expect([...(await unchangedNumbers(db, 't/r', [i]))]).toEqual([]);

    await upsertItem(db, mapIssue('t/r', i, null, facts), null);
    expect([...(await unchangedNumbers(db, 't/r', [i]))]).toEqual([1]);
    const { rows } = await db.query('SELECT corpus_only FROM items WHERE number = 1');
    expect(rows[0].corpus_only).toBe(false);
  });

  it('a later backfill never demotes a collected item back to corpus-only', async () => {
    if (!db) return;
    const i = issue(2, '2026-10-21T11:00:00Z');
    await upsertItem(db, mapIssue('t/r', i, null, facts), null);
    await upsertItem(db, mapIssue('t/r', i, null, facts), null, { corpusOnly: true });
    const { rows } = await db.query('SELECT corpus_only FROM items WHERE number = 2');
    expect(rows[0].corpus_only).toBe(false);
  });
});
