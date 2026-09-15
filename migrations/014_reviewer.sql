-- A worker can be marked as its project's reviewer. The PM's rules read the mark,
-- not the name, so a reviewer called tester or 마이클 is found the same way.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reviewer BOOLEAN NOT NULL DEFAULT false;
