import { getWalletPositions } from './positions.service.js';

export async function getPositions(req, res) {
  const { walletId } = req.validated.params;
  const userId = req.auth.user.id;
  const positions = await getWalletPositions(walletId, { userId });

  res.status(200).json({
    data: positions
  });
}
