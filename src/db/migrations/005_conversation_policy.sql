-- 005_conversation_policy.sql
-- Per-conversation policy: retention, allowed types, spam thresholds.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS policy_json JSONB NOT NULL DEFAULT '{}';

-- Example policy:
-- {
--   "retention_days": 7,
--   "allow_types": ["text", "tool_call"],
--   "spam_max_per_window": 20,
--   "spam_window_sec": 10
-- }

-- Rollback:
-- ALTER TABLE conversations DROP COLUMN IF EXISTS policy_json;
