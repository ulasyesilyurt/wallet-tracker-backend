import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { getPortfolioSummary } from './portfolioSummary.controller.js';
import { walletPortfolioSummaryParamsSchema } from './portfolioSummary.schemas.js';

const router = Router();

router.get(
  '/wallets/:walletId/portfolio-summary',
  validate(walletPortfolioSummaryParamsSchema),
  getPortfolioSummary
);

export const portfolioSummaryRouter = router;
