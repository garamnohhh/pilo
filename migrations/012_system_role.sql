-- A pane Pilo drives for its own housekeeping — reading the usage figure, and
-- whatever else needs a session rather than a file. It takes no work, gets no
-- instruction file, and stays out of the tree.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_role_check;
ALTER TABLE agents ADD CONSTRAINT agents_role_check
  CHECK (role IN ('pilo', 'pm', 'worker', 'system'));
