CREATE TABLE IF NOT EXISTS wallet_chain_holdings_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES tracked_wallets(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  holdings_count INTEGER NOT NULL DEFAULT 0,
  total_balance_usd NUMERIC(18, 2),
  token_balances_available BOOLEAN NOT NULL DEFAULT FALSE,
  is_partial BOOLEAN NOT NULL DEFAULT FALSE,
  captured_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wallet_chain_holdings_cache_unique_wallet_chain UNIQUE (wallet_id, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_wallet_chain_holdings_cache_wallet_chain
  ON wallet_chain_holdings_cache(wallet_id, chain_id);

CREATE INDEX IF NOT EXISTS idx_wallet_chain_holdings_cache_updated_at
  ON wallet_chain_holdings_cache(updated_at DESC);
