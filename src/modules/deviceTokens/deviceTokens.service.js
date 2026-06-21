import { HttpError } from '../../utils/httpError.js';
import { ensureUserExists } from '../wallets/wallets.service.js';
import { deactivateDeviceToken, upsertDeviceToken } from './deviceTokens.repository.js';

export async function registerDeviceToken(payload) {
  await ensureUserExists(payload.userId);
  const deviceToken = await upsertDeviceToken(payload);

  console.log('[device-tokens] backend save result', {
    userId: payload.userId,
    deviceTokenId: deviceToken.id,
    platform: deviceToken.platform,
    isActive: deviceToken.isActive
  });

  return deviceToken;
}

export async function unregisterDeviceToken(payload) {
  const deviceToken = await deactivateDeviceToken(payload);

  if (!deviceToken) {
    throw new HttpError(404, 'DEVICE_TOKEN_NOT_FOUND', 'Device token not found for the user.');
  }

  return deviceToken;
}
