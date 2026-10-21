import { describe, expect, it } from 'vitest';
import { PAGE_SIZE, scanSince, type ListedIssue } from '../src/paginate.ts';

// A fake GitHub issues listing: `since` inclusive, sorted by updated_at asc then number, offset pages.
class FakeRepo {
  items = new Map<number, string>();
  set(number: number, minute: number) {
    this.items.set(number, ts(minute));
  }
  list(since: string, page: number): ListedIssue[] {
    const all = [...this.items]
      .map(([number, updated_at]) => ({ number, updated_at }))
      .filter((i) => i.updated_at >= since)
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.number - b.number);
    return all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }
}

const ts = (minute: number) => new Date(Date.UTC(2026, 9, 21, 0, 0) + minute * 60_000).toISOString();

/** Simulates the DB: what we stored, keyed by number -> updated_at. */
function store() {
  const db = new Map<number, string>();
  return {
    db,
    unchanged: async (xs: ListedIssue[]) => new Set(xs.filter((x) => db.get(x.number) === x.updated_at).map((x) => x.number)),
    save: (xs: ListedIssue[]) => xs.forEach((x) => db.set(x.number, x.updated_at)),
  };
}

describe('scanSince', () => {
  it('collects everything across pages and nothing twice', async () => {
    const repo = new FakeRepo();
    for (let n = 1; n <= 250; n++) repo.set(n, n);
    const s = store();
    const r = await scanSince({ since: ts(0), max: 1000, fetchPage: async (a, p) => repo.list(a, p), unchanged: s.unchanged });
    expect(r.changed.map((i) => i.number)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
    expect(r.capped).toBe(false);
    expect(r.cursor).toBe(ts(250));
  });

  it('two consecutive runs: second run sees only new or updated items', async () => {
    const repo = new FakeRepo();
    for (let n = 1; n <= 30; n++) repo.set(n, n);
    const s = store();
    const run1 = await scanSince({ since: ts(0), max: 1000, fetchPage: async (a, p) => repo.list(a, p), unchanged: s.unchanged });
    s.save(run1.changed);
    repo.set(5, 100); // old item updated
    repo.set(31, 101); // new item
    const run2 = await scanSince({ since: run1.cursor, max: 1000, fetchPage: async (a, p) => repo.list(a, p), unchanged: s.unchanged });
    expect(run2.changed.map((i) => i.number).sort((a, b) => a - b)).toEqual([5, 31]);
  });

  it('cap: remainder is collected next run, nothing skipped', async () => {
    const repo = new FakeRepo();
    for (let n = 1; n <= 50; n++) repo.set(n, n);
    const s = store();
    const run1 = await scanSince({ since: ts(0), max: 20, fetchPage: async (a, p) => repo.list(a, p), unchanged: s.unchanged });
    expect(run1.capped).toBe(true);
    s.save(run1.changed);
    const run2 = await scanSince({ since: run1.cursor, max: 20, fetchPage: async (a, p) => repo.list(a, p), unchanged: s.unchanged });
    s.save(run2.changed);
    const run3 = await scanSince({ since: run2.cursor, max: 20, fetchPage: async (a, p) => repo.list(a, p), unchanged: s.unchanged });
    const all = [...run1.changed, ...run2.changed, ...run3.changed].map((i) => i.number);
    expect(new Set(all).size).toBe(50);
    expect(all).toHaveLength(50);
    expect(run3.capped).toBe(false);
  });

  it('item updated mid-pagination is not skipped', async () => {
    const repo = new FakeRepo();
    for (let n = 1; n <= 150; n++) repo.set(n, n);
    let calls = 0;
    const fetchPage = async (a: string, p: number) => {
      const page = repo.list(a, p);
      if (++calls === 1) repo.set(10, 500); // #10 (already on page 1) is updated before page 2 is fetched
      return page;
    };
    const s = store();
    const r = await scanSince({ since: ts(0), max: 1000, fetchPage, unchanged: s.unchanged });
    const nums = r.changed.map((i) => i.number);
    expect(new Set(nums).size).toBe(150);
    expect(r.changed.find((i) => i.number === 10)!.updated_at).toBe(ts(500));
  });

  it('a full page sharing one timestamp does not stall the cursor', async () => {
    const repo = new FakeRepo();
    for (let n = 1; n <= 230; n++) repo.set(n, 7); // bot relabelled 230 items in the same second
    repo.set(231, 8);
    const s = store();
    const r = await scanSince({ since: ts(0), max: 1000, fetchPage: async (a, p) => repo.list(a, p), unchanged: s.unchanged });
    expect(r.changed).toHaveLength(231);
    expect(r.cursor).toBe(ts(8));
  });
});
