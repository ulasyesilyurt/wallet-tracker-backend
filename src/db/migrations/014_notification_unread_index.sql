DROP INDEX IF EXISTS idx_notification_deliveries_device_unread;

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_event_unread
  ON notification_deliveries(wallet_event_id, created_at DESC)
  WHERE read_at IS NULL;
