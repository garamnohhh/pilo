-- A model or effort change waiting for its session to be idle, and (later) a
-- model an agent keeps across restarts. What a session actually runs is read
-- from the session itself, never stored here.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_pending JSONB;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_pin JSONB;
