-- collect_errors also records items whose triage could not be stored (they stay pending and are retried).
ALTER TABLE collect_errors DROP CONSTRAINT collect_errors_stage_check;
ALTER TABLE collect_errors ADD CONSTRAINT collect_errors_stage_check CHECK (stage IN ('enrich', 'upsert', 'triage'));
