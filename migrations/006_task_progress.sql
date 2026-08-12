-- Progress notes an agent leaves while a task is still running. The latest one
-- lives on the task so the tree and the feed can read it cheaply; the whole
-- history stays in events as task_progress.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress_at TIMESTAMPTZ;
