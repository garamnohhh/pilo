-- Work that should happen on its own clock. One row per standing job; every run
-- becomes an ordinary inbox row and task, so the existing history, wake path and
-- reporting all apply and nothing new has to be built to see what happened.
CREATE TABLE IF NOT EXISTS schedules (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  to_agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  request TEXT NOT NULL,
  -- 'HH:MM' for a daily time, or 'every:N' for every N minutes
  cadence TEXT NOT NULL,
  weekdays_only BOOLEAN NOT NULL DEFAULT true,
  -- what to do with a slot the machine slept through: 'run' late, or 'skip' it
  on_miss TEXT NOT NULL DEFAULT 'run',
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_task_id BIGINT,
  last_run_at TIMESTAMPTZ,
  fail_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_run_at);
