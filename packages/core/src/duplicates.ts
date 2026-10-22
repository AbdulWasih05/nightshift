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
/**
 * Gate: a candidate reaches the model only if the evidence is strong; weak matches tempt a 4B model to say DUPLICATE.
 * Calibrated on temporalio/temporal (1559 items, nomic-embed-text): nearest-neighbour cosine is >= 0.80 for 89% of
 * items and >= 0.90 for 31%, because same-repo text is all similar. Related-but-distinct pairs sit at 0.87-0.89.
 */
export const VECTOR_ONLY_SIM = 0.92; // vector alone
export const BOTH_SIM = 0.85; // vector + keyword agreeing
export const BOTH_SHARED_TERMS = 3;
export const KEYWORD_ONLY_SHARED_TERMS = 4; // keyword alone: shared stemmed title terms...
/** ...that also cover this share of the shorter title. temporal#12622 vs #12137 shared "task queue user data"
 *  (4 of 7 terms, a common phrase in that repo) and the model called it a duplicate. */
export const KEYWORD_ONLY_COVERAGE = 0.6;

interface Row {
  number: number;
  title: string;
  state: string;
  vector_sim: number | null;
  vector_rank: number | null;
  keyword_rank: number | null;
  shorter_terms: number | null;
  shared: string[] | null;
}

/** SQL: quoted, stemmed title lexemes of length >= 3, hyphenated compounds removed. */
function titleLexemes(col: string): string {
  return `ARRAY(SELECT quote_literal(l) FROM unnest(tsvector_to_array(to_tsvector('english', ${col}))) l
                 WHERE length(l) >= 3 AND position('-' IN l) = 0)`;
}

export async function findDuplicates(db: pg.Pool, itemId: number, limit = 3): Promise<HybridCandidate[]> {
  const { rows } = await db.query<Row>(
    `WITH me AS (
       -- Keyword query = the item's TITLE lexemes (body words like "error" match everything). Lexemes under
       -- 3 chars are dropped, and hyphenated compounds are dropped because their parts are already lexemes,
       -- so "per-namespace" counts once, not three times.
       SELECT i.id, i.repo, i.number, i.kind, i.created_at, e.embedding,
              ${titleLexemes('i.title')} AS lexemes,
              -- Numbers the item already references ("Fixes #123") are related, not duplicates.
              ARRAY(SELECT DISTINCT m[1]::int FROM regexp_matches(i.title || ' ' || i.body, '#([0-9]{1,7})', 'g') m) AS refs
         FROM items i LEFT JOIN embeddings e ON e.item_id = i.id
        WHERE i.id = $1
     ),
     cand AS (
       -- A duplicate is an OLDER item of the SAME kind (a PR is not a duplicate of the issue it fixes).
       SELECT o.* FROM me, items o
        WHERE o.repo = me.repo AND o.id <> me.id AND o.kind = me.kind
          AND o.created_at < me.created_at AND NOT (o.number = ANY(me.refs))
          -- A duplicate PR is competing work, so it must still be open. Issues can duplicate closed issues.
          AND (me.kind = 'issue' OR o.state = 'open')
     ),
     vec AS (
       SELECT c.id, 1 - (e.embedding <=> me.embedding) AS sim,
              row_number() OVER (ORDER BY e.embedding <=> me.embedding) AS rnk
         FROM me, cand c JOIN embeddings e ON e.item_id = c.id
        WHERE me.embedding IS NOT NULL
        ORDER BY e.embedding <=> me.embedding
        LIMIT ${POOL}
     ),
     kw AS (
       SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.search_tsv, q.query) DESC) AS rnk
         FROM me,
              LATERAL (SELECT to_tsquery('simple', array_to_string(me.lexemes, ' | ')) AS query) q,
              cand c
        WHERE cardinality(me.lexemes) > 0 AND c.search_tsv @@ q.query
        ORDER BY ts_rank_cd(c.search_tsv, q.query) DESC
        LIMIT ${POOL}
     )
     SELECT o.number, o.title, o.state,
            vec.sim AS vector_sim, vec.rnk AS vector_rank, kw.rnk AS keyword_rank,
            least(cardinality(me.lexemes), cardinality(${titleLexemes('o.title')})) AS shorter_terms,
            ARRAY(SELECT unnest(${titleLexemes('o.title')}) INTERSECT SELECT unnest(me.lexemes)) AS shared
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
      const inKeyword = r.keyword_rank !== null;
      const vectorHit = sim !== null && sim >= VECTOR_ONLY_SIM;
      const coverage = r.shorter_terms ? shared.length / Number(r.shorter_terms) : 0;
      const keywordHit = inKeyword && shared.length >= KEYWORD_ONLY_SHARED_TERMS && coverage >= KEYWORD_ONLY_COVERAGE;
      const bothHit = inKeyword && sim !== null && sim >= BOTH_SIM && shared.length >= BOTH_SHARED_TERMS;
      const score =
        (r.vector_rank !== null ? 1 / (RRF_K + Number(r.vector_rank)) : 0) +
        (r.keyword_rank !== null ? 1 / (RRF_K + Number(r.keyword_rank)) : 0);
      return { r, sim, shared, vectorHit, keywordHit, bothHit, score };
    })
    .filter((c) => c.vectorHit || c.keywordHit || c.bothHit)
    .sort((a, b) => b.score - a.score)
    .map(({ r, sim, shared, vectorHit, keywordHit, bothHit }) => {
      const source: HybridCandidate['source'] = bothHit || (vectorHit && keywordHit) ? 'both' : vectorHit ? 'vector' : 'keyword';
      const parts = [
        sim !== null ? `vector ${sim.toFixed(2)}` : null,
        shared.length ? `shared terms: ${shared.slice(0, 6).join(', ')}` : null,
        r.state === 'closed' ? 'closed' : 'open',
      ].filter(Boolean);
      return {
        number: r.number,
        title: r.title,
        // Raw vector cosine; null when only the keyword half matched (a 0 would read as "no match").
        similarity: sim === null || !(vectorHit || bothHit) ? null : Number(sim.toFixed(3)),
        why: parts.join('; '),
        source,
        vectorSim: sim,
        keywordRank: r.keyword_rank === null ? null : Number(r.keyword_rank),
        sharedTerms: shared,
      };
    });
}
