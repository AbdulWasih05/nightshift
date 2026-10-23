// Scores model buckets against human labels and writes docs/eval/<date>-<prompt>-nights<ids>.md.
// Labels are per (item, night). "Correct" requires a parsed answer: a NEEDS_HUMAN produced by the fallback
// after a parse failure never counts as the model being right. Live scores use only each night's own prompt;
// a candidate prompt is compared by offline replay over the exact stored inputs, on the items both scored.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { triageItem, type ModelHealth } from './triage/agent.ts';
import type { TriageInput } from './triage/input.ts';
import { saveTriage } from './triage/store.ts';
import { BUCKETS, type Bucket } from './types.ts';

export interface EvalRow {
  night_id: number;
  item_id: number;
  repo: string;
  number: number;
  model: Bucket;
  human: Bucket;
  confidence: number | null;
  model_reason: string;
  human_reason: string;
  parse_ok: boolean;
}

export interface EvalResult {
  promptVersion: string;
  mode: 'live' | 'replay';
  nights: number[];
  n: number;
  correct: number;
  parseFailures: number;
  perBucket: Record<Bucket, { precision: number | null; recall: number | null; support: number }>;
  confusion: Record<Bucket, Record<Bucket, number>>; // [human][model]
  worst: EvalRow[];
}

const SELECT_ROWS = `SELECT t.night_id, t.item_id, i.repo, i.number, t.bucket AS model, l.bucket AS human, t.confidence,
            t.reason AS model_reason, l.reason AS human_reason, t.parse_ok
       FROM triage t
       JOIN labels_human l ON l.item_id = t.item_id AND l.night_id = t.night_id
       JOIN items i ON i.id = t.item_id
       JOIN nights n ON n.id = t.night_id`;

/** Live: each night's own triage rows (the prompt that night ran with). */
export async function loadLiveRows(db: pg.Pool, opts: { promptVersion?: string; nights?: number[] }): Promise<EvalRow[]> {
  const { rows } = await db.query<EvalRow>(
    `${SELECT_ROWS}
      WHERE t.prompt_version = n.prompt_version
        AND ($1::text IS NULL OR t.prompt_version = $1) AND ($2::int[] IS NULL OR t.night_id = ANY($2))
      ORDER BY t.night_id, i.repo, i.number`,
    [opts.promptVersion ?? null, opts.nights ?? null],
  );
  return rows;
}

/** Base vs candidate on exactly the same labelled (item, night) pairs: those that have a row for both prompts. */
export async function loadPairedRows(db: pg.Pool, opts: { base: string; candidate: string; nights?: number[] }): Promise<{ base: EvalRow[]; candidate: EvalRow[] }> {
  const load = async (version: string, other: string) =>
    (
      await db.query<EvalRow>(
        `${SELECT_ROWS}
          WHERE t.prompt_version = $1 AND ($3::int[] IS NULL OR t.night_id = ANY($3))
            AND EXISTS (SELECT 1 FROM triage o WHERE o.item_id = t.item_id AND o.night_id = t.night_id AND o.prompt_version = $2)
          ORDER BY t.night_id, i.repo, i.number`,
        [version, other, opts.nights ?? null],
      )
    ).rows;
  const base = await load(opts.base, opts.candidate);
  const candidate = await load(opts.candidate, opts.base);
  if (base.length !== candidate.length) throw new Error(`paired eval mismatch: ${base.length} vs ${candidate.length} rows`);
  return { base, candidate };
}

export function score(rows: EvalRow[], promptVersion: string, mode: EvalResult['mode'] = 'live'): EvalResult {
  const confusion = Object.fromEntries(BUCKETS.map((h) => [h, Object.fromEntries(BUCKETS.map((m) => [m, 0]))])) as EvalResult['confusion'];
  for (const r of rows) confusion[r.human][r.model]++;
  const perBucket = {} as EvalResult['perBucket'];
  for (const b of BUCKETS) {
    const tp = rows.filter((r) => r.human === b && r.model === b && r.parse_ok).length;
    const predicted = rows.filter((r) => r.model === b).length;
    const actual = rows.filter((r) => r.human === b).length;
    perBucket[b] = { precision: predicted ? tp / predicted : null, recall: actual ? tp / actual : null, support: actual };
  }
  const isCorrect = (r: EvalRow) => r.parse_ok && r.model === r.human;
  // Worst misses: wrong answers the model was most confident about.
  const worst = rows.filter((r) => !isCorrect(r)).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, 10);
  return {
    promptVersion,
    mode,
    nights: [...new Set(rows.map((r) => r.night_id))].sort((a, b) => a - b),
    n: rows.length,
    correct: rows.filter(isCorrect).length,
    parseFailures: rows.filter((r) => !r.parse_ok).length,
    perBucket,
    confusion,
    worst,
  };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
const short = (b: string) => b.replace('NEEDS_TESTS_OR_INFO', 'TESTS/INFO').replace('SPAM_OR_SLOP', 'SPAM').replace('OUT_OF_SCOPE', 'OOS').replace('TRIVIAL_SAFE', 'TRIVIAL').replace('NEEDS_HUMAN', 'HUMAN').replace('DUPLICATE', 'DUP');

export function renderEval(e: EvalResult): string {
  const o: string[] = [];
  const label = e.mode === 'replay' ? 'offline replay over stored inputs' : "live (each night's own prompt)";
  o.push(`# Eval: prompt ${e.promptVersion}, ${label}, nights ${e.nights.join(', ') || 'none'}`);
  o.push('');
  o.push('Generated by `pnpm nightshift eval` from `triage` x `labels_human` (labels are per item per night). Do not edit by hand.');
  o.push('A NEEDS_HUMAN produced by the parse-failure fallback is never counted as correct.');
  o.push('');
  if (!e.n) {
    o.push('No labelled items yet.');
    return o.join('\n') + '\n';
  }
  o.push(`**Accuracy: ${e.correct}/${e.n} (${pct(e.correct / e.n)})** · parse failures ${e.parseFailures}`);
  o.push('');
  o.push('| Bucket | Precision | Recall | Human-labelled |');
  o.push('|---|---|---|---|');
  for (const b of BUCKETS) o.push(`| ${b} | ${pct(e.perBucket[b].precision)} | ${pct(e.perBucket[b].recall)} | ${e.perBucket[b].support} |`);
  o.push('');
  o.push('Confusion matrix (rows: human, columns: model)');
  o.push('');
  o.push(`| human \\ model | ${BUCKETS.map(short).join(' | ')} |`);
  o.push(`|---|${BUCKETS.map(() => '---').join('|')}|`);
  for (const h of BUCKETS) o.push(`| ${short(h)} | ${BUCKETS.map((m) => e.confusion[h][m] || '·').join(' | ')} |`);
  o.push('');
  o.push('## Worst misses (most confident wrong answers)');
  o.push('');
  for (const r of e.worst) {
    o.push(`- ${r.repo}#${r.number} (night ${r.night_id}): model **${r.model}** (${r.confidence ?? '?'}${r.parse_ok ? '' : ', parse failure'}), human **${r.human}**`);
    o.push(`  - model: ${r.model_reason}`);
    o.push(`  - human: ${r.human_reason}`);
  }
  return o.join('\n') + '\n';
}

export async function writeEval(e: EvalResult, dir: string, date: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const nights = e.nights.length ? `-nights${e.nights.join('_')}` : '';
  const file = join(dir, `${date}-${e.promptVersion}${e.mode === 'replay' ? '-replay' : ''}${nights}.md`);
  await writeFile(file, renderEval(e), 'utf8');
  return file;
}

/**
 * Re-run `candidate` on the stored inputs of every labelled item triaged live with `base`. Rows are stored
 * under the same night with the candidate's prompt_version. A run where no model answered is stored too
 * (NEEDS_HUMAN, parse_ok false), so the candidate is never scored on a subset that hides its failures.
 */
export async function replayCandidate(
  db: pg.Pool,
  opts: { base: string; candidate: string; nights?: number[]; health?: ModelHealth; onItem?: (done: number, of: number) => void },
): Promise<{ replayed: number; noModel: number }> {
  const { rows } = await db.query<{ item_id: number; night_id: number; input: TriageInput }>(
    `SELECT t.item_id, t.night_id, t.input FROM triage t
       JOIN labels_human l ON l.item_id = t.item_id AND l.night_id = t.night_id
       JOIN nights n ON n.id = t.night_id
      WHERE t.prompt_version = $1 AND n.prompt_version = $1 AND ($3::int[] IS NULL OR t.night_id = ANY($3))
        AND NOT EXISTS (SELECT 1 FROM triage c WHERE c.item_id = t.item_id AND c.night_id = t.night_id AND c.prompt_version = $2)`,
    [opts.base, opts.candidate, opts.nights ?? null],
  );
  let replayed = 0;
  let noModel = 0;
  for (const r of rows) {
    const run = await triageItem(r.input, { promptVersion: opts.candidate, health: opts.health });
    if (run.modelPath === 'none') noModel++;
    await saveTriage(db, { itemId: r.item_id, nightId: r.night_id, promptVersion: opts.candidate, input: r.input, run });
    opts.onItem?.(++replayed, rows.length);
  }
  return { replayed, noModel };
}
