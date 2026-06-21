import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { postAlchemyWebhook } from './alchemy.controller.js';
import { verifyAlchemyWebhookSignature } from './alchemySignature.middleware.js';
import { alchemyWebhookSchema } from './alchemy.schemas.js';

const router = Router();

router.post(
  '/webhooks/alchemy',
  verifyAlchemyWebhookSignature,
  validate(alchemyWebhookSchema),
  postAlchemyWebhook
);

export const alchemyWebhooksRouter = router;
