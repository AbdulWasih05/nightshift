// Triage a set of pending items with per-item isolation. Used by the CLI and the nightly workflow.
// No single item, Ollama hiccup or DB blip ends the run: duplicate search failing means "no candidates",
// a failed save is retried once and then recorded, and every item is accounted for in the result.
import type pg from 'pg';
import { findDuplicates } from '../duplicates.ts';
import { embedPending } from '../embed.ts';
import { ModelHealth, triageItem, type TriageOptions, type TriageRun } from './agent.ts';
import { buildTriageInput } from './input.ts';
import type { HybridCandidate } from '../duplicates.ts';
import { saveTriage, type PendingItem } from './store.ts';

export interface BatchItemResult {
  item: PendingItem;
  run: TriageRun | null;
  duplicates: HybridCandidate[];
  triageId: number | null;
  error?: string;
}

export interface BatchOptions extends TriageOptions {
  nightId: number | null;
  repos: string[];
  onItem?: (r: BatchItemResult) => void;
}

export async function triageBatch(db: pg.Pool, items: PendingItem[], opts: BatchOptions): Promise<BatchItemResult[]> {
  try {
    await embedPending(db, { repos: opts.repos });
  } catch (err) {
    console.warn(`[triage] embedding failed, duplicate search will be weaker this run: ${(err as Error).message}`);
  }

  const health = opts.health ?? new ModelHealth();
  const results: BatchItemResult[] = [];
  for (const item of items) {
    const result: BatchItemResult = { item, run: null, duplicates: [], triageId: null };
    try {
      try {
        result.duplicates = await findDuplicates(db, item.id);
      } catch (err) {
        console.warn(`[triage] ${item.repo}#${item.number} duplicate search failed: ${(err as Error).message}`);
      }
      const input = buildTriageInput(item, result.duplicates);
      result.run = await triageItem(input, { ...opts, health });
      const save = () => saveTriage(db, { itemId: item.id, nightId: opts.nightId, promptVersion: opts.promptVersion, input, run: result.run! });
      try {
        result.triageId = await save();
      } catch {
        result.triageId = await save(); // one retry covers a pool reconnect after DB restart / laptop sleep
      }
    } catch (err) {
      result.error = (err as Error).message.slice(0, 1000);
      try {
        await db.query(
          'INSERT INTO collect_errors (repo, number, night_id, stage, error) VALUES ($1, $2, $3, $4, $5)',
          [item.repo, item.number, opts.nightId, 'triage', result.error],
        );
      } catch {
        // DB is down; the item stays pending (no triage row) and is picked up by the next run.
      }
    }
    opts.onItem?.(result);
    results.push(result);
  }
  return results;
}
