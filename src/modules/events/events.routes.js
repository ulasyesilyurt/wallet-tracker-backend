import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/authenticate.js';
import { validate } from '../../middlewares/validate.js';
import { getGlobalActivity, getWalletEvents } from './events.controller.js';

const router = Router();

const walletEventsParamsSchema = z.object({
  params: z.object({
    walletId: z.string().uuid()
  }),
  query: z.object({}).default({}),
  body: z.object({}).default({})
});

const globalActivityQuerySchema = z.object({
  params: z.object({}).default({}),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0)
  }).default({}),
  body: z.object({}).default({})
});

router.get('/activity', authenticate, validate(globalActivityQuerySchema), getGlobalActivity);
router.get('/wallets/:walletId/events', validate(walletEventsParamsSchema), getWalletEvents);

export const eventsRouter = router;
