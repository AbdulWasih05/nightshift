import type pg from 'pg';
import { scrubDeep } from '../scrub.ts';
import type { TriageRun } from './agent.ts';
import type { ItemRow, TriageInput } from './input.ts';

export interface PendingItem extends ItemRow {
  id: number;
}

/** Items with no triage row yet for this night + prompt version. Open items only: closed ones need no reply. */
export async function selectPending(
  db: pg.Pool,
  opts: { repos: string[]; promptVersion: string; nightId: number | null; limit: number },
): Promise<PendingItem[]> {
  const { rows } = await db.query<PendingItem>(
    `SELECT i.id, i.repo, i.number, i.kind, i.title, i.body, i.author, i.author_association,
            i.author_account_age_days, i.author_prior_merged, i.additions, i.deletions, i.files_changed,
            i.has_tests, i.ci_status, i.draft, i.labels
       FROM items i
      WHERE i.repo = ANY($1) AND i.state = 'open' AND NOT i.corpus_only
        AND NOT EXISTS (
          SELECT 1 FROM triage t
           WHERE t.item_id = i.id AND t.prompt_version = $2 AND t.night_id IS NOT DISTINCT FROM $3)
      ORDER BY i.updated_at ASC
      LIMIT $4`,
    [opts.repos, opts.promptVersion, opts.nightId, opts.limit],
  );
  return rows;
}

export async function saveTriage(
  db: pg.Pool,
  args: { itemId: number; nightId: number | null; promptVersion: string; input: TriageInput; run: TriageRun },
): Promise<number> {
  const { run } = args;
  const o = scrubDeep(run.output);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO triage (item_id, night_id, prompt_version, bucket, confidence, reason, evidence, draft_reply,
       input, raw_output, parse_ok, model_path, tokens_in, tokens_out, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT ON CONSTRAINT triage_item_night_prompt_key DO UPDATE SET
       bucket = EXCLUDED.bucket, confidence = EXCLUDED.confidence, reason = EXCLUDED.reason,
       evidence = EXCLUDED.evidence, draft_reply = EXCLUDED.draft_reply, input = EXCLUDED.input,
       raw_output = EXCLUDED.raw_output, parse_ok = EXCLUDED.parse_ok, model_path = EXCLUDED.model_path,
       tokens_in = EXCLUDED.tokens_in, tokens_out = EXCLUDED.tokens_out, latency_ms = EXCLUDED.latency_ms,
       created_at = now()
     RETURNING id`,
    [
      args.itemId, args.nightId, args.promptVersion, o.bucket, o.confidence, o.reason, JSON.stringify(o.evidence),
      o.draft_reply, JSON.stringify(scrubDeep(args.input)), run.rawOutput === null ? null : scrubDeep(run.rawOutput),
      run.parseOk, run.modelPath, run.tokensIn, run.tokensOut, run.latencyMs,
    ],
  );
  return rows[0]!.id;
}
