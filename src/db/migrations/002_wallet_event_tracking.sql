CREATE TABLE IF NOT EXISTS chain_sync_state (
  chain_id TEXT NOT NULL,
  sync_key TEXT NOT NULL,
  last_synced_block BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, sync_key)
);

ALTER TABLE wallet_events
  ADD COLUMN IF NOT EXISTS block_number BIGINT,
  ADD COLUMN IF NOT EXISTS log_index INTEGER,
  ADD COLUMN IF NOT EXISTS from_address TEXT,
  ADD COLUMN IF NOT EXISTS to_address TEXT;

ALTER TABLE wallet_events
  DROP CONSTRAINT IF EXISTS wallet_events_unique_tx;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'wallet_events_unique_wallet_log'
  ) THEN
    CREATE UNIQUE INDEX wallet_events_unique_wallet_log
      ON wallet_events (wallet_id, transaction_hash, log_index);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_wallet_events_wallet_block_number
  ON wallet_events(wallet_id, block_number DESC);

CREATE INDEX IF NOT EXISTS idx_chain_sync_state_updated_at
  ON chain_sync_state(updated_at DESC);
