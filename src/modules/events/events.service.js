import { HttpError } from '../../utils/httpError.js';
import { findWalletByIdOnly } from '../wallets/wallets.repository.js';
import { listGlobalActivityByUserId, listWalletEventsByWalletId } from './events.repository.js';

export async function listWalletEvents(walletId) {
  const wallet = await findWalletByIdOnly(walletId);

  if (!wallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  return listWalletEventsByWalletId(walletId);
}

export async function listGlobalActivity(userId, { limit, offset }) {
  return listGlobalActivityByUserId(userId, { limit, offset });
}
