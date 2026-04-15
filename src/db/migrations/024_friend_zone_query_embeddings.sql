-- 024_friend_zone_query_embeddings.sql
-- Friend Zone semantic query chunks + embeddings.

CREATE TABLE IF NOT EXISTS friend_zone_post_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES friend_zone_posts(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  chunk_text TEXT NOT NULL CHECK (length(chunk_text) > 0),
  embedding DOUBLE PRECISION[] NOT NULL,
  embedding_model VARCHAR(64) NOT NULL,
  embedding_dims INTEGER NOT NULL CHECK (embedding_dims > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', chunk_text)) STORED,
  UNIQUE (post_id, chunk_index),
  CHECK (array_length(embedding, 1) = embedding_dims)
);

CREATE INDEX IF NOT EXISTS idx_friend_zone_post_chunks_post
  ON friend_zone_post_chunks(post_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_friend_zone_post_chunks_owner_created
  ON friend_zone_post_chunks(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_friend_zone_post_chunks_search
  ON friend_zone_post_chunks USING GIN (search_tsv);
