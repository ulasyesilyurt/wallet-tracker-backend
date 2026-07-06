CREATE TABLE IF NOT EXISTS notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_event_id UUID NOT NULL REFERENCES wallet_events(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_outbox_unique_wallet_event UNIQUE (wallet_event_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_status_next_attempt
  ON notification_outbox(status, next_attempt_at ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_processing_locked
  ON notification_outbox(status, locked_at ASC);
