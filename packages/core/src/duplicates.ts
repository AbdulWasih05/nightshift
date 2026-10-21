// Hybrid duplicate search: pgvector cosine + Postgres full-text, fused with reciprocal rank fusion.
// Each candidate records which half found it, so the post can show a keyword-only and a vector-only catch.
import type pg from 'pg';
import type { DuplicateCandidate } from './triage/input.ts';

export interface HybridCandidate extends DuplicateCandidate {
  source: 'vector' | 'keyword' | 'both';
  vectorSim: number | null;
  keywordRank: number | null; // 1-based rank in the keyword list
  sharedTerms: string[];
}

const POOL = 20; // candidates per half before fusion
const RRF_K = 60;
/** A candidate is passed to the model only if one half is confident; weak matches tempt a 4B model to say DUPLICATE. */
export const MIN_VECTOR_SIM = 0.8;
export const MIN_SHARED_TERMS = 3;

interface Row {
  number: number;
  title: string;
  state: string;
  vector_sim: number | null;
  vector_rank: number | null;
  keyword_rank: number | null;
  shared: string[] | null;
}

export async function findDuplicates(db: pg.Pool, itemId: number, limit = 3): Promise<HybridCandidate[]> {
  const { rows } = await db.query<Row>(
    `WITH me AS (
       -- Keyword query = the item's TITLE lexemes (body words like "error" or "use" match everything).
       SELECT i.id, i.repo, i.number, e.embedding,
              ARRAY(SELECT quote_literal(l) FROM unnest(tsvector_to_array(to_tsvector('english', i.title))) l) AS lexemes
         FROM items i LEFT JOIN embeddings e ON e.item_id = i.id
        WHERE i.id = $1
     ),
     vec AS (
       SELECT o.id, 1 - (e.embedding <=> me.embedding) AS sim,
              row_number() OVER (ORDER BY e.embedding <=> me.embedding) AS rnk
         FROM me, items o JOIN embeddings e ON e.item_id = o.id
        WHERE me.embedding IS NOT NULL AND o.repo = me.repo AND o.id <> me.id
        ORDER BY e.embedding <=> me.embedding
        LIMIT ${POOL}
     ),
     kw AS (
       SELECT o.id, row_number() OVER (ORDER BY ts_rank_cd(o.search_tsv, q.query) DESC) AS rnk
         FROM me,
              LATERAL (SELECT to_tsquery('simple', array_to_string(me.lexemes, ' | ')) AS query) q,
              items o
        WHERE cardinality(me.lexemes) > 0 AND o.repo = me.repo AND o.id <> me.id AND o.search_tsv @@ q.query
        ORDER BY ts_rank_cd(o.search_tsv, q.query) DESC
        LIMIT ${POOL}
     )
     SELECT o.number, o.title, o.state,
            vec.sim AS vector_sim, vec.rnk AS vector_rank, kw.rnk AS keyword_rank,
            ARRAY(SELECT quote_literal(l) FROM unnest(tsvector_to_array(o.search_tsv)) l
                  INTERSECT SELECT unnest(me.lexemes)) AS shared
       FROM me, (SELECT id FROM vec UNION SELECT id FROM kw) ids
       JOIN items o ON o.id = ids.id
       LEFT JOIN vec ON vec.id = o.id
       LEFT JOIN kw ON kw.id = o.id`,
    [itemId],
  );
  return fuse(rows).slice(0, limit);
}

/** Exported for tests: RRF over the two lists, then the confidence gate. */
export function fuse(rows: Row[]): HybridCandidate[] {
  return rows
    .map((r) => {
      const sim = r.vector_sim === null ? null : Number(r.vector_sim);
      const shared = (r.shared ?? []).map((s) => s.replace(/^'(.*)'$/, '$1').replace(/''/g, "'"));
      const vectorHit = sim !== null && sim >= MIN_VECTOR_SIM;
      const keywordHit = r.keyword_rank !== null && shared.length >= MIN_SHARED_TERMS;
      const score =
        (r.vector_rank !== null ? 1 / (RRF_K + Number(r.vector_rank)) : 0) +
        (r.keyword_rank !== null ? 1 / (RRF_K + Number(r.keyword_rank)) : 0);
      return { r, sim, shared, vectorHit, keywordHit, score };
    })
    .filter((c) => c.vectorHit || c.keywordHit)
    .sort((a, b) => b.score - a.score)
    .map(({ r, sim, shared, vectorHit, keywordHit }) => {
      const source: HybridCandidate['source'] = vectorHit && keywordHit ? 'both' : vectorHit ? 'vector' : 'keyword';
      const parts = [
        sim !== null ? `vector ${sim.toFixed(2)}` : null,
        shared.length ? `shared terms: ${shared.slice(0, 6).join(', ')}` : null,
        r.state === 'closed' ? 'closed' : 'open',
      ].filter(Boolean);
      return {
        number: r.number,
        title: r.title,
        similarity: Number((sim ?? 0).toFixed(3)),
        why: parts.join('; '),
        source,
        vectorSim: sim,
        keywordRank: r.keyword_rank === null ? null : Number(r.keyword_rank),
        sharedTerms: shared,
      };
    });
}
