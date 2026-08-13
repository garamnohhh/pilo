-- Room for the imported history: keep the original ids so old references
-- ("#142") still resolve after the import.
ALTER TABLE inbox ADD COLUMN IF NOT EXISTS legacy_id BIGINT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS legacy_id BIGINT;
ALTER TABLE final_replies ADD COLUMN IF NOT EXISTS legacy_id BIGINT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS legacy_id BIGINT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS legacy_source TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS inbox_legacy ON inbox (legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_legacy ON tasks (legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS final_replies_legacy ON final_replies (legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS events_legacy ON events (legacy_source, legacy_id) WHERE legacy_id IS NOT NULL;
