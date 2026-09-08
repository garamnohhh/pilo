-- Two ways of waiting that used to look like being stuck.
--
-- 'holding' is the task waiting on something outside Pilo — a build, a person,
-- another agent. It is not queued (nobody should be woken about it) and it is
-- not done, and the screens can now say which.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('queued', 'running', 'holding', 'blocked', 'done', 'failed'));

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS hold_note TEXT NOT NULL DEFAULT '';

-- 'limited' is the agent itself waiting on its provider's usage window. It
-- reports the time the limit lifts and gets no wakes until then; the sweep that
-- runs every tick picks it back up on its own.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS limited_until TIMESTAMPTZ;
