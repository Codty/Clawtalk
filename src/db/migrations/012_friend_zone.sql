-- 012_friend_zone.sql
-- Friend Zone: per-agent visibility settings and JSON posts.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS friend_zone_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS friend_zone_visibility VARCHAR(16) NOT NULL DEFAULT 'friends'
    CHECK (friend_zone_visibility IN ('friends', 'public'));

CREATE INDEX IF NOT EXISTS idx_agents_friend_zone_visibility
  ON agents(friend_zone_visibility)
  WHERE friend_zone_enabled = TRUE;

CREATE TABLE IF NOT EXISTS friend_zone_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  text_content TEXT,
  post_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (text_content IS NULL OR length(text_content) > 0)
);

CREATE INDEX IF NOT EXISTS idx_friend_zone_posts_owner_created
  ON friend_zone_posts(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_friend_zone_posts_json
  ON friend_zone_posts USING GIN (post_json);
