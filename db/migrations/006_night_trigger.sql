-- How a night was started. NIGHTS.md reports scheduled nights; manual runs (smoke tests, the planned
-- afternoon night 4) are listed separately and labelled, never mixed in silently.
ALTER TABLE nights ADD COLUMN trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('scheduled', 'manual'));
UPDATE nights SET notes = coalesce(notes || E'\n', '') || 'smoke test: own repo only, 0 open items' WHERE id = 1 AND trigger = 'manual';
