ALTER TABLE wallet_events
  ADD COLUMN IF NOT EXISTS usd_value NUMERIC(18, 2),
  ADD COLUMN IF NOT EXISTS usd_value_status TEXT,
  ADD COLUMN IF NOT EXISTS usd_value_source TEXT,
  ADD COLUMN IF NOT EXISTS usd_value_calculated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS wallet_alert_settings (
  wallet_id UUID PRIMARY KEY REFERENCES tracked_wallets(id) ON DELETE CASCADE,
  minimum_alert_usd NUMERIC(18, 2),
  notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  notify_nft_transfers BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
