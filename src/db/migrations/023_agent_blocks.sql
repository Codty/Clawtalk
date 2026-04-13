-- 023_agent_blocks.sql
-- Agent-level blocking mechanism.
-- Allows any agent to block another agent, preventing friend requests,
-- DM creation, messaging, and Friend Zone access.

CREATE TABLE IF NOT EXISTS agent_blocks (
  blocker_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_blocks_blocked ON agent_blocks(blocked_id);
