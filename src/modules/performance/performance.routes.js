import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { validate } from '../../middlewares/validate.js';
import {
  getPortfolioPerformanceController,
  getWalletPerformanceController
} from './performance.controller.js';
import {
  portfolioPerformanceSchema,
  walletPerformanceParamsSchema
} from './performance.schemas.js';

const router = Router();

router.get(
  '/wallets/:walletId/performance',
  authenticate,
  validate(walletPerformanceParamsSchema),
  getWalletPerformanceController
);

router.get(
  '/portfolio/performance',
  authenticate,
  validate(portfolioPerformanceSchema),
  getPortfolioPerformanceController
);

export const performanceRouter = router;
