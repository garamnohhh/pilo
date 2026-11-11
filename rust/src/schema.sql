-- Pilo's tables in SQLite, as of migration 021 on the Postgres side, one file.
-- Times are INTEGER microseconds since 1970 UTC (Postgres keeps microseconds;
-- milliseconds would not survive a round trip). jsonb is TEXT holding JSON,
-- boolean is INTEGER 0/1. Names, columns and rules are Postgres's. The time
-- defaults are for anything else writing here; pilo itself writes every time
-- (sql::now_us, which never repeats a microsecond).
PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  archived_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER))
);
CREATE UNIQUE INDEX projects_name_live ON projects (name) WHERE archived_at IS NULL;

CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'pm' CHECK (role IN ('pilo', 'pm', 'worker', 'system')),
  parent_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  runtime TEXT NOT NULL DEFAULT '' CHECK (runtime IN ('', 'codex', 'claude')),
  herdr_target TEXT NOT NULL DEFAULT '',
  runtime_detected_at INTEGER,
  model TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '',
  specialty TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  archived_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  limited_until INTEGER,
  reviewer INTEGER NOT NULL DEFAULT 0,
  model_pending TEXT,
  model_pin TEXT
);
CREATE UNIQUE INDEX agents_name_live ON agents (name) WHERE archived_at IS NULL;
CREATE INDEX agents_parent ON agents (parent_agent_id);
CREATE UNIQUE INDEX agents_single_pilo ON agents (role) WHERE role = 'pilo' AND archived_at IS NULL;

CREATE TABLE agent_sessions (
  agent_id INTEGER PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  target TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  since INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  session_id TEXT NOT NULL DEFAULT '',
  session_at INTEGER
);

CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_request TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'dispatched', 'replied', 'failed')),
  cwd TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  legacy_id INTEGER,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'schedule', 'desk')),
  schedule_id INTEGER
);
CREATE UNIQUE INDEX inbox_legacy ON inbox (legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX inbox_status ON inbox (status, created_at DESC);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id INTEGER REFERENCES inbox(id) ON DELETE CASCADE,
  parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  from_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  to_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  request TEXT NOT NULL DEFAULT '',
  pm_result TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'holding', 'blocked', 'done', 'failed')),
  error TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  done_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  legacy_id INTEGER,
  blocked_question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  progress_at INTEGER,
  hold_note TEXT NOT NULL DEFAULT '',
  relay_of INTEGER REFERENCES tasks(id) ON DELETE SET NULL
);
CREATE INDEX tasks_relay_of ON tasks (relay_of) WHERE relay_of IS NOT NULL;
CREATE INDEX tasks_agent_status ON tasks (to_agent_id, status, created_at DESC);
CREATE INDEX tasks_inbox ON tasks (inbox_id);
CREATE UNIQUE INDEX tasks_legacy ON tasks (legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  inbox_id INTEGER NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  answered_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER))
);
CREATE INDEX asks_task ON asks (task_id, created_at);

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  delta TEXT NOT NULL DEFAULT '',
  diff TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER))
);
CREATE INDEX artifacts_created ON artifacts (created_at DESC);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id INTEGER REFERENCES inbox(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  run_log TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  legacy_id INTEGER,
  legacy_source TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX events_legacy ON events (legacy_source, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX events_type ON events (type, created_at DESC);
CREATE INDEX events_created ON events (created_at DESC);

CREATE TABLE final_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id INTEGER NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  legacy_id INTEGER
);
CREATE INDEX final_replies_inbox ON final_replies (inbox_id, created_at DESC);
CREATE UNIQUE INDEX final_replies_legacy ON final_replies (legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  to_agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  request TEXT NOT NULL,
  cadence TEXT NOT NULL,
  weekdays_only INTEGER NOT NULL DEFAULT 1,
  on_miss TEXT NOT NULL DEFAULT 'run',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL,
  last_task_id INTEGER,
  last_run_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER)),
  kind TEXT NOT NULL DEFAULT 'request',
  last_result TEXT
);
CREATE INDEX schedules_due ON schedules (enabled, next_run_at);
CREATE UNIQUE INDEX schedules_system_job ON schedules (name) WHERE kind = 'system';

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000000 AS INTEGER))
);
