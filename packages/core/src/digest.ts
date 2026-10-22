// Morning digest for one night: under one screen, two headline lines first. Every number comes from the DB.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { Bucket } from './types.ts';

export interface DigestRow {
  triage_id: number;
  repo: string;
  number: number;
  kind: 'pr' | 'issue';
  title: string;
  bucket: Bucket;
  confidence: number | null;
  reason: string;
  draft_reply: string | null;
  model_path: string;
  parse_ok: boolean;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
}

export interface DigestData {
  nightId: number;
  date: string; // YYYY-MM-DD, night start in local time
  rows: DigestRow[];
  errors: { repo: string; number: number; stage: string; error: string }[];
}

/** Time estimate shown in the digest, labelled "est.": a human item ~2.5 min, a draft to approve ~0.5 min. */
export const EST_MIN_PER_HUMAN = 2.5;
export const EST_MIN_PER_DRAFT = 0.5;

const DRAFT_BUCKETS: Bucket[] = ['DUPLICATE', 'SPAM_OR_SLOP', 'OUT_OF_SCOPE', 'NEEDS_TESTS_OR_INFO'];
const MAX_LISTED = 8;

export async function loadDigest(db: pg.Pool, nightId: number): Promise<DigestData> {
  const night = await db.query<{ started_at: Date }>('SELECT started_at FROM nights WHERE id = $1', [nightId]);
  if (!night.rows[0]) throw new Error(`night ${nightId} not found`);
  const { rows } = await db.query<DigestRow>(
    `SELECT t.id AS triage_id, i.repo, i.number, i.kind, i.title, t.bucket, t.confidence, t.reason, t.draft_reply,
            t.model_path, t.parse_ok, t.latency_ms, t.tokens_in, t.tokens_out
       FROM triage t JOIN items i ON i.id = t.item_id
      WHERE t.night_id = $1
      ORDER BY i.repo, i.number`,
    [nightId],
  );
  const errors = await db.query<DigestData['errors'][number]>(
    'SELECT repo, number, stage, error FROM collect_errors WHERE night_id = $1 ORDER BY id',
    [nightId],
  );
  return { nightId, date: localDate(night.rows[0].started_at), rows, errors: errors.rows };
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const shortRepo = (repo: string) => repo.split('/')[1] ?? repo;
const oneLine = (s: string, max = 110) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function renderDigest(d: DigestData): string {
  const human = d.rows.filter((r) => r.bucket === 'NEEDS_HUMAN');
  const drafts = d.rows.filter((r) => DRAFT_BUCKETS.includes(r.bucket) && r.draft_reply);
  const trivial = d.rows.filter((r) => r.bucket === 'TRIVIAL_SAFE');
  const est = Math.round(human.length * EST_MIN_PER_HUMAN + drafts.length * EST_MIN_PER_DRAFT);

  const out: string[] = [];
  out.push(`# Nightshift digest · ${d.date} (night ${d.nightId})`);
  out.push('');
  const draftWord = drafts.length === 1 ? 'drafted reply' : 'drafted replies';
  out.push(`**${human.length} need you (est. ${est} min) · ${drafts.length} ${draftWord} waiting for one click · ${trivial.length} trivial and safe**`);
  out.push(`Nothing was posted, labelled or closed. Every reply waits for your approval.`);
  out.push('');

  out.push(`## Needs you (${human.length})`);
  for (const r of human.slice(0, MAX_LISTED)) {
    out.push(`- ${shortRepo(r.repo)}#${r.number} ${r.kind === 'pr' ? 'PR' : 'issue'} "${oneLine(r.title, 60)}": ${oneLine(r.reason)}`);
  }
  if (human.length > MAX_LISTED) out.push(`- …and ${human.length - MAX_LISTED} more (\`nightshift digest --all\`)`);
  out.push('');

  out.push(`## Drafted replies (${drafts.length}): \`nightshift approve <id>\``);
  for (const r of drafts.slice(0, MAX_LISTED)) {
    out.push(`- [${r.triage_id}] ${shortRepo(r.repo)}#${r.number} ${r.bucket}: "${oneLine(r.draft_reply!, 90)}"`);
  }
  if (drafts.length > MAX_LISTED) out.push(`- …and ${drafts.length - MAX_LISTED} more`);
  out.push('');

  if (trivial.length) {
    out.push(`## Trivial and safe (${trivial.length})`);
    out.push(trivial.map((r) => `${shortRepo(r.repo)}#${r.number}`).join(', '));
    out.push('');
  }

  if (d.errors.length) {
    out.push(`## Could not process (${d.errors.length})`);
    for (const e of d.errors.slice(0, 5)) out.push(`- ${shortRepo(e.repo)}#${e.number} (${e.stage}): ${oneLine(e.error, 80)}`);
    out.push('');
  }

  const byBucket = countBy(d.rows, (r) => r.bucket);
  const byModel = countBy(d.rows, (r) => r.model_path);
  const lat = d.rows.map((r) => r.latency_ms).filter((x): x is number => x !== null);
  const tokIn = sum(d.rows.map((r) => r.tokens_in ?? 0));
  const tokOut = sum(d.rows.map((r) => r.tokens_out ?? 0));
  out.push('<details><summary>Night stats</summary>');
  out.push('');
  out.push(`- Items triaged: ${d.rows.length} (${Object.entries(countBy(d.rows, (r) => shortRepo(r.repo))).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  out.push(`- Buckets: ${Object.entries(byBucket).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  out.push(`- Model path: ${Object.entries(byModel).map(([k, v]) => `${k} ${v}`).join(', ')}; parse failures ${d.rows.filter((r) => !r.parse_ok).length}`);
  if (lat.length) out.push(`- Latency: median ${(median(lat) / 1000).toFixed(1)}s per item; tokens ${tokIn} in / ${tokOut} out; cost $0.00 (local)`);
  out.push('');
  out.push('</details>');
  return out.join('\n') + '\n';
}

/** Short terminal version: the two headline lines plus the "needs you" list. */
export function renderTerminalSummary(d: DigestData): string {
  const md = renderDigest(d);
  return md.slice(0, md.indexOf('## Drafted replies')).replace(/\*\*/g, '').trimEnd();
}

export async function writeDigest(d: DigestData, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${d.date}.md`);
  await writeFile(file, renderDigest(d), 'utf8');
  return file;
}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
