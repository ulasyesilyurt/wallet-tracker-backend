DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum
    WHERE enumlabel = 'native_transfer'
      AND enumtypid = 'wallet_track_type'::regtype
  ) THEN
    ALTER TYPE wallet_track_type ADD VALUE 'native_transfer';
  END IF;
END $$;

ALTER TABLE wallet_events
  ADD COLUMN IF NOT EXISTS amount_wei TEXT,
  ADD COLUMN IF NOT EXISTS direction TEXT;

DROP INDEX IF EXISTS wallet_events_unique_wallet_log;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'wallet_events_unique_identity'
  ) THEN
    CREATE UNIQUE INDEX wallet_events_unique_identity
      ON wallet_events (
        wallet_id,
        transaction_hash,
        event_type,
        COALESCE(log_index, -1),
        COALESCE(nft_token_id, ''),
        COALESCE(direction, '')
      );
  END IF;
END $$;

ALTER TABLE wallet_events
  DROP CONSTRAINT IF EXISTS wallet_events_direction_check;

ALTER TABLE wallet_events
  ADD CONSTRAINT wallet_events_direction_check
  CHECK (direction IS NULL OR direction IN ('incoming', 'outgoing'));
