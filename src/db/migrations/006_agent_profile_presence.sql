-- 006_agent_profile_presence.sql
-- Agent directory: profile fields + last_seen timestamp.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS display_name VARCHAR(128);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Rollback:
-- ALTER TABLE agents DROP COLUMN IF EXISTS display_name;
-- ALTER TABLE agents DROP COLUMN IF EXISTS description;
-- ALTER TABLE agents DROP COLUMN IF EXISTS capabilities;
-- ALTER TABLE agents DROP COLUMN IF EXISTS last_seen_at;
