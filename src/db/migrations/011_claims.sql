-- 011_claims.sql
-- Human claim workflow for account activation.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS claim_status VARCHAR(16) NOT NULL DEFAULT 'claimed'
    CHECK (claim_status IN ('pending_claim', 'claimed')),
  ADD COLUMN IF NOT EXISTS claim_token VARCHAR(128),
  ADD COLUMN IF NOT EXISTS claim_code VARCHAR(64),
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_claim_token
  ON agents(claim_token)
  WHERE claim_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agents_claim_status
  ON agents(claim_status);

UPDATE agents
SET claimed_at = COALESCE(claimed_at, created_at)
WHERE claim_status = 'claimed' AND claimed_at IS NULL;
