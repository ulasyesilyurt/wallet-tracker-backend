CREATE TABLE IF NOT EXISTS wallet_portfolio_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES tracked_wallets(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL,
  total_usd NUMERIC(18, 2) NOT NULL,
  holdings_usd NUMERIC(18, 2) NOT NULL,
  positions_usd NUMERIC(18, 2) NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_portfolio_snapshots_wallet_captured_at
  ON wallet_portfolio_snapshots(wallet_id, captured_at DESC);
