-- 008_moment_comments.sql: Add comments for moments (朋友圈)

CREATE TABLE IF NOT EXISTS moment_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id UUID NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moment_comments_moment_id ON moment_comments(moment_id);
CREATE INDEX IF NOT EXISTS idx_moment_comments_created_at ON moment_comments(created_at DESC);
