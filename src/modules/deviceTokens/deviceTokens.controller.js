import { registerDeviceToken, unregisterDeviceToken } from './deviceTokens.service.js';

export async function addDeviceToken(req, res) {
  const { token, platform } = req.validated.body;
  console.log('[device-tokens] authenticated registration request received', {
    authUserId: req.auth.user.id,
    routeUserId: req.validated.params.userId,
    platform,
    tokenPreview: token.slice(0, 12)
  });

  const deviceToken = await registerDeviceToken({
    userId: req.auth.user.id,
    fcmToken: token,
    platform
  });

  res.status(201).json({
    data: deviceToken
  });
}

export async function deleteDeviceToken(req, res) {
  const { token } = req.validated.body;
  const deviceToken = await unregisterDeviceToken({
    userId: req.auth.user.id,
    fcmToken: token
  });

  res.status(200).json({
    data: {
      id: deviceToken.id,
      deleted: true
    }
  });
}
