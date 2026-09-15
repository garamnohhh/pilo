-- What the desk says to the user while a task waits on their decision. Not an
-- answer: the request stays open, and the user's reply goes to the task that asked.
CREATE TABLE IF NOT EXISTS asks (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  inbox_id BIGINT NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asks_task ON asks (task_id, created_at);
