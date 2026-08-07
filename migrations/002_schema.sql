-- Phase 1 schema. The prototype tables from 001 are kept under *_legacy_001 instead of dropped.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'agents')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'parent_agent_id') THEN
    ALTER TABLE events RENAME TO events_legacy_001;
    ALTER TABLE tasks RENAME TO tasks_legacy_001;
    ALTER TABLE agents RENAME TO agents_legacy_001;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_name_live ON projects (name) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS agents (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'pm' CHECK (role IN ('pilo', 'pm', 'worker')),
  parent_agent_id BIGINT REFERENCES agents(id) ON DELETE SET NULL,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  runtime TEXT NOT NULL DEFAULT '' CHECK (runtime IN ('', 'codex', 'claude')),
  herdr_target TEXT NOT NULL DEFAULT '',
  runtime_detected_at TIMESTAMPTZ,
  model TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '',
  specialty TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_name_live ON agents (name) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agents_single_pilo ON agents ((role)) WHERE role = 'pilo' AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS agents_parent ON agents (parent_agent_id);

CREATE TABLE IF NOT EXISTS inbox (
  id BIGSERIAL PRIMARY KEY,
  user_request TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'dispatched', 'replied', 'failed')),
  cwd TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbox_status ON inbox (status, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  inbox_id BIGINT REFERENCES inbox(id) ON DELETE CASCADE,
  parent_task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
  from_agent_id BIGINT REFERENCES agents(id) ON DELETE SET NULL,
  to_agent_id BIGINT REFERENCES agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  request TEXT NOT NULL DEFAULT '',
  pm_result TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  error TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_inbox ON tasks (inbox_id);
CREATE INDEX IF NOT EXISTS tasks_agent_status ON tasks (to_agent_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS final_replies (
  id BIGSERIAL PRIMARY KEY,
  inbox_id BIGINT NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
  agent_id BIGINT REFERENCES agents(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS final_replies_inbox ON final_replies (inbox_id, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  inbox_id BIGINT REFERENCES inbox(id) ON DELETE SET NULL,
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id BIGINT REFERENCES agents(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_created ON events (created_at DESC);
CREATE INDEX IF NOT EXISTS events_type ON events (type, created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id BIGINT REFERENCES agents(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  delta TEXT NOT NULL DEFAULT '',
  diff TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts (created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('notifications', '[
     {"when": "task failed", "channel": "desktop", "on": true},
     {"when": "approval needed", "channel": "desktop", "on": true},
     {"when": "wake failed", "channel": "desktop", "on": true},
     {"when": "final_reply 도착", "channel": "in-app", "on": false}
   ]'::jsonb),
  ('tokens', '{"showInTui": true, "showInDashboard": true, "window": "today"}'::jsonb),
  ('retention', '{"applied": false, "eventPayloadDays": 30, "failureEventDays": 90, "runLogDays": 14, "serverLogDays": 14}'::jsonb)
ON CONFLICT (key) DO NOTHING;
