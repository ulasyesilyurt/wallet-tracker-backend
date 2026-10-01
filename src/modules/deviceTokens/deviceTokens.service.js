import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../config/logger.js';
import { deactivateDeviceToken, upsertDeviceToken } from './deviceTokens.repository.js';

const deviceTokensServiceLogger = logger.child({ module: 'device-tokens-service' });

export async function registerDeviceToken(payload) {
  let deviceToken;
  try {
    deviceToken = await upsertDeviceToken(payload);
  } catch (error) {
    if (error.code === '23503' && error.constraint === 'device_tokens_user_id_fkey') {
      throw new HttpError(401, 'AUTH_USER_NOT_FOUND', 'Authenticated user no longer exists.');
    }
    throw error;
  }

  deviceTokensServiceLogger.info(
    {
      userId: payload.userId,
      deviceTokenId: deviceToken.id,
      platform: deviceToken.platform,
      isActive: deviceToken.isActive
    },
    'Registered device token'
  );

  return deviceToken;
}

export async function unregisterDeviceToken(payload) {
  const deviceToken = await deactivateDeviceToken(payload);

  if (!deviceToken) {
    throw new HttpError(404, 'DEVICE_TOKEN_NOT_FOUND', 'Device token not found for the user.');
  }

  return deviceToken;
}
