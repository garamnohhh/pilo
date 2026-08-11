-- An agent that stops to ask the user something is not "running"; it is waiting.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('queued', 'running', 'blocked', 'done', 'failed'));

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_question TEXT NOT NULL DEFAULT '';
