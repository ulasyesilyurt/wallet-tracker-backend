import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes.js';
import { deviceTokensRouter } from '../modules/deviceTokens/deviceTokens.routes.js';
import { eventsRouter } from '../modules/events/events.routes.js';
import { holdingsRouter } from '../modules/holdings/holdings.routes.js';
import { notificationsRouter } from '../modules/notifications/notifications.routes.js';
import { performanceRouter } from '../modules/performance/performance.routes.js';
import { portfolioSummaryRouter } from '../modules/portfolioSummary/portfolioSummary.routes.js';
import { positionsRouter } from '../modules/positions/positions.routes.js';
import { alchemyWebhooksRouter } from '../modules/webhooks/alchemy.routes.js';
import { walletsRouter } from '../modules/wallets/wallets.routes.js';

const router = Router();

router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

router.use(authRouter);
router.use(walletsRouter);
router.use(deviceTokensRouter);
router.use(eventsRouter);
router.use(holdingsRouter);
router.use(notificationsRouter);
router.use(performanceRouter);
router.use(portfolioSummaryRouter);
router.use(positionsRouter);
router.use(alchemyWebhooksRouter);

export const apiRouter = router;
