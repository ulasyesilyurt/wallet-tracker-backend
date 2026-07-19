import { HttpError } from '../../utils/httpError.js';
import { findWalletById, findWalletByIdOnly } from '../wallets/wallets.repository.js';
import { groupWalletEventsByTransaction } from './eventActivityGrouper.js';
import { listGlobalActivityByUserId, listWalletEventsByWalletId } from './events.repository.js';

export async function listWalletEvents(
  walletId,
  userId = null,
  { groupTransactions = false } = {}
) {
  const wallet = userId
    ? await findWalletById(walletId, userId)
    : await findWalletByIdOnly(walletId);

  if (!wallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  const events = await listWalletEventsByWalletId(walletId);

  if (!groupTransactions) {
    return events;
  }

  return groupWalletEventsByTransaction(events, wallet);
}

export async function listGlobalActivity(userId, { limit, offset }) {
  return listGlobalActivityByUserId(userId, { limit, offset });
}
