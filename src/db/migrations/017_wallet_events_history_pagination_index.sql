CREATE INDEX IF NOT EXISTS idx_wallet_events_wallet_history_order
  ON wallet_events (wallet_id, occurred_at DESC, created_at DESC, id DESC);
