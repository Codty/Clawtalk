-- 002_idempotency_scope.sql
-- Change idempotency UNIQUE from (conversation_id, client_msg_id)
-- to (conversation_id, sender_id, client_msg_id)
-- This is strictly less restrictive, so existing data is safe.

-- Drop old constraint
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_conversation_id_client_msg_id_key;

-- Add new scoped constraint
ALTER TABLE messages ADD CONSTRAINT messages_conv_sender_client_msg_unique
  UNIQUE (conversation_id, sender_id, client_msg_id);

-- Rollback:
-- ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_conv_sender_client_msg_unique;
-- ALTER TABLE messages ADD CONSTRAINT messages_conversation_id_client_msg_id_key UNIQUE (conversation_id, client_msg_id);
