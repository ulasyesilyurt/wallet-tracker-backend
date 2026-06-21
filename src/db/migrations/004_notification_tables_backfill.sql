DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_status') THEN
    CREATE TYPE event_status AS ENUM ('pending', 'delivered', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'device_tokens_fcm_token_unique'
  ) THEN
    ALTER TABLE device_tokens
      ADD CONSTRAINT device_tokens_fcm_token_unique UNIQUE (fcm_token);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_device_tokens_user_id
  ON device_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active
  ON device_tokens(user_id, is_active);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_event_id UUID NOT NULL REFERENCES wallet_events(id) ON DELETE CASCADE,
  device_token_id UUID NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  status event_status NOT NULL DEFAULT 'pending',
  provider_message_id TEXT,
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notification_deliveries_unique_event_device'
  ) THEN
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT notification_deliveries_unique_event_device
      UNIQUE (wallet_event_id, device_token_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status
  ON notification_deliveries(status);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_wallet_event_id
  ON notification_deliveries(wallet_event_id);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_device_token_id
  ON notification_deliveries(device_token_id);
