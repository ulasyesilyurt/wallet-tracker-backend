import { listGlobalActivity, listWalletEvents } from './events.service.js';

export async function getWalletEvents(req, res) {
  const { walletId } = req.validated.params;
  const userId = req.auth.user.id;
  const events = await listWalletEvents(walletId, userId);

  res.status(200).json({
    data: events
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
