ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_device_unread
  ON notification_deliveries(device_token_id, created_at DESC)
  WHERE read_at IS NULL;
