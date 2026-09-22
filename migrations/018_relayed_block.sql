-- Which block a PM filed on behalf of. A worker asks its PM for a decision, the
-- PM carries the question up, and the user used to be shown both — two lines for
-- one choice, only one of which could be answered. The PM states the link when
-- it files (`pilo block <id> "…" --for <worker task>`); wording is never guessed
-- at, because two questions from a PM and its own worker score the same on any
-- text measure whether they are the same question or not.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS relay_of BIGINT REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_relay_of ON tasks (relay_of) WHERE relay_of IS NOT NULL;
