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
      SELECT id, user_id, fcm_token, platform
      FROM device_tokens
      WHERE user_id = $1
        AND is_active = TRUE
      ORDER BY created_at ASC
    `,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    fcmToken: row.fcm_token,
    platform: row.platform
  }));
}

export async function upsertNotificationDelivery({
  walletEventId,
  deviceTokenId,
  status,
  providerMessageId = null,
  errorMessage = null
}) {
  const sentAt = status === 'delivered' ? new Date().toISOString() : null;

  await query(
    `
      INSERT INTO notification_deliveries (
        wallet_event_id,
        device_token_id,
        status,
        provider_message_id,
        error_message,
        sent_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (wallet_event_id, device_token_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        provider_message_id = EXCLUDED.provider_message_id,
        error_message = EXCLUDED.error_message,
        sent_at = EXCLUDED.sent_at,
        updated_at = NOW()
    `,
    [walletEventId, deviceTokenId, status, providerMessageId, errorMessage, sentAt]
  );
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

export async function claimNotificationOutboxJobs({ limit, staleProcessingBefore }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `
        WITH candidates AS (
          SELECT no.id
          FROM notification_outbox no
          WHERE (
            no.status = 'pending'
            AND no.next_attempt_at <= NOW()
          ) OR (
            no.status = 'processing'
            AND no.locked_at IS NOT NULL
            AND no.locked_at <= $2
          )
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
      [limit, staleProcessingBefore]
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
      direction: row.direction,
      assetSymbol: row.asset_symbol,
      amount: row.amount != null ? row.amount.toString() : null,
      fromAddress: row.from_address,
      toAddress: row.to_address,
      chainId: row.chain_id,
      createdAt: row.wallet_event_created_at,
      occurredAt: row.occurred_at
    }
  };
}

export async function listNotificationDeliveriesByUserId(userId, { limit, offset }) {
  const result = await query(
    `
      SELECT
        nd.id,
        nd.wallet_event_id,
        nd.status,
        nd.provider_message_id,
        nd.error_message,
        nd.created_at,
        nd.sent_at,
        we.wallet_id,
        we.chain_id,
        we.transaction_hash,
        we.event_type,
        we.direction,
        we.asset_symbol,
        we.amount,
        we.from_address,
        we.to_address,
        we.created_at AS wallet_event_created_at,
        we.occurred_at,
        tw.label AS wallet_label,
        tw.address AS wallet_address
      FROM notification_deliveries nd
      INNER JOIN device_tokens dt ON dt.id = nd.device_token_id
      INNER JOIN wallet_events we ON we.id = nd.wallet_event_id
      INNER JOIN tracked_wallets tw ON tw.id = we.wallet_id
      WHERE dt.user_id = $1
      ORDER BY nd.created_at DESC, nd.id DESC
      LIMIT $2
      OFFSET $3
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
