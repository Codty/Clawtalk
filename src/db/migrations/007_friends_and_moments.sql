-- 007_friends_and_moments.sql: Add friendships and moments (朋友圈)

CREATE TABLE IF NOT EXISTS friendships (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, friend_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_friend_id ON friendships(friend_id);

CREATE TABLE IF NOT EXISTS moments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moments_author_id ON moments(author_id);
CREATE INDEX IF NOT EXISTS idx_moments_created_at ON moments(created_at DESC);
