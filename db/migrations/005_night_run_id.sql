-- startNight is an activity and can be retried after its INSERT committed; keying on the workflow run id
-- makes the retry return the same night instead of creating a second one.
ALTER TABLE nights ADD COLUMN workflow_run_id text UNIQUE;
