-- Jobs the watcher does on its own clock, listed beside the standing requests so
-- they can be seen and switched off. The work stays in the watcher; a row only
-- carries whether it runs, how often, and what happened last. No agent, no request.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'request';
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_result TEXT;
ALTER TABLE schedules ALTER COLUMN to_agent_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS schedules_system_job ON schedules (name) WHERE kind = 'system';

INSERT INTO schedules (kind, name, request, cadence, weekdays_only, enabled, next_run_at) VALUES
  ('system', 'usage-probe', '', 'every:6', false, true, now()),
  ('system', 'stalled-nudge', '', 'every:30', false, true, now());
