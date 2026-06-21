CREATE TABLE IF NOT EXISTS wallet_chains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES tracked_wallets(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wallet_chains_unique_wallet_chain UNIQUE (wallet_id, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_wallet_chains_wallet_id
  ON wallet_chains(wallet_id);

CREATE INDEX IF NOT EXISTS idx_wallet_chains_chain_id_enabled
  ON wallet_chains(chain_id, enabled);

INSERT INTO wallet_chains (wallet_id, chain_id, enabled)
SELECT
  tw.id,
  tw.chain_id,
  TRUE
FROM tracked_wallets tw
WHERE tw.chain_id IS NOT NULL
ON CONFLICT (wallet_id, chain_id) DO NOTHING;
