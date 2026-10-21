// Local embeddings via Ollama (nomic-embed-text, 768 dims). Text = title + first 400 chars of the cleaned body,
// same span as the full-text column, so both halves of the hybrid search look at the same thing.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { cleanBody } from './triage/input.ts';

export const EMBED_DIMS = 768;
const BATCH = 32;

/** nomic-embed-text expects a task prefix; "clustering" is the symmetric one, right for item-vs-item similarity. */
export function embedText(title: string, body: string): string {
  return `clustering: ${title}\n${cleanBody(body).slice(0, 400)}`;
}

export function hashText(text: string, model: string): string {
  return createHash('sha256').update(model).update('\u0000').update(text).digest('hex');
}

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export function ollamaEmbedder(
  host = process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  model = process.env.EMBED_MODEL ?? 'nomic-embed-text',
): EmbedFn {
  return async (texts) => {
    const res = await fetch(`${host.replace(/\/$/, '')}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`ollama embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { embeddings } = (await res.json()) as { embeddings: number[][] };
    if (embeddings.length !== texts.length || embeddings.some((e) => e.length !== EMBED_DIMS)) {
      throw new Error(`ollama embed returned ${embeddings.length} vectors (dims ${embeddings[0]?.length}) for ${texts.length} inputs`);
    }
    return embeddings;
  };
}

export const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;

/** Embed every item in these repos whose text changed since it was last embedded. Returns the count embedded. */
export async function embedPending(
  db: pg.Pool,
  opts: { repos: string[]; embed?: EmbedFn; model?: string; limit?: number },
): Promise<number> {
  const model = opts.model ?? process.env.EMBED_MODEL ?? 'nomic-embed-text';
  const embed = opts.embed ?? ollamaEmbedder(undefined, model);
  const { rows } = await db.query<{ id: number; title: string; body: string; input_hash: string | null }>(
    `SELECT i.id, i.title, i.body, e.input_hash
       FROM items i LEFT JOIN embeddings e ON e.item_id = i.id
      WHERE i.repo = ANY($1)
      ORDER BY i.updated_at DESC
      LIMIT $2`,
    [opts.repos, opts.limit ?? 100_000],
  );
  const todo = rows
    .map((r) => {
      const text = embedText(r.title, r.body);
      return { id: r.id, text, hash: hashText(text, model), old: r.input_hash };
    })
    .filter((r) => r.hash !== r.old);

  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const vectors = await embed(batch.map((b) => b.text));
    for (const [j, b] of batch.entries()) {
      await db.query(
        `INSERT INTO embeddings (item_id, model, input_hash, embedding) VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (item_id) DO UPDATE SET model = EXCLUDED.model, input_hash = EXCLUDED.input_hash,
           embedding = EXCLUDED.embedding, embedded_at = now()`,
        [b.id, model, b.hash, toVectorLiteral(vectors[j]!)],
      );
    }
    done += batch.length;
  }
  return done;
}
