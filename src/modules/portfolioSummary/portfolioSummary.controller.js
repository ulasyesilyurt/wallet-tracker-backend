import { getWalletPortfolioSummary } from './portfolioSummary.service.js';

export async function getPortfolioSummary(req, res) {
  const { walletId } = req.validated.params;
  const includePositions = req.validated.query?.includePositions ?? true;
  const summary = await getWalletPortfolioSummary(walletId, { includePositions });

  res.status(200).json({
    data: summary
  });
}
