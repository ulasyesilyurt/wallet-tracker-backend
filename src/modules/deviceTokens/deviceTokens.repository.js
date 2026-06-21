import { query } from '../../db/query.js';

function mapDeviceToken(row) {
  return {
    id: row.id,
    userId: row.user_id,
    fcmToken: row.fcm_token,
    platform: row.platform,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function upsertDeviceToken({ userId, fcmToken, platform }) {
  const result = await query(
    `
      INSERT INTO device_tokens (user_id, fcm_token, platform, is_active, updated_at)
      VALUES ($1, $2, $3, TRUE, NOW())
      ON CONFLICT (fcm_token)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        is_active = TRUE,
        updated_at = NOW()
      RETURNING id, user_id, fcm_token, platform, is_active, created_at, updated_at
    `,
    [userId, fcmToken, platform]
  );

  console.log('[device-tokens] upsert result', {
    userId,
    platform,
    deviceTokenId: result.rows[0]?.id,
    savedForUserId: result.rows[0]?.user_id
  });

  return mapDeviceToken(result.rows[0]);
}

export async function deactivateDeviceToken({ userId, fcmToken }) {
  const result = await query(
    `
      UPDATE device_tokens
      SET is_active = FALSE,
          updated_at = NOW()
      WHERE user_id = $1
        AND fcm_token = $2
        AND is_active = TRUE
      RETURNING id, user_id, fcm_token, platform, is_active, created_at, updated_at
    `,
    [userId, fcmToken]
  );

  return result.rows[0] ? mapDeviceToken(result.rows[0]) : null;
}
