// The human side: labels (ground truth for eval), and the approval gate in front of every GitHub write.
// Nothing reaches GitHub unless (1) the repo is in the hard write allowlist and (2) an `approvals` row with
// action approve/edit exists for that exact triage row. Posting then records a `post` row with the URL.
import type pg from 'pg';
import { assertWritable } from './allowlist.ts';
import type { GitHub } from './github/client.ts';
import { BUCKETS, type Bucket } from './types.ts';

export async function recordLabel(
  db: pg.Pool,
  args: { repo: string; number: number; bucket: string; reason: string; labeller: string },
): Promise<void> {
  const bucket = args.bucket.toUpperCase();
  if (!(BUCKETS as readonly string[]).includes(bucket)) throw new Error(`bucket must be one of ${BUCKETS.join(', ')}`);
  if (!args.reason.trim()) throw new Error('a one-line reason is required');
  const { rowCount } = await db.query(
    `INSERT INTO labels_human (item_id, bucket, reason, labeller)
     SELECT id, $3, $4, $5 FROM items WHERE repo = $1 AND number = $2
     ON CONFLICT (item_id) DO UPDATE SET bucket = EXCLUDED.bucket, reason = EXCLUDED.reason,
       labeller = EXCLUDED.labeller, created_at = now()`,
    [args.repo, args.number, bucket as Bucket, args.reason.trim(), args.labeller],
  );
  if (!rowCount) throw new Error(`${args.repo}#${args.number} has not been collected`);
}

export interface TriageForReview {
  triage_id: number;
  repo: string;
  number: number;
  kind: 'pr' | 'issue';
  title: string;
  bucket: Bucket;
  reason: string;
  draft_reply: string | null;
  label_bucket: Bucket | null;
}

/** Items of a night still without a human label, in digest order. */
export async function unlabelled(db: pg.Pool, nightId: number): Promise<TriageForReview[]> {
  const { rows } = await db.query<TriageForReview>(
    `SELECT t.id AS triage_id, i.repo, i.number, i.kind, i.title, t.bucket, t.reason, t.draft_reply, l.bucket AS label_bucket
       FROM triage t JOIN items i ON i.id = t.item_id LEFT JOIN labels_human l ON l.item_id = t.item_id
      WHERE t.night_id = $1 AND l.item_id IS NULL
      ORDER BY i.repo, i.number`,
    [nightId],
  );
  return rows;
}

export async function recordApproval(
  db: pg.Pool,
  args: { triageId: number; action: 'approve' | 'edit' | 'skip'; finalText?: string | null; actor: string },
): Promise<void> {
  const t = await db.query<{ draft_reply: string | null }>('SELECT draft_reply FROM triage WHERE id = $1', [args.triageId]);
  if (!t.rows[0]) throw new Error(`triage ${args.triageId} not found`);
  if (args.action !== 'skip' && !(args.finalText ?? t.rows[0].draft_reply)) throw new Error(`triage ${args.triageId} has no draft to approve`);
  const text = args.action === 'skip' ? null : (args.finalText ?? t.rows[0].draft_reply);
  await db.query('INSERT INTO approvals (triage_id, action, final_text, actor) VALUES ($1, $2, $3, $4)', [
    args.triageId, args.action, text, args.actor,
  ]);
}

export class NotApprovedError extends Error {}

/**
 * Post an approved reply as a comment. Refuses unless the repo is allowlisted AND the latest approval for this
 * triage row is approve/edit (a later skip revokes it) AND it has not been posted already.
 */
export async function postApproved(db: pg.Pool, gh: GitHub, args: { triageId: number; actor: string }): Promise<string> {
  const { rows } = await db.query<{ repo: string; number: number; action: string | null; final_text: string | null; posted: string | null }>(
    `SELECT i.repo, i.number,
            (SELECT a.action FROM approvals a WHERE a.triage_id = t.id AND a.action <> 'post' ORDER BY a.id DESC LIMIT 1) AS action,
            (SELECT a.final_text FROM approvals a WHERE a.triage_id = t.id AND a.action <> 'post' ORDER BY a.id DESC LIMIT 1) AS final_text,
            (SELECT a.posted_url FROM approvals a WHERE a.triage_id = t.id AND a.action = 'post' LIMIT 1) AS posted
       FROM triage t JOIN items i ON i.id = t.item_id WHERE t.id = $1`,
    [args.triageId],
  );
  const r = rows[0];
  if (!r) throw new Error(`triage ${args.triageId} not found`);
  assertWritable(r.repo); // partner repos stop here, before any network call
  if (r.posted) throw new NotApprovedError(`already posted: ${r.posted}`);
  if (r.action !== 'approve' && r.action !== 'edit') {
    throw new NotApprovedError(`triage ${args.triageId} is not approved (latest decision: ${r.action ?? 'none'}); run \`nightshift approve ${args.triageId}\` first`);
  }
  if (!r.final_text?.trim()) throw new NotApprovedError('approved text is empty');
  const [owner, repo] = r.repo.split('/') as [string, string];
  const res = await gh.issues.createComment({ owner, repo, issue_number: r.number, body: r.final_text });
  await db.query("INSERT INTO approvals (triage_id, action, final_text, actor, posted_url) VALUES ($1, 'post', $2, $3, $4)", [
    args.triageId, r.final_text, args.actor, res.data.html_url,
  ]);
  return res.data.html_url;
}
