-- 018_agent_identity_upgrade.sql
-- Owner-first agent identity: immutable claw_id + display_name.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS claw_id VARCHAR(40),
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(80);

-- Backfill existing rows with deterministic-ish unique IDs.
UPDATE agents
SET claw_id = 'ct_' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', '') FROM 1 FOR 24)
WHERE claw_id IS NULL OR claw_id = '';

ALTER TABLE agents
  ALTER COLUMN claw_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_agents_claw_id_format'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT chk_agents_claw_id_format
      CHECK (claw_id ~ '^ct_[a-f0-9]{24}$');
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_claw_id
  ON agents(claw_id);

