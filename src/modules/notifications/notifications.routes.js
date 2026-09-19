import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/authenticate.js';
import { validate } from '../../middlewares/validate.js';
import {
  getNotificationHistory,
  getUnreadCount,
  patchAllNotificationsRead,
  patchNotificationRead
} from './notifications.controller.js';

const router = Router();

const notificationHistoryQuerySchema = z.object({
  params: z.object({}).default({}),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0)
  }).default({}),
  body: z.object({}).default({})
});

const emptyRequestSchema = z.object({
  params: z.object({}).default({}),
  query: z.object({}).default({}),
  body: z.object({}).default({})
});

const notificationReadSchema = z.object({
  params: z.object({ notificationId: z.string().uuid() }),
  query: z.object({}).default({}),
  body: z.object({}).default({})
});

router.get('/notifications', authenticate, validate(notificationHistoryQuerySchema), getNotificationHistory);
router.get('/notifications/unread-count', authenticate, validate(emptyRequestSchema), getUnreadCount);
router.patch('/notifications/read-all', authenticate, validate(emptyRequestSchema), patchAllNotificationsRead);
router.patch('/notifications/:notificationId/read', authenticate, validate(notificationReadSchema), patchNotificationRead);

export const notificationsRouter = router;
