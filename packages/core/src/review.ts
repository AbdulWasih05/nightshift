// The human side: labels (ground truth for eval), and the approval gate in front of every GitHub write.
// Nothing reaches GitHub unless (1) the repo is in the hard write allowlist, (2) the latest decision on that
// triage row is approve/edit, (3) the approved text is exactly what was shown to the human (hash check),
// (4) the item is still open, and (5) nothing was ever posted to that item before (unique index, claimed
// before the network call).
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { assertWritable, isWritable } from './allowlist.ts';
import type { GitHub } from './github/client.ts';
import { BUCKETS, type Bucket } from './types.ts';

export async function recordLabel(
  db: pg.Pool,
  args: { repo: string; number: number; nightId: number; bucket: string; reason: string; labeller: string },
): Promise<void> {
  const bucket = args.bucket.toUpperCase();
  if (!(BUCKETS as readonly string[]).includes(bucket)) throw new Error(`bucket must be one of ${BUCKETS.join(', ')}`);
  if (!args.reason.trim()) throw new Error('a one-line reason is required');
  const { rowCount } = await db.query(
    `INSERT INTO labels_human (item_id, night_id, bucket, reason, labeller)
     SELECT t.item_id, t.night_id, $4, $5, $6
       FROM triage t JOIN items i ON i.id = t.item_id JOIN nights n ON n.id = t.night_id
      WHERE i.repo = $1 AND i.number = $2 AND t.night_id = $3 AND t.prompt_version = n.prompt_version
     ON CONFLICT (item_id, night_id) DO UPDATE SET bucket = EXCLUDED.bucket, reason = EXCLUDED.reason,
       labeller = EXCLUDED.labeller, created_at = now()`,
    [args.repo, args.number, args.nightId, bucket as Bucket, args.reason.trim(), args.labeller],
  );
  if (!rowCount) throw new Error(`${args.repo}#${args.number} was not triaged on night ${args.nightId}`);
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
  parse_ok: boolean;
}

/** A night's own triage rows (not offline replays) still without a human label for that night. */
export async function unlabelled(db: pg.Pool, nightId: number): Promise<TriageForReview[]> {
  const { rows } = await db.query<TriageForReview>(
    `SELECT t.id AS triage_id, i.repo, i.number, i.kind, i.title, t.bucket, t.reason, t.draft_reply, t.parse_ok
       FROM triage t JOIN items i ON i.id = t.item_id JOIN nights n ON n.id = t.night_id
       LEFT JOIN labels_human l ON l.item_id = t.item_id AND l.night_id = t.night_id
      WHERE t.night_id = $1 AND t.prompt_version = n.prompt_version AND l.item_id IS NULL
      ORDER BY i.repo, i.number`,
    [nightId],
  );
  return rows;
}

export const textHash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

export interface ApprovalTarget {
  triage_id: number;
  repo: string;
  number: number;
  state: string;
  draft_reply: string | null;
  writable: boolean;
}

/** The exact row a human is about to approve: only a night's own rows, never an offline replay. */
export async function approvalTarget(db: pg.Pool, triageId: number): Promise<ApprovalTarget> {
  const { rows } = await db.query<Omit<ApprovalTarget, 'writable'>>(
    `SELECT t.id AS triage_id, i.repo, i.number, i.state, t.draft_reply
       FROM triage t JOIN items i ON i.id = t.item_id JOIN nights n ON n.id = t.night_id
      WHERE t.id = $1 AND t.prompt_version = n.prompt_version`,
    [triageId],
  );
  if (!rows[0]) throw new Error(`triage ${triageId} not found (or it is an offline replay row)`);
  return { ...rows[0], writable: isWritable(rows[0].repo) };
}

/**
 * Record a decision. `shownHash` must be the hash of the text the human was shown (the CLI prints the full
 * text and its hash); if the draft changed since, the approval is refused.
 */
export async function recordApproval(
  db: pg.Pool,
  args: { triageId: number; action: 'approve' | 'edit' | 'skip'; finalText?: string | null; shownHash?: string; actor: string },
): Promise<void> {
  const t = await approvalTarget(db, args.triageId);
  let text: string | null = null;
  if (args.action === 'edit') {
    text = args.finalText?.trim() || null;
    if (!text) throw new Error('edit needs non-empty text');
  } else if (args.action === 'approve') {
    if (!t.draft_reply) throw new Error(`triage ${args.triageId} has no draft to approve`);
    if (args.shownHash !== textHash(t.draft_reply)) {
      throw new Error(`the draft for ${args.triageId} is not the text you were shown (hash mismatch); show it again before approving`);
    }
    text = t.draft_reply;
  }
  await db.query('INSERT INTO approvals (triage_id, item_id, action, final_text, actor) SELECT $1, item_id, $2, $3, $4 FROM triage WHERE id = $1', [
    args.triageId, args.action, text, args.actor,
  ]);
}

export class NotApprovedError extends Error {}

/**
 * Post an approved reply as a comment. The `post` row is claimed BEFORE the network call; the unique index
 * (one post per item) makes a concurrent or repeated post fail instead of commenting twice. If the GitHub call
 * fails, the claim stays (posted_url NULL) for a human to check on GitHub; it is never silently retried.
 */
export async function postApproved(db: pg.Pool, gh: GitHub, args: { triageId: number; actor: string }): Promise<string> {
  const { rows } = await db.query<{ item_id: number; repo: string; number: number; state: string; action: string | null; final_text: string | null }>(
    `SELECT t.item_id, i.repo, i.number, i.state,
            (SELECT a.action FROM approvals a WHERE a.triage_id = t.id AND a.action <> 'post' ORDER BY a.id DESC LIMIT 1) AS action,
            (SELECT a.final_text FROM approvals a WHERE a.triage_id = t.id AND a.action <> 'post' ORDER BY a.id DESC LIMIT 1) AS final_text
       FROM triage t JOIN items i ON i.id = t.item_id WHERE t.id = $1`,
    [args.triageId],
  );
  const r = rows[0];
  if (!r) throw new Error(`triage ${args.triageId} not found`);
  assertWritable(r.repo); // partner repos stop here, before any network call
  if (r.state !== 'open') throw new NotApprovedError(`${r.repo}#${r.number} is ${r.state}; not posting`);
  if (r.action !== 'approve' && r.action !== 'edit') {
    throw new NotApprovedError(`triage ${args.triageId} is not approved (latest decision: ${r.action ?? 'none'}); run \`nightshift approve ${args.triageId}\` first`);
  }
  if (!r.final_text?.trim()) throw new NotApprovedError('approved text is empty');

  let claimId: number;
  try {
    const claim = await db.query<{ id: number }>(
      "INSERT INTO approvals (triage_id, item_id, action, final_text, actor) VALUES ($1, $2, 'post', $3, $4) RETURNING id",
      [args.triageId, r.item_id, r.final_text, args.actor],
    );
    claimId = claim.rows[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const prev = await db.query<{ posted_url: string | null }>("SELECT posted_url FROM approvals WHERE item_id = $1 AND action = 'post'", [r.item_id]);
      throw new NotApprovedError(`already posted to ${r.repo}#${r.number}: ${prev.rows[0]?.posted_url ?? '(in progress or failed; check GitHub)'}`);
    }
    throw err;
  }

  const [owner, repo] = r.repo.split('/') as [string, string];
  // No automatic retry on a write: a 5xx after GitHub created the comment would otherwise post it twice.
  const res = await gh.issues.createComment({ owner, repo, issue_number: r.number, body: r.final_text, request: { retries: 0 } });
  await db.query('UPDATE approvals SET posted_url = $2 WHERE id = $1', [claimId, res.data.html_url]);
  return res.data.html_url;
}
