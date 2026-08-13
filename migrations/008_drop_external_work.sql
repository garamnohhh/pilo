-- The external_work detection turned out to fire on ordinary flickers of the
-- session state, so it is gone. The live session state itself stays: that is
-- what the tree draws.
DELETE FROM events WHERE type = 'external_work';

ALTER TABLE agent_sessions DROP COLUMN IF EXISTS pending_since;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS pending_started;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS pending_seq;
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS seq;
