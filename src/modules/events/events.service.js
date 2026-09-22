import { HttpError } from '../../utils/httpError.js';
import { findWalletById, findWalletByIdOnly } from '../wallets/wallets.repository.js';
import { groupWalletEventsByTransaction } from './eventActivityGrouper.js';
import {
  findIncompleteWalletEventGroupKeys,
  listGlobalActivityByUserId,
  listWalletEventsByWalletId
} from './events.repository.js';

export async function listWalletEvents(
  walletId,
  userId = null,
  { groupTransactions = false, limit = 50, offset = 0 } = {}
) {
  const wallet = userId
    ? await findWalletById(walletId, userId)
    : await findWalletByIdOnly(walletId);

  if (!wallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  const result = await listWalletEventsByWalletId(walletId, { limit, offset });

  if (!groupTransactions) {
    return result;
  }

  const incompleteGroupKeys = result.items.some((event) => event.assetType === 'nft')
    ? await findIncompleteWalletEventGroupKeys(walletId, result.items)
    : new Set();
  return {
    ...result,
    items: groupWalletEventsByTransaction(result.items, wallet, { incompleteGroupKeys })
  };
}

export async function listGlobalActivity(userId, { limit, offset }) {
  return listGlobalActivityByUserId(userId, { limit, offset });
}
