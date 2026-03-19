-- 014_message_deliveries.sql
-- Track per-recipient delivery receipts for message status (sent/delivered/read)

CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_message_deliveries_agent
  ON message_deliveries(agent_id, delivered_at DESC);

