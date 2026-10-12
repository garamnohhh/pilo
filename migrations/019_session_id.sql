-- The conversation a pane is running, as its own SessionStart hook reports it
-- (hooks/pilo-hook.mjs). Restarting a worker resumes exactly this one, instead
-- of a guess from the newest file in the agent's folder.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS session_at TIMESTAMPTZ;
