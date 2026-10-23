// The approval gate: nothing reaches GitHub without an approval of the exact text shown, partner repos never,
// closed items never, and each GitHub item at most once, even under concurrency or a failed write.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { WriteNotAllowedError } from '../../src/allowlist.ts';
import type { GitHub } from '../../src/github/client.ts';
import { startNight } from '../../src/nights.ts';
import { NotApprovedError, postApproved, recordApproval, recordLabel, textHash, unlabelled } from '../../src/review.ts';
import { freshTestDb } from './helpers.ts';

let db: pg.Pool | null = null;
let night = 0;
const calls: { owner: string; repo: string; issue_number: number; body: string }[] = [];
const fakeGh = (opts: { fail?: boolean; delayMs?: number } = {}) =>
  ({
    issues: {
      createComment: async (args: (typeof calls)[number]) => {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.fail) throw new Error('GitHub 502');
        calls.push(args);
        return { data: { html_url: `https://github.com/${args.owner}/${args.repo}/issues/${args.issue_number}#c${calls.length}` } };
      },
    },
  }) as unknown as GitHub;

async function item(repo: string, number: number, state = 'open'): Promise<number> {
  const { rows } = await db!.query<{ id: number }>(
    `INSERT INTO items (repo, number, kind, title, body, author, state, created_at, updated_at, raw)
     VALUES ($1, $2, 'issue', 't', 'b', 'u', $3, now(), now(), '{}') RETURNING id`,
    [repo, number, state],
  );
  return rows[0]!.id;
}

async function triageRow(itemId: number, draft: string | null, nightId = night): Promise<number> {
  const { rows } = await db!.query<{ id: number }>(
    `INSERT INTO triage (item_id, night_id, prompt_version, bucket, reason, draft_reply, input, parse_ok, model_path)
     VALUES ($1, $2, 'v1', 'NEEDS_TESTS_OR_INFO', 'r', $3, '{}', true, 'gemma3:4b') RETURNING id`,
    [itemId, nightId, draft],
  );
  return rows[0]!.id;
}

const approve = async (id: number, draft: string) => recordApproval(db!, { triageId: id, action: 'approve', shownHash: textHash(draft), actor: 'm' });

beforeAll(async () => {
  db = await freshTestDb('review');
  if (db) night = await startNight(db, ['AbdulWasih05/nightshift'], 'v1');
});
afterAll(async () => {
  await db?.end();
});

describe.skipIf(!process.env.DATABASE_URL)('approval gate (needs Postgres)', () => {
  it('refuses to post without an approval', async () => {
    if (!db) return;
    const id = await triageRow(await item('AbdulWasih05/nightshift', 1), 'Could you add a test?');
    await expect(postApproved(db, fakeGh(), { triageId: id, actor: 'm' })).rejects.toBeInstanceOf(NotApprovedError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a partner repo even when approved, before any network call', async () => {
    if (!db) return;
    const id = await triageRow(await item('mastra-ai/mastra', 2), 'Could you add a test?');
    await approve(id, 'Could you add a test?');
    await expect(postApproved(db, fakeGh(), { triageId: id, actor: 'm' })).rejects.toBeInstanceOf(WriteNotAllowedError);
    expect(calls).toHaveLength(0);
  });

  it('approval requires the hash of the exact text shown; a changed draft is refused', async () => {
    if (!db) return;
    const id = await triageRow(await item('AbdulWasih05/nightshift', 3), 'Short draft');
    await expect(recordApproval(db, { triageId: id, action: 'approve', shownHash: textHash('Short dra'), actor: 'm' })).rejects.toThrow(/hash mismatch/);
    await expect(recordApproval(db, { triageId: id, action: 'approve', actor: 'm' })).rejects.toThrow(/hash mismatch/);
  });

  it('posts the edited text once, records the URL, refuses a second post', async () => {
    if (!db) return;
    const id = await triageRow(await item('AbdulWasih05/nightshift', 4), 'Draft text');
    await recordApproval(db, { triageId: id, action: 'edit', finalText: 'Edited by the maintainer', actor: 'm' });
    const url = await postApproved(db, fakeGh(), { triageId: id, actor: 'm' });
    expect(url).toContain('/issues/4');
    expect(calls.at(-1)).toMatchObject({ owner: 'AbdulWasih05', repo: 'nightshift', issue_number: 4, body: 'Edited by the maintainer' });
    await expect(postApproved(db, fakeGh(), { triageId: id, actor: 'm' })).rejects.toThrow(/already posted/);
  });

  it('two concurrent posts produce exactly one comment', async () => {
    if (!db) return;
    const id = await triageRow(await item('AbdulWasih05/nightshift', 5), 'Concurrent');
    await approve(id, 'Concurrent');
    const before = calls.length;
    const results = await Promise.allSettled([
      postApproved(db, fakeGh({ delayMs: 50 }), { triageId: id, actor: 'm' }),
      postApproved(db, fakeGh({ delayMs: 50 }), { triageId: id, actor: 'm' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(calls.length - before).toBe(1);
  });

  it('a later night’s row for the same item cannot post again', async () => {
    if (!db) return;
    const itemId = await item('AbdulWasih05/nightshift', 6);
    const first = await triageRow(itemId, 'Night A');
    await approve(first, 'Night A');
    await postApproved(db, fakeGh(), { triageId: first, actor: 'm' });
    const night2 = await startNight(db, ['AbdulWasih05/nightshift'], 'v1');
    const second = await triageRow(itemId, 'Night B', night2);
    await approve(second, 'Night B');
    await expect(postApproved(db, fakeGh(), { triageId: second, actor: 'm' })).rejects.toThrow(/already posted/);
  });

  it('a closed item is never posted to', async () => {
    if (!db) return;
    const id = await triageRow(await item('AbdulWasih05/nightshift', 7, 'closed'), 'Closed');
    await approve(id, 'Closed');
    await expect(postApproved(db, fakeGh(), { triageId: id, actor: 'm' })).rejects.toThrow(/closed/);
  });

  it('a failed GitHub call leaves the claim, so a retry cannot double-post', async () => {
    if (!db) return;
    const id = await triageRow(await item('AbdulWasih05/nightshift', 8), 'Will fail');
    await approve(id, 'Will fail');
    await expect(postApproved(db, fakeGh({ fail: true }), { triageId: id, actor: 'm' })).rejects.toThrow(/502/);
    await expect(postApproved(db, fakeGh(), { triageId: id, actor: 'm' })).rejects.toThrow(/in progress or failed; check GitHub/);
  });

  it('a later skip revokes an approval', async () => {
    if (!db) return;
    const id = await triageRow(await item('AbdulWasih05/nightshift', 9), 'Draft');
    await approve(id, 'Draft');
    await recordApproval(db, { triageId: id, action: 'skip', actor: 'm' });
    await expect(postApproved(db, fakeGh(), { triageId: id, actor: 'm' })).rejects.toThrow(/latest decision: skip/);
  });

  it('labels are per night and validated; labelled items leave the review queue for that night only', async () => {
    if (!db) return;
    const itemId = await item('AbdulWasih05/nightshift', 10);
    await triageRow(itemId, null);
    await expect(recordLabel(db, { repo: 'AbdulWasih05/nightshift', number: 10, nightId: night, bucket: 'MAYBE', reason: 'x', labeller: 'm' })).rejects.toThrow(/bucket/);
    await expect(recordLabel(db, { repo: 'AbdulWasih05/nightshift', number: 10, nightId: night, bucket: 'needs_human', reason: ' ', labeller: 'm' })).rejects.toThrow(/reason/);
    await recordLabel(db, { repo: 'AbdulWasih05/nightshift', number: 10, nightId: night, bucket: 'needs_human', reason: 'design call', labeller: 'm' });
    expect((await unlabelled(db, night)).map((r) => r.number)).not.toContain(10);
    const night3 = await startNight(db, ['AbdulWasih05/nightshift'], 'v1');
    await triageRow(itemId, null, night3);
    expect((await unlabelled(db, night3)).map((r) => r.number)).toContain(10);
  });
});
