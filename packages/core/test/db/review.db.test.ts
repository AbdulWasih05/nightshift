// The approval gate: nothing reaches GitHub without an approval row, partner repos never, and never twice.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { WriteNotAllowedError } from '../../src/allowlist.ts';
import type { GitHub } from '../../src/github/client.ts';
import { NotApprovedError, postApproved, recordApproval, recordLabel } from '../../src/review.ts';
import { freshTestDb } from './helpers.ts';

let db: pg.Pool | null = null;
const calls: { owner: string; repo: string; issue_number: number; body: string }[] = [];
const fakeGh = {
  issues: {
    createComment: async (args: (typeof calls)[number]) => {
      calls.push(args);
      return { data: { html_url: `https://github.com/${args.owner}/${args.repo}/issues/${args.issue_number}#c${calls.length}` } };
    },
  },
} as unknown as GitHub;

async function triageRow(repo: string, number: number, draft: string | null): Promise<number> {
  const { rows } = await db!.query<{ id: number }>(
    `WITH i AS (
       INSERT INTO items (repo, number, kind, title, body, author, state, created_at, updated_at, raw)
       VALUES ($1, $2, 'issue', 't', 'b', 'u', 'open', now(), now(), '{}') RETURNING id)
     INSERT INTO triage (item_id, prompt_version, bucket, reason, draft_reply, input, parse_ok, model_path)
     SELECT id, 'v1', 'NEEDS_TESTS_OR_INFO', 'r', $3, '{}', true, 'gemma3:4b' FROM i RETURNING id`,
    [repo, number, draft],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  db = await freshTestDb('review');
});
afterAll(async () => {
  await db?.end();
});

describe.skipIf(!process.env.DATABASE_URL)('approval gate (needs Postgres)', () => {
  it('refuses to post without an approval', async () => {
    if (!db) return;
    const id = await triageRow('AbdulWasih05/nightshift', 1, 'Could you add a test?');
    await expect(postApproved(db, fakeGh, { triageId: id, actor: 'm' })).rejects.toBeInstanceOf(NotApprovedError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a partner repo even when approved, before any network call', async () => {
    if (!db) return;
    const id = await triageRow('mastra-ai/mastra', 2, 'Could you add a test?');
    await recordApproval(db, { triageId: id, action: 'approve', actor: 'm' });
    await expect(postApproved(db, fakeGh, { triageId: id, actor: 'm' })).rejects.toBeInstanceOf(WriteNotAllowedError);
    expect(calls).toHaveLength(0);
  });

  it('posts the approved (or edited) text once, records the URL, refuses a second post', async () => {
    if (!db) return;
    const id = await triageRow('AbdulWasih05/nightshift', 3, 'Draft text');
    await recordApproval(db, { triageId: id, action: 'edit', finalText: 'Edited by the maintainer', actor: 'm' });
    const url = await postApproved(db, fakeGh, { triageId: id, actor: 'm' });
    expect(url).toContain('/issues/3');
    expect(calls.at(-1)).toMatchObject({ owner: 'AbdulWasih05', repo: 'nightshift', issue_number: 3, body: 'Edited by the maintainer' });
    await expect(postApproved(db, fakeGh, { triageId: id, actor: 'm' })).rejects.toThrow(/already posted/);
    expect(calls).toHaveLength(1);
  });

  it('a later skip revokes an approval', async () => {
    if (!db) return;
    const id = await triageRow('AbdulWasih05/nightshift', 4, 'Draft');
    await recordApproval(db, { triageId: id, action: 'approve', actor: 'm' });
    await recordApproval(db, { triageId: id, action: 'skip', actor: 'm' });
    await expect(postApproved(db, fakeGh, { triageId: id, actor: 'm' })).rejects.toThrow(/latest decision: skip/);
  });

  it('cannot approve an item with no draft; labels validate bucket and reason', async () => {
    if (!db) return;
    const id = await triageRow('AbdulWasih05/nightshift', 5, null);
    await expect(recordApproval(db, { triageId: id, action: 'approve', actor: 'm' })).rejects.toThrow(/no draft/);
    await expect(recordLabel(db, { repo: 'AbdulWasih05/nightshift', number: 5, bucket: 'MAYBE', reason: 'x', labeller: 'm' })).rejects.toThrow(/bucket/);
    await expect(recordLabel(db, { repo: 'AbdulWasih05/nightshift', number: 5, bucket: 'needs_human', reason: ' ', labeller: 'm' })).rejects.toThrow(/reason/);
    await recordLabel(db, { repo: 'AbdulWasih05/nightshift', number: 5, bucket: 'needs_human', reason: 'design call', labeller: 'm' });
  });
});
