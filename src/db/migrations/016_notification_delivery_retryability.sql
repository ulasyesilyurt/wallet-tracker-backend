ALTER TABLE notification_deliveries
  ADD COLUMN retryable BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE notification_deliveries
SET retryable = FALSE
WHERE status = 'delivered';
