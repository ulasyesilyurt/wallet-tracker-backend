import { getWalletHoldings } from './holdings.service.js';

export async function getHoldings(req, res) {
  const { walletId } = req.validated.params;
  const holdings = await getWalletHoldings(walletId);

  res.status(200).json({
    data: holdings
  });
}
