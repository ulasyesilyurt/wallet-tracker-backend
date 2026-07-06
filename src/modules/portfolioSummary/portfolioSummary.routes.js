import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { validate } from '../../middlewares/validate.js';
import { getPortfolioSummary } from './portfolioSummary.controller.js';
import { walletPortfolioSummaryParamsSchema } from './portfolioSummary.schemas.js';

const router = Router();

router.get(
  '/wallets/:walletId/portfolio-summary',
  authenticate,
  validate(walletPortfolioSummaryParamsSchema),
  getPortfolioSummary
);

export const portfolioSummaryRouter = router;
