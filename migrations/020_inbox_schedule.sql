-- Which standing job a scheduled request came from, so the screens can say its
-- name in one line instead of the whole instruction it sends. No foreign key: a
-- deleted job leaves its past runs readable, they just fall back to the text.
ALTER TABLE inbox ADD COLUMN IF NOT EXISTS schedule_id BIGINT;
