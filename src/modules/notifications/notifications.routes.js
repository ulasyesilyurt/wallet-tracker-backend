import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/authenticate.js';
import { validate } from '../../middlewares/validate.js';
import { getNotificationHistory } from './notifications.controller.js';

const router = Router();

const notificationHistoryQuerySchema = z.object({
  params: z.object({}).default({}),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0)
  }).default({}),
  body: z.object({}).default({})
});

router.get('/notifications', authenticate, validate(notificationHistoryQuerySchema), getNotificationHistory);

export const notificationsRouter = router;
