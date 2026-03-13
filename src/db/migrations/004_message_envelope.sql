-- 004_message_envelope.sql
-- Add structured envelope (payload_json) to messages.
-- Backward compatible: backfill existing rows from content.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS payload_json JSONB;

-- Backfill existing messages: wrap content as {type:"text", content:"..."}
UPDATE messages
SET payload_json = jsonb_build_object('type', 'text', 'content', content)
WHERE payload_json IS NULL;

-- Rollback:
-- ALTER TABLE messages DROP COLUMN IF EXISTS payload_json;
