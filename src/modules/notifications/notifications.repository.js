import { pool } from '../../db/pool.js';
import { query } from '../../db/query.js';

function runDbQuery(dbClient, text, params) {
  if (dbClient?.query) {
    return dbClient.query(text, params);
  }

  return query(text, params);
}

export async function getWalletNotificationTarget(walletId) {
  const result = await query(
    `
      SELECT
        tw.id AS wallet_id,
        tw.user_id,
        tw.label AS wallet_label,
        tw.address AS wallet_address
      FROM tracked_wallets tw
      WHERE tw.id = $1
    `,
    [walletId]
  );

  return result.rows[0] ?? null;
}

export async function listActiveDeviceTokensByUserId(userId) {
  const result = await query(
    `
      SELECT id, user_id, fcm_token, platform, updated_at::text AS token_updated_at
      FROM device_tokens
      WHERE user_id = $1
        AND is_active = TRUE
      ORDER BY created_at ASC, id ASC
    `,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    fcmToken: row.fcm_token,
    platform: row.platform,
    tokenUpdatedAt: row.token_updated_at
  }));
}

export async function upsertNotificationDelivery({
  notificationId,
  walletEventId,
  deviceTokenId,
  status,
  providerMessageId = null,
  errorMessage = null,
  retryable = status === 'pending'
}, dbClient = null) {
  const sentAt = status === 'delivered' ? new Date().toISOString() : null;

  const result = await runDbQuery(dbClient,
    `
      INSERT INTO notification_deliveries (
        notification_id,
        wallet_event_id,
        device_token_id,
        status,
        provider_message_id,
        error_message,
        sent_at,
        retryable,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (wallet_event_id, device_token_id)
      DO UPDATE SET
        notification_id = EXCLUDED.notification_id,
        status = EXCLUDED.status,
        provider_message_id = EXCLUDED.provider_message_id,
        error_message = EXCLUDED.error_message,
        sent_at = EXCLUDED.sent_at,
        retryable = EXCLUDED.retryable,
        updated_at = NOW()
      WHERE notification_deliveries.status <> 'delivered'
    `,
    [notificationId, walletEventId, deviceTokenId, status, providerMessageId, errorMessage, sentAt, retryable]
  );

  return result.rowCount > 0;
}

export async function listNotificationDeliveryStates(notificationId) {
  const result = await query(
    `
      SELECT device_token_id, status, retryable
      FROM notification_deliveries
      WHERE notification_id = $1
    `,
    [notificationId]
  );

  return result.rows.map((row) => ({
    deviceTokenId: row.device_token_id,
    status: row.status,
    retryable: row.retryable
  }));
}

export async function recordInvalidTokenDelivery({
  notificationId,
  walletEventId,
  deviceTokenId,
  userId,
  fcmToken,
  tokenUpdatedAt,
  errorMessage
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await upsertNotificationDelivery({
      notificationId,
      walletEventId,
      deviceTokenId,
      status: 'failed',
      errorMessage,
      retryable: false
    }, client);
    await client.query(
      `
        UPDATE device_tokens
        SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND fcm_token = $3
          AND updated_at = $4::timestamptz AND is_active = TRUE
      `,
      [deviceTokenId, userId, fcmToken, tokenUpdatedAt]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureNotificationForWalletEvent(walletEventId) {
  const result = await query(
    `
      INSERT INTO notifications (wallet_event_id)
      VALUES ($1)
      ON CONFLICT (wallet_event_id) DO UPDATE
      SET wallet_event_id = EXCLUDED.wallet_event_id
      RETURNING id
    `,
    [walletEventId]
  );

  return result.rows[0].id;
}

export async function enqueueNotificationOutbox(client, walletEventId) {
  const result = await client.query(
    `
      INSERT INTO notification_outbox (
        wallet_event_id,
        status,
        attempt_count,
        next_attempt_at,
        created_at,
        updated_at
      )
      VALUES ($1, 'pending', 0, NOW(), NOW(), NOW())
      ON CONFLICT (wallet_event_id) DO NOTHING
      RETURNING id, wallet_event_id, status, attempt_count, next_attempt_at, locked_at, last_error, processed_at, created_at, updated_at
    `,
    [walletEventId]
  );

  return result.rows[0]
    ? {
      id: result.rows[0].id,
      walletEventId: result.rows[0].wallet_event_id,
      status: result.rows[0].status,
      attemptCount: Number(result.rows[0].attempt_count ?? 0),
      nextAttemptAt: result.rows[0].next_attempt_at,
      lockedAt: result.rows[0].locked_at,
      lastError: result.rows[0].last_error,
      processedAt: result.rows[0].processed_at,
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[0].updated_at
    }
    : null;
}

function mapWalletAlertSettingsRow(row) {
  if (!row) {
    return null;
  }

  return {
    walletId: row.wallet_id,
    minimumAlertUsd: row.minimum_alert_usd != null ? Number(row.minimum_alert_usd) : null,
    notificationsEnabled: row.notifications_enabled,
    notifyFungibleTransfers: row.notify_fungible_transfers,
    notifyIncomingTransfers: row.notify_incoming_transfers,
    notifyOutgoingTransfers: row.notify_outgoing_transfers,
    notifyNftTransfers: row.notify_nft_transfers,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getWalletAlertSettingsByWalletId(dbClient, walletId) {
  const result = await runDbQuery(
    dbClient,
    `
      SELECT
        wallet_id,
        minimum_alert_usd,
        notifications_enabled,
        notify_fungible_transfers,
        notify_incoming_transfers,
        notify_outgoing_transfers,
        notify_nft_transfers,
        created_at,
        updated_at
      FROM wallet_alert_settings
      WHERE wallet_id = $1
      LIMIT 1
    `,
    [walletId]
  );

  return mapWalletAlertSettingsRow(result.rows[0]);
}

function mapNotificationOutboxRow(row) {
  return {
    id: row.id,
    walletEventId: row.wallet_event_id,
    status: row.status,
    attemptCount: Number(row.attempt_count ?? 0),
    nextAttemptAt: row.next_attempt_at,
    lockedAt: row.locked_at,
    lastError: row.last_error,
    processedAt: row.processed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function claimNotificationOutboxJobs({ limit, staleProcessingBefore, outboxId = null }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `
        WITH candidates AS (
          SELECT no.id
          FROM notification_outbox no
          WHERE ((
            no.status = 'pending'
            AND no.next_attempt_at <= NOW()
          ) OR (
            no.status = 'processing'
            AND no.locked_at IS NOT NULL
            AND no.locked_at <= $2
          )) AND ($3::uuid IS NULL OR no.id = $3)
          ORDER BY no.next_attempt_at ASC, no.created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE notification_outbox no
        SET status = 'processing',
            attempt_count = no.attempt_count + 1,
            locked_at = NOW(),
            updated_at = NOW()
        FROM candidates
        WHERE no.id = candidates.id
        RETURNING
          no.id,
          no.wallet_event_id,
          no.status,
          no.attempt_count,
          no.next_attempt_at,
          no.locked_at,
          no.last_error,
          no.processed_at,
          no.created_at,
          no.updated_at
      `,
      [limit, staleProcessingBefore, outboxId]
    );

    await client.query('COMMIT');
    return result.rows.map(mapNotificationOutboxRow);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markNotificationOutboxSent(outboxId) {
  await query(
    `
      UPDATE notification_outbox
      SET status = 'sent',
          locked_at = NULL,
          last_error = NULL,
          processed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [outboxId]
  );
}

export async function scheduleNotificationOutboxRetry(outboxId, { nextAttemptAt, errorMessage }) {
  await query(
    `
      UPDATE notification_outbox
      SET status = 'pending',
          locked_at = NULL,
          next_attempt_at = $2,
          last_error = $3,
          updated_at = NOW()
      WHERE id = $1
    `,
    [outboxId, nextAttemptAt, errorMessage]
  );
}

export async function markNotificationOutboxFailed(outboxId, { errorMessage }) {
  await query(
    `
      UPDATE notification_outbox
      SET status = 'failed',
          locked_at = NULL,
          last_error = $2,
          processed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [outboxId, errorMessage]
  );
}

function mapWalletEventNotificationContext(row) {
  return {
    id: row.wallet_event_id,
    walletId: row.wallet_id,
    userId: row.user_id,
    walletLabel: row.wallet_label,
    walletAddress: row.wallet_address,
    chainId: row.chain_id,
    transactionHash: row.transaction_hash,
    eventType: row.event_type,
    assetType: row.asset_type,
    assetSymbol: row.asset_symbol,
    assetName: row.asset_name,
    amount: row.amount != null ? row.amount.toString() : null,
    nftContractAddress: row.nft_contract_address,
    nftTokenId: row.nft_token_id,
    direction: row.direction,
    usdValue: row.usd_value != null ? row.usd_value.toString() : null,
    usdValueStatus: row.usd_value_status,
    usdValueSource: row.usd_value_source,
    usdValueCalculatedAt: row.usd_value_calculated_at,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    occurredAt: row.occurred_at
  };
}

export async function getWalletEventNotificationContext(walletEventId) {
  const result = await query(
    `
      SELECT
        we.id AS wallet_event_id,
        we.wallet_id,
        we.chain_id,
        we.transaction_hash,
        we.event_type,
        we.asset_type,
        we.asset_symbol,
        we.asset_name,
        we.amount,
        we.nft_contract_address,
        we.nft_token_id,
        we.direction,
        we.usd_value,
        we.usd_value_status,
        we.usd_value_source,
        we.usd_value_calculated_at,
        we.from_address,
        we.to_address,
        we.occurred_at,
        tw.user_id,
        tw.label AS wallet_label,
        tw.address AS wallet_address
      FROM wallet_events we
      INNER JOIN tracked_wallets tw ON tw.id = we.wallet_id
      WHERE we.id = $1
      LIMIT 1
    `,
    [walletEventId]
  );

  return result.rows[0] ? mapWalletEventNotificationContext(result.rows[0]) : null;
}

function mapNotificationHistoryRow(row) {
  return {
    id: row.id,
    status: row.status,
    readAt: row.read_at,
    isRead: row.read_at != null,
    providerMessageId: row.provider_message_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    walletEvent: {
      id: row.wallet_event_id,
      walletId: row.wallet_id,
      walletLabel: row.wallet_label,
      walletAddress: row.wallet_address,
      transactionHash: row.transaction_hash,
      eventType: row.event_type,
      assetType: row.asset_type,
      assetName: row.asset_name,
      direction: row.direction,
      assetSymbol: row.asset_symbol,
      amount: row.amount != null ? row.amount.toString() : null,
      nftTokenId: row.nft_token_id,
      usdValue: row.usd_value != null ? row.usd_value.toString() : null,
      usdValueStatus: row.usd_value_status,
      fromAddress: row.from_address,
      toAddress: row.to_address,
      chainId: row.chain_id,
      createdAt: row.wallet_event_created_at,
      occurredAt: row.occurred_at
    }
  };
}

export async function listNotificationsByUserId(userId, { limit, offset }) {
  const result = await query(
    `
      WITH page AS MATERIALIZED (
        SELECT n.id, n.wallet_event_id, n.read_at, n.created_at
        FROM notifications n
        INNER JOIN wallet_events we ON we.id = n.wallet_event_id
        INNER JOIN tracked_wallets tw ON tw.id = we.wallet_id
        WHERE tw.user_id = $1
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT $2 OFFSET $3
      )
      SELECT
        n.id,
        n.wallet_event_id,
        n.read_at,
        n.created_at,
        COALESCE(delivery.status::text, CASE WHEN no.status = 'sent' THEN 'failed' ELSE 'pending' END) AS status,
        delivery.provider_message_id,
        COALESCE(delivery.error_message, CASE WHEN no.status = 'sent' AND delivery.status IS NULL THEN 'no_active_device_tokens' ELSE NULL END) AS error_message,
        delivery.sent_at,
        we.wallet_id,
        we.chain_id,
        we.transaction_hash,
        we.event_type,
        we.asset_type,
        we.asset_name,
        we.direction,
        we.asset_symbol,
        we.amount,
        we.nft_token_id,
        we.usd_value,
        we.usd_value_status,
        we.from_address,
        we.to_address,
        we.created_at AS wallet_event_created_at,
        we.occurred_at,
        tw.label AS wallet_label,
        tw.address AS wallet_address
      FROM page n
      INNER JOIN wallet_events we ON we.id = n.wallet_event_id
      INNER JOIN tracked_wallets tw ON tw.id = we.wallet_id
      LEFT JOIN notification_outbox no ON no.wallet_event_id = n.wallet_event_id
      LEFT JOIN LATERAL (
        SELECT nd.status, nd.provider_message_id, nd.error_message, nd.sent_at
        FROM notification_deliveries nd
        WHERE nd.notification_id = n.id
        ORDER BY CASE nd.status WHEN 'delivered' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
                 nd.created_at ASC, nd.id ASC
        LIMIT 1
      ) delivery ON TRUE
      ORDER BY n.created_at DESC, n.id DESC
    `,
    [userId, limit, offset]
  );

  const items = result.rows.map(mapNotificationHistoryRow);

  return {
    items,
    pagination: {
      limit,
      offset,
      hasMore: result.rowCount === limit
    }
  };
}

export async function countUnreadNotificationsByUserId(userId) {
  const result = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM notifications n
      INNER JOIN wallet_events we ON we.id = n.wallet_event_id
      INNER JOIN tracked_wallets tw ON tw.id = we.wallet_id
      WHERE tw.user_id = $1
        AND n.read_at IS NULL
    `,
    [userId]
  );

  return result.rows[0]?.count ?? 0;
}

export async function markNotificationReadById(notificationId, userId) {
  const result = await query(
    `
      UPDATE notifications n
      SET read_at = COALESCE(n.read_at, NOW()),
          updated_at = NOW()
      FROM wallet_events we, tracked_wallets tw
      WHERE n.id = COALESCE(
          (SELECT legacy.notification_id FROM notification_deliveries legacy WHERE legacy.id = $1),
          $1::uuid
        )
        AND we.id = n.wallet_event_id
        AND tw.id = we.wallet_id
        AND tw.user_id = $2
      RETURNING n.id, n.read_at
    `,
    [notificationId, userId]
  );

  return result.rows[0]
    ? { id: result.rows[0].id, readAt: result.rows[0].read_at }
    : null;
}

export async function markAllNotificationsReadByUserId(userId) {
  const result = await query(
    `
      UPDATE notifications n
      SET read_at = NOW(),
          updated_at = NOW()
      FROM wallet_events we, tracked_wallets tw
      WHERE we.id = n.wallet_event_id
        AND tw.id = we.wallet_id
        AND tw.user_id = $1
        AND n.read_at IS NULL
    `,
    [userId]
  );

  return result.rowCount;
}
