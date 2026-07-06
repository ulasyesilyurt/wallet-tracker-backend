import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../config/logger.js';
import { ensureUserExists } from '../wallets/wallets.service.js';
import { deactivateDeviceToken, upsertDeviceToken } from './deviceTokens.repository.js';

const deviceTokensServiceLogger = logger.child({ module: 'device-tokens-service' });

export async function registerDeviceToken(payload) {
  await ensureUserExists(payload.userId);
  const deviceToken = await upsertDeviceToken(payload);

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
