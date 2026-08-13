-- What herdr says each bound session is doing, and since when. The watcher keeps
-- this in step so the tree can show live session state without every reader
-- shelling out to herdr.
CREATE TABLE IF NOT EXISTS agent_sessions (
  agent_id BIGINT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  target TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  seq BIGINT NOT NULL DEFAULT 0,
  since TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- a working spell that Pilo did not ask for, waiting out its debounce
  pending_since TIMESTAMPTZ,
  pending_started TIMESTAMPTZ,
  pending_seq BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
