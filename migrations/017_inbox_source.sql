-- Where a request came from. Everything used to be a user's line, schedules
-- included, so the desk's own news had to pretend the user had asked for it and
-- a scheduled job read as an answer to a question nobody wrote.
--   user     — typed in the TUI or the dashboard (the default, and what every
--              existing row was)
--   schedule — a standing job's hour came round
--   desk     — the desk speaking first: something the user should know without
--              having asked
ALTER TABLE inbox ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';
ALTER TABLE inbox DROP CONSTRAINT IF EXISTS inbox_source_known;
ALTER TABLE inbox ADD CONSTRAINT inbox_source_known CHECK (source IN ('user', 'schedule', 'desk'));
