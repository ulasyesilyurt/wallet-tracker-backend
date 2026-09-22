import { query } from '../../db/query.js';
import { NOTIFICATION_OUTBOX_STALE_PROCESSING_MS } from '../notifications/notifications.service.js';

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

export async function getNotificationOutboxOperationalSummary({
  dbQuery = query,
  nowMs = Date.now(),
  staleProcessingMs = NOTIFICATION_OUTBOX_STALE_PROCESSING_MS
} = {}) {
  const result = await dbQuery(
    `
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
        COUNT(*) FILTER (WHERE status = 'pending' AND attempt_count > 0)::int AS retrying_count,
        COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_count,
        COUNT(*) FILTER (
          WHERE status = 'processing'
            AND locked_at IS NOT NULL
            AND locked_at <= NOW() - ($1::int * INTERVAL '1 millisecond')
        )::int AS stale_processing_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
        MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at
      FROM notification_outbox
      WHERE status IN ('pending', 'processing', 'failed')
    `,
    [staleProcessingMs]
  );
  const row = result.rows[0] ?? {};
  const oldestPendingAt = toIso(row.oldest_pending_at);

  return {
    pendingCount: Number(row.pending_count ?? 0),
    retryingCount: Number(row.retrying_count ?? 0),
    processingCount: Number(row.processing_count ?? 0),
    staleProcessingCount: Number(row.stale_processing_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    oldestPendingAt,
    oldestPendingAgeSeconds: oldestPendingAt
      ? Math.max(0, Math.floor((nowMs - new Date(oldestPendingAt).getTime()) / 1_000))
      : null
  };
}
