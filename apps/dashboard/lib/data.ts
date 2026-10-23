// Server-only: imported by server components and server actions.
import { getPool } from '@nightshift/core/db';

export interface NightRow {
  id: number;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  trigger: string;
  prompt_version: string;
}

export interface DashItem {
  triage_id: number;
  repo: string;
  number: number;
  kind: 'pr' | 'issue';
  title: string;
  state: string;
  bucket: string;
  confidence: number | null;
  reason: string;
  evidence: string[];
  draft_reply: string | null;
  model_path: string;
  parse_ok: boolean;
  duplicates: { number: number; title: string; why: string }[];
  additions: number | null;
  deletions: number | null;
  files_changed: number | null;
  has_tests: boolean | null;
  ci_status: string | null;
  author: string;
  author_account_age_days: number | null;
  author_prior_merged: number | null;
  decision: string | null; // latest approve/edit/skip
  decided_text: string | null;
  posted_url: string | null;
}

export async function listNights(): Promise<NightRow[]> {
  const { rows } = await getPool().query<NightRow>(
    'SELECT id, started_at, finished_at, status, trigger, prompt_version FROM nights ORDER BY id DESC LIMIT 20',
  );
  return rows;
}

/** A night's own triage rows (never offline replays), needs-you first. */
export async function nightItems(nightId: number): Promise<DashItem[]> {
  const { rows } = await getPool().query<DashItem>(
    `SELECT t.id AS triage_id, i.repo, i.number, i.kind, i.title, i.state, t.bucket, t.confidence, t.reason,
            t.evidence, t.draft_reply, t.model_path, t.parse_ok,
            i.additions, i.deletions, i.files_changed, i.has_tests, i.ci_status, i.author,
            i.author_account_age_days, i.author_prior_merged,
            COALESCE(t.input->'top_duplicates', '[]'::jsonb) AS duplicates,
            (SELECT a.action FROM approvals a WHERE a.triage_id = t.id AND a.action <> 'post' ORDER BY a.id DESC LIMIT 1) AS decision,
            (SELECT a.final_text FROM approvals a WHERE a.triage_id = t.id AND a.action <> 'post' ORDER BY a.id DESC LIMIT 1) AS decided_text,
            (SELECT a.posted_url FROM approvals a WHERE a.item_id = t.item_id AND a.action = 'post' LIMIT 1) AS posted_url
       FROM triage t JOIN items i ON i.id = t.item_id JOIN nights n ON n.id = t.night_id
      WHERE t.night_id = $1 AND t.prompt_version = n.prompt_version
      ORDER BY CASE t.bucket WHEN 'NEEDS_HUMAN' THEN 0 WHEN 'TRIVIAL_SAFE' THEN 2 ELSE 1 END, i.repo, i.number`,
    [nightId],
  );
  return rows;
}

export interface PublicStats {
  nights: { id: number; trigger: string; status: string; started_at: Date; finished_at: Date | null; triaged: number }[];
  triaged: number;
  distinctItems: number;
  buckets: { bucket: string; n: number }[];
  parseFailures: number;
  medianLatencyS: number | null;
  tokensIn: number;
  tokensOut: number;
  modelPaths: { model_path: string; n: number }[];
  labelled: number;
  correct: number;
  approvals: number;
  posts: number;
  corpus: { repo: string; n: number }[];
  withDuplicateCandidates: number;
}

/**
 * Aggregates only, for the public case study. No titles, bodies, logins or drafts ever leave this function:
 * counts per night, per bucket and per model path, from each night's own prompt version.
 */
export async function publicStats(): Promise<PublicStats> {
  const db = getPool();
  const own = `FROM triage t JOIN nights n ON n.id = t.night_id WHERE t.prompt_version = n.prompt_version`;
  const [nights, totals, buckets, paths, labels, actions, corpus] = await Promise.all([
    db.query(
      `SELECT n.id, n.trigger, n.status, n.started_at, n.finished_at,
              (SELECT count(*)::int FROM triage t WHERE t.night_id = n.id AND t.prompt_version = n.prompt_version) AS triaged
         FROM nights n ORDER BY n.id`,
    ),
    db.query(
      `SELECT count(*)::int AS triaged, count(DISTINCT t.item_id)::int AS distinct_items,
              count(*) FILTER (WHERE NOT t.parse_ok)::int AS parse_failures,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY t.latency_ms) AS median_ms,
              coalesce(sum(t.tokens_in), 0)::bigint AS tokens_in, coalesce(sum(t.tokens_out), 0)::bigint AS tokens_out,
              count(*) FILTER (WHERE jsonb_array_length(coalesce(t.input->'top_duplicates', '[]'::jsonb)) > 0)::int AS with_dups
         ${own}`,
    ),
    db.query(`SELECT t.bucket, count(*)::int AS n ${own} GROUP BY 1 ORDER BY 2 DESC`),
    db.query(`SELECT t.model_path, count(*)::int AS n ${own} GROUP BY 1 ORDER BY 2 DESC`),
    db.query(
      `SELECT count(*)::int AS labelled, count(*) FILTER (WHERE l.bucket = t.bucket AND t.parse_ok)::int AS correct
         FROM triage t JOIN nights n ON n.id = t.night_id AND t.prompt_version = n.prompt_version
         JOIN labels_human l ON l.item_id = t.item_id AND l.night_id = t.night_id`,
    ),
    db.query(
      `SELECT count(*) FILTER (WHERE action IN ('approve', 'edit'))::int AS approvals,
              count(*) FILTER (WHERE action = 'post' AND posted_url IS NOT NULL)::int AS posts FROM approvals`,
    ),
    db.query(`SELECT repo, count(*)::int AS n FROM items GROUP BY 1 ORDER BY 2 DESC`),
  ]);
  const t = totals.rows[0];
  return {
    nights: nights.rows,
    triaged: t.triaged,
    distinctItems: t.distinct_items,
    buckets: buckets.rows,
    parseFailures: t.parse_failures,
    medianLatencyS: t.median_ms === null ? null : Number(t.median_ms) / 1000,
    tokensIn: Number(t.tokens_in),
    tokensOut: Number(t.tokens_out),
    modelPaths: paths.rows,
    labelled: labels.rows[0].labelled,
    correct: labels.rows[0].correct,
    approvals: actions.rows[0].approvals,
    posts: actions.rows[0].posts,
    corpus: corpus.rows,
    withDuplicateCandidates: t.with_dups,
  };
}
