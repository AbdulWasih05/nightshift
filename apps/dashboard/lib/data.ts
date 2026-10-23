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
