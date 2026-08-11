-- The answer that releases a blocked task, kept with the task it unblocks.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS answer TEXT NOT NULL DEFAULT '';
