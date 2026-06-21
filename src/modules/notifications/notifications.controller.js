import { listNotificationHistory } from './notifications.service.js';

export async function getNotificationHistory(req, res) {
  const userId = req.auth.user.id;
  const { limit, offset } = req.validated.query;
  const result = await listNotificationHistory(userId, { limit, offset });

  res.status(200).json({
    data: result
  });
}
