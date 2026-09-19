import {
  getUnreadNotificationCount,
  listNotificationHistory,
  markAllNotificationsRead,
  markNotificationRead
} from './notifications.service.js';

export async function getNotificationHistory(req, res) {
  const userId = req.auth.user.id;
  const { limit, offset } = req.validated.query;
  const result = await listNotificationHistory(userId, { limit, offset });

  res.status(200).json({
    data: result
  });
}

export async function getUnreadCount(req, res) {
  const unreadCount = await getUnreadNotificationCount(req.auth.user.id);

  res.status(200).json({ data: { unreadCount } });
}

export async function patchNotificationRead(req, res) {
  const notification = await markNotificationRead(
    req.validated.params.notificationId,
    req.auth.user.id
  );

  res.status(200).json({ data: notification });
}

export async function patchAllNotificationsRead(req, res) {
  const updatedCount = await markAllNotificationsRead(req.auth.user.id);

  res.status(200).json({ data: { updatedCount } });
}
