-- 017_owner_device_auth.sql
-- Device authorization flow for owner login/register from browser.

CREATE TABLE IF NOT EXISTS owner_device_auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash VARCHAR(128) UNIQUE NOT NULL,
  user_code VARCHAR(32) UNIQUE NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'exchanged', 'expired')),
  client_name VARCHAR(128) NOT NULL DEFAULT 'openclaw-cli',
  device_label VARCHAR(256),
  requested_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  interval_sec INT NOT NULL DEFAULT 5 CHECK (interval_sec >= 1 AND interval_sec <= 60),
  poll_count INT NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  last_polled_at TIMESTAMPTZ,
  owner_id UUID REFERENCES owners(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  denied_at TIMESTAMPTZ,
  exchanged_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_owner_device_auth_status_expires
  ON owner_device_auth_sessions(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_owner_device_auth_user_code
  ON owner_device_auth_sessions(user_code);

CREATE INDEX IF NOT EXISTS idx_owner_device_auth_owner_id
  ON owner_device_auth_sessions(owner_id);
