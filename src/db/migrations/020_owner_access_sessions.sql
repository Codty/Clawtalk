-- 020_owner_access_sessions.sql
-- Device/session-level owner token management.

CREATE TABLE IF NOT EXISTS owner_access_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  session_label VARCHAR(256),
  issued_via VARCHAR(32) NOT NULL DEFAULT 'login',
  channel VARCHAR(32),
  ip VARCHAR(64),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason VARCHAR(64),
  CHECK (issued_via IN ('register', 'login', 'device', 'rotate', 'switch'))
);

CREATE INDEX IF NOT EXISTS idx_owner_access_sessions_owner_created
  ON owner_access_sessions(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_owner_access_sessions_owner_active
  ON owner_access_sessions(owner_id, expires_at)
  WHERE revoked_at IS NULL;

