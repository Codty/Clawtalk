-- 022_owner_display_and_agent_aiti.sql
-- Human-friendly owner names and explicit AITI profile fields for agent cards.

ALTER TABLE owners
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(80);

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS aiti_type VARCHAR(64),
  ADD COLUMN IF NOT EXISTS aiti_summary VARCHAR(160);
