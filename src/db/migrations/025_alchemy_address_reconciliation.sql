CREATE TABLE IF NOT EXISTS alchemy_address_reconciliation (
  chain_id TEXT NOT NULL CHECK (chain_id IN ('ethereum-mainnet', 'base-mainnet')),
  normalized_address TEXT NOT NULL
    CHECK (normalized_address ~ '^0x[0-9a-f]{40}$'),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, normalized_address),
  CONSTRAINT alchemy_address_reconciliation_claim_check
    CHECK ((claim_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_alchemy_address_reconciliation_due
  ON alchemy_address_reconciliation (next_attempt_at, created_at);
