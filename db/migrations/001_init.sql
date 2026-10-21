-- 001_init: items, embeddings, nights, triage, approvals, human labels.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per nightly run. NIGHTS.md is generated from this table, never by hand.
CREATE TABLE nights (
  id              serial PRIMARY KEY,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  repos           text[] NOT NULL,
  prompt_version  text,
  notes           text
);

-- Collector cursor per repo.
CREATE TABLE sync_state (
  repo         text PRIMARY KEY,
  last_since   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- PRs and issues, latest snapshot. Raw GitHub JSON kept for re-triage offline.
CREATE TABLE items (
  id                       bigserial PRIMARY KEY,
  repo                     text NOT NULL,
  number                   integer NOT NULL,
  kind                     text NOT NULL CHECK (kind IN ('pr', 'issue')),
  title                    text NOT NULL,
  body                     text NOT NULL DEFAULT '',
  author                   text NOT NULL,
  author_association       text,
  author_account_age_days  integer,
  author_prior_merged      integer,
  state                    text NOT NULL,
  draft                    boolean NOT NULL DEFAULT false,
  labels                   text[] NOT NULL DEFAULT '{}',
  additions                integer,
  deletions                integer,
  files_changed            integer,
  has_tests                boolean,
  ci_status                text,
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  closed_at                timestamptz,
  merged_at                timestamptz,
  raw                      jsonb NOT NULL,
  first_seen_night         integer REFERENCES nights(id),
  last_seen_night          integer REFERENCES nights(id),
  collected_at             timestamptz NOT NULL DEFAULT now(),
  -- Full-text side of the hybrid duplicate search: title + first 400 chars of body.
  search_tsv               tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', left(coalesce(body, ''), 400)), 'B')
  ) STORED,
  UNIQUE (repo, number)
);
CREATE INDEX items_repo_updated ON items (repo, updated_at DESC);
CREATE INDEX items_search_tsv ON items USING gin (search_tsv);

-- Vector side of the hybrid search (nomic-embed-text = 768 dims).
CREATE TABLE embeddings (
  item_id      bigint PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  model        text NOT NULL,
  input_hash   text NOT NULL,
  embedding    vector(768) NOT NULL,
  embedded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX embeddings_hnsw ON embeddings USING hnsw (embedding vector_cosine_ops);

-- Model output per item per night per prompt version.
CREATE TABLE triage (
  id              bigserial PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  night_id        integer REFERENCES nights(id),
  prompt_version  text NOT NULL,
  bucket          text NOT NULL CHECK (bucket IN ('DUPLICATE', 'SPAM_OR_SLOP', 'OUT_OF_SCOPE', 'NEEDS_TESTS_OR_INFO', 'TRIVIAL_SAFE', 'NEEDS_HUMAN')),
  confidence      real,
  reason          text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '[]',
  draft_reply     text,
  input           jsonb NOT NULL,          -- exact evidence passed to the model, for offline re-eval
  raw_output      text,
  parse_ok        boolean NOT NULL,
  model_path      text NOT NULL,           -- gemma3:4b | gemma3:1b | hosted | none
  tokens_in       integer,
  tokens_out      integer,
  latency_ms      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, night_id, prompt_version)
);

-- Human actions on drafts. Nothing reaches GitHub without a row here.
CREATE TABLE approvals (
  id           bigserial PRIMARY KEY,
  triage_id    bigint NOT NULL REFERENCES triage(id) ON DELETE CASCADE,
  action       text NOT NULL CHECK (action IN ('approve', 'edit', 'skip', 'post')),
  final_text   text,
  actor        text NOT NULL,
  posted_url   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Ground truth for eval, TabPFN and Tinker.
CREATE TABLE labels_human (
  item_id     bigint PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  bucket      text NOT NULL CHECK (bucket IN ('DUPLICATE', 'SPAM_OR_SLOP', 'OUT_OF_SCOPE', 'NEEDS_TESTS_OR_INFO', 'TRIVIAL_SAFE', 'NEEDS_HUMAN')),
  reason      text NOT NULL,
  labeller    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Account creation date per login. Only successful lookups are cached. Prior-merged counts are not cached:
-- they are per item (merged before the item was opened), so they cannot leak the outcome into TabPFN.
CREATE TABLE account_cache (
  login               text PRIMARY KEY,
  account_created_at  timestamptz NOT NULL,
  fetched_at          timestamptz NOT NULL DEFAULT now()
);

-- Items the collector could not enrich or store. Surfaced in the digest; never silently dropped.
CREATE TABLE collect_errors (
  id          bigserial PRIMARY KEY,
  repo        text NOT NULL,
  number      integer NOT NULL,
  night_id    integer REFERENCES nights(id),
  stage       text NOT NULL CHECK (stage IN ('enrich', 'upsert')),
  error       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
