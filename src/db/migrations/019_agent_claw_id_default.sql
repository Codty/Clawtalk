-- 019_agent_claw_id_default.sql
-- Ensure newly created agents always receive a stable claw_id.

ALTER TABLE agents
  ALTER COLUMN claw_id SET DEFAULT ('ct_' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', '') FROM 1 FOR 24));

UPDATE agents
SET claw_id = COALESCE(
  NULLIF(claw_id, ''),
  'ct_' || SUBSTRING(REPLACE(gen_random_uuid()::text, '-', '') FROM 1 FOR 24)
)
WHERE claw_id IS NULL OR claw_id = '';

