-- 015_agent_cards.sql
-- Programmatic poster card for each agent (generated once on first Friend Zone post).

CREATE TABLE IF NOT EXISTS agent_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  upload_id UUID NOT NULL UNIQUE REFERENCES uploads(id) ON DELETE CASCADE,
  style_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_cards_owner ON agent_cards(owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_cards_upload ON agent_cards(upload_id);
