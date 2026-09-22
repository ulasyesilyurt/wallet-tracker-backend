import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { postAlchemyWebhook } from './alchemy.controller.js';
import { verifyAlchemyWebhookSignature } from './alchemySignature.middleware.js';
import { alchemyWebhookSchema } from './alchemy.schemas.js';
import { logger } from '../../config/logger.js';
import { safeErrorDetails } from '../../utils/safeError.js';
import { resolveChainIdFromAlchemyWebhookNetwork } from '../chains/chains.config.js';
import {
  recordWebhookFailure,
  recordWebhookRejection
} from '../operations/operationalState.js';

const router = Router();
const webhookRouteLogger = logger.child({ module: 'alchemy-webhook-route' });

router.post(
  '/webhooks/alchemy',
  verifyAlchemyWebhookSignature,
  validate(alchemyWebhookSchema),
  postAlchemyWebhook
);

router.use((error, req, res, next) => {
  const statusCode = error?.statusCode ?? (error?.name === 'ZodError' ? 400 : 500);
  const context = {
    provider: 'alchemy',
    operation: 'webhook_ingestion',
    chainId: resolveChainIdFromAlchemyWebhookNetwork(req.body?.event?.network) ?? null,
    statusCode,
    ...safeErrorDetails(error)
  };

  if (statusCode < 500) {
    recordWebhookRejection(error);
    webhookRouteLogger.warn(context, 'Alchemy webhook rejected');
  } else {
    recordWebhookFailure(error);
    webhookRouteLogger.error(context, 'Alchemy webhook processing failed');
  }

  next(error);
});

export const alchemyWebhooksRouter = router;
