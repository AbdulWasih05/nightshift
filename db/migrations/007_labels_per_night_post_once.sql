-- Labels are per (item, night): an item re-triaged on a later night (tests pushed, PR updated) gets a fresh
-- human verdict, and re-labelling it never rewrites an earlier night's score.
ALTER TABLE labels_human DROP CONSTRAINT labels_human_pkey;
ALTER TABLE labels_human ADD COLUMN night_id integer NOT NULL REFERENCES nights(id);
ALTER TABLE labels_human ADD PRIMARY KEY (item_id, night_id);

-- At most one post per GitHub item, enforced by the database, not by a read-then-write check.
-- The row is inserted (posted_url NULL) BEFORE the network call; a second post for the same item conflicts.
ALTER TABLE approvals ADD COLUMN item_id bigint REFERENCES items(id);
UPDATE approvals a SET item_id = t.item_id FROM triage t WHERE t.id = a.triage_id;
CREATE UNIQUE INDEX approvals_one_post_per_item ON approvals (item_id) WHERE action = 'post';
