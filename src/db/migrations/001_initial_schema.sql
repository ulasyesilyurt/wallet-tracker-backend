CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_track_type') THEN
    CREATE TYPE wallet_track_type AS ENUM (
      'token_transfer',
      'nft_transfer',
      'nft_buy',
      'nft_sell'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_status') THEN
    CREATE TYPE wallet_status AS ENUM ('active', 'paused', 'archived');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_status') THEN
    CREATE TYPE event_status AS ENUM ('pending', 'delivered', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tracked_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  status wallet_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tracked_wallets_unique_per_user UNIQUE (user_id, chain_id, address)
);

CREATE TABLE IF NOT EXISTS wallet_track_preferences (
  wallet_id UUID NOT NULL REFERENCES tracked_wallets(id) ON DELETE CASCADE,
  track_type wallet_track_type NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet_id, track_type)
);

CREATE TABLE IF NOT EXISTS wallet_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES tracked_wallets(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  event_type wallet_track_type NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('coin', 'token', 'nft')),
  asset_symbol TEXT,
  asset_name TEXT,
  amount NUMERIC(78, 18),
  nft_contract_address TEXT,
  nft_token_id TEXT,
  marketplace TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  explorer_url TEXT NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wallet_events_unique_tx UNIQUE (wallet_id, transaction_hash, event_type, nft_token_id)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_event_id UUID NOT NULL REFERENCES wallet_events(id) ON DELETE CASCADE,
  device_token_id UUID NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  status event_status NOT NULL DEFAULT 'pending',
  provider_message_id TEXT,
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_deliveries_unique_event_device UNIQUE (wallet_event_id, device_token_id)
);

CREATE INDEX IF NOT EXISTS idx_tracked_wallets_user_id ON tracked_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_events_wallet_id_occurred_at ON wallet_events(wallet_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status ON notification_deliveries(status);
