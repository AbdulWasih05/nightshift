-- Items stored only as duplicate-search history (backfill). They are never triaged until the real
-- collector sees them change, which flips this to false.
ALTER TABLE items ADD COLUMN corpus_only boolean NOT NULL DEFAULT false;
