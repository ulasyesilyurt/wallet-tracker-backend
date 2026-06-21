import { getWalletPositions } from './positions.service.js';

export async function getPositions(req, res) {
  const { walletId } = req.validated.params;
  const positions = await getWalletPositions(walletId);

  res.status(200).json({
    data: positions
  });
}
