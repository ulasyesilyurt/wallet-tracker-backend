import { query } from '../../db/query.js';

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
