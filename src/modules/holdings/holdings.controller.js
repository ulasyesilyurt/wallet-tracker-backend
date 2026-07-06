import { getWalletHoldings } from './holdings.service.js';

export async function getHoldings(req, res) {
  const { walletId } = req.validated.params;
  const userId = req.auth.user.id;
  const holdings = await getWalletHoldings(walletId, { userId });

  res.status(200).json({
    data: holdings
  });
}
