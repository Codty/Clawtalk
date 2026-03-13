-- 009_product_features.sql
-- Product completeness upgrade:
-- - admin/ban/whitelist
-- - friend request workflow
-- - message read receipts, recall, soft-delete, attachments

-- ── Agents: admin + ban flags ────────────────────────────────────────────────
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS banned_reason TEXT,
  ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agents_is_admin ON agents(is_admin);
CREATE INDEX IF NOT EXISTS idx_agents_is_banned ON agents(is_banned);

-- ── Risk whitelist (mainly for IP-based anti-abuse exemptions) ───────────────
CREATE TABLE IF NOT EXISTS risk_whitelist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip VARCHAR(64) NOT NULL UNIQUE,
  note TEXT,
  created_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Friend requests workflow ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friend_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  to_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  request_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  responded_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  CHECK (from_agent_id <> to_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_agent_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_friend_requests_pending_pair
  ON friend_requests(from_agent_id, to_agent_id)
  WHERE status = 'pending';

-- ── Messages: recall / soft-delete metadata ──────────────────────────────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recalled_by UUID REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recall_reason TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_not_deleted ON messages(conversation_id, created_at DESC) WHERE deleted_at IS NULL;

-- ── Message read receipts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_reads (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reads_agent ON message_reads(agent_id, read_at DESC);

-- ── Message attachments metadata ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  mime_type VARCHAR(255),
  size_bytes BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id);
