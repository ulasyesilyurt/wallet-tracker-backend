CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_event_id UUID NOT NULL UNIQUE REFERENCES wallet_events(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Preserve one existing delivery ID per event for single-device clients. An
-- outbox ID identifies events that previously had no device or delivery row.
WITH delivery_groups AS (
  SELECT
    wallet_event_id,
    (ARRAY_AGG(id ORDER BY created_at, id))[1] AS first_delivery_id,
    MIN(created_at) AS first_delivery_at,
    CASE
      WHEN COUNT(*) FILTER (WHERE read_at IS NULL) = 0 THEN MAX(read_at)
      ELSE NULL
    END AS read_at
  FROM notification_deliveries
  GROUP BY wallet_event_id
)
INSERT INTO notifications (id, wallet_event_id, read_at, created_at)
SELECT
  COALESCE(d.first_delivery_id, no.id),
  COALESCE(d.wallet_event_id, no.wallet_event_id),
  d.read_at,
  COALESCE(d.first_delivery_at, no.created_at)
FROM notification_outbox no
FULL OUTER JOIN delivery_groups d ON d.wallet_event_id = no.wallet_event_id;

ALTER TABLE notification_deliveries
  ADD COLUMN notification_id UUID;

UPDATE notification_deliveries nd
SET notification_id = n.id
FROM notifications n
WHERE n.wallet_event_id = nd.wallet_event_id;

ALTER TABLE notification_deliveries
  ALTER COLUMN notification_id SET NOT NULL,
  ADD CONSTRAINT notification_deliveries_notification_id_fkey
    FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE;

CREATE INDEX idx_notification_deliveries_notification_id
  ON notification_deliveries(notification_id);

CREATE INDEX idx_notifications_created_at
  ON notifications(created_at DESC, id DESC);

CREATE INDEX idx_notifications_unread_event
  ON notifications(wallet_event_id)
  WHERE read_at IS NULL;
