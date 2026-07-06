import { getWalletPortfolioSummary } from './portfolioSummary.service.js';

export async function getPortfolioSummary(req, res) {
  const { walletId } = req.validated.params;
  const includePositions = req.validated.query?.includePositions ?? true;
  const userId = req.auth.user.id;
  const summary = await getWalletPortfolioSummary(walletId, { includePositions, userId });

  res.status(200).json({
    data: summary
  });
}
