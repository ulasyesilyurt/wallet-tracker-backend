import { getAggregatedPortfolioPerformance, getWalletPerformance } from './performance.service.js';

export async function getWalletPerformanceController(req, res) {
  const { walletId } = req.validated.params;
  const userId = req.auth.user.id;
  const performance = await getWalletPerformance(walletId, userId);

  res.status(200).json({
    data: performance
  });
}

export async function getPortfolioPerformanceController(req, res) {
  const userId = req.auth.user.id;
  const performance = await getAggregatedPortfolioPerformance(userId);

  res.status(200).json({
    data: performance
  });
}
