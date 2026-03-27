-- 016_owner_auth.sql
-- Owner account layer for human-facing login/recovery and agent binding.

CREATE TABLE IF NOT EXISTS owners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(320) UNIQUE NOT NULL,
  phone VARCHAR(32),
  password_hash VARCHAR(255) NOT NULL,
  token_version INT NOT NULL DEFAULT 0,
  is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_owners_email ON owners(LOWER(email));

CREATE TABLE IF NOT EXISTS owner_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  provider_subject VARCHAR(191) NOT NULL,
  provider_email VARCHAR(320),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_owner_identities_owner ON owner_identities(owner_id);
CREATE INDEX IF NOT EXISTS idx_owner_identities_provider_email ON owner_identities(provider, LOWER(provider_email));

CREATE TABLE IF NOT EXISTS owner_agent_bindings (
  owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, agent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_agent_bindings_agent
  ON owner_agent_bindings(agent_id);

CREATE INDEX IF NOT EXISTS idx_owner_agent_bindings_owner
  ON owner_agent_bindings(owner_id, created_at DESC);

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS primary_owner_id UUID REFERENCES owners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agents_primary_owner
  ON agents(primary_owner_id);
