-- Manual (non-night) triage runs have night_id NULL. Plain UNIQUE treats NULLs as distinct, so re-running
-- `nightshift triage` would stack duplicate rows. NULLS NOT DISTINCT (PG15+) makes them collide.
ALTER TABLE triage DROP CONSTRAINT triage_item_id_night_id_prompt_version_key;
ALTER TABLE triage ADD CONSTRAINT triage_item_night_prompt_key UNIQUE NULLS NOT DISTINCT (item_id, night_id, prompt_version);
