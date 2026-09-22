import { listGlobalActivity, listWalletEvents } from './events.service.js';

export async function getWalletEvents(req, res) {
  const { walletId } = req.validated.params;
  const { groupTransactions, limit, offset } = req.validated.query;
  const userId = req.auth.user.id;
  const result = await listWalletEvents(walletId, userId, { groupTransactions, limit, offset });

  res.status(200).json({
    data: result.items,
    pagination: result.pagination
  });
}

export async function getGlobalActivity(req, res) {
  const userId = req.auth.user.id;
  const { limit, offset } = req.validated.query;
  const result = await listGlobalActivity(userId, { limit, offset });

  res.status(200).json({
    data: result
  });
}
