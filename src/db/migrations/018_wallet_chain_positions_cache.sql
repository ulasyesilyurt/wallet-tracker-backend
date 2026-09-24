CREATE TABLE IF NOT EXISTS wallet_chain_positions_cache (
  wallet_id UUID NOT NULL REFERENCES tracked_wallets(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  positions JSONB NOT NULL CHECK (jsonb_typeof(positions) = 'array'),
  captured_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet_id, chain_id)
);
