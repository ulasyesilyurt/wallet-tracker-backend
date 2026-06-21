import { query } from '../../db/query.js';
import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../config/logger.js';
import {
  createWalletWithPreferences,
  deleteWalletById,
  findWalletById,
  findWalletByUserIdAndAddress,
  listWalletsByUserId,
  updateWalletById
} from './wallets.repository.js';
import {
  syncAlchemyWebhookAddressOnWalletCreate,
  syncAlchemyWebhookAddressOnWalletDelete,
  syncAlchemyWebhookAddressOnWalletUpdate
} from '../webhooks/alchemyAddressSync.service.js';

const walletsServiceLogger = logger.child({ module: 'wallets-service' });

export async function ensureUserExists(userId) {
  const result = await query(
    `
      INSERT INTO app_users (id)
      VALUES ($1)
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `,
    [userId]
  );

  if (result.rowCount > 0) {
    return { id: userId, created: true };
  }

  return { id: userId, created: false };
}

export async function createWallet(payload) {
  await ensureUserExists(payload.userId);

  const existingWallet = await findWalletByUserIdAndAddress(payload.userId, payload.address);

  if (existingWallet) {
    const updatedExistingWallet = await updateWalletById(existingWallet.id, payload.userId, {
      address: payload.address,
      label: payload.label,
      trackTypes: payload.trackTypes,
      enabledChains: payload.enabledChains
    });

    if (!updatedExistingWallet) {
      throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
    }

    try {
      await syncAlchemyWebhookAddressOnWalletUpdate(existingWallet, updatedExistingWallet);
    } catch (error) {
      walletsServiceLogger.error(
        {
          err: error,
          walletId: updatedExistingWallet.id,
          previousAddress: existingWallet.address,
          nextAddress: updatedExistingWallet.address,
          previousEnabledChains: existingWallet.enabledChains,
          nextEnabledChains: updatedExistingWallet.enabledChains
        },
        'Unexpected Alchemy webhook sync error after address-centric wallet merge'
      );
    }

    return updatedExistingWallet;
  }

  try {
    const wallet = await createWalletWithPreferences(payload);

    try {
      await syncAlchemyWebhookAddressOnWalletCreate(wallet);
    } catch (error) {
      walletsServiceLogger.error(
        { err: error, walletId: wallet.id, chainId: wallet.chainId, address: wallet.address },
        'Unexpected Alchemy webhook sync error after wallet create'
      );
    }

    return wallet;
  } catch (error) {
    if (error.code === '23505') {
      throw new HttpError(409, 'WALLET_ALREADY_TRACKED', 'This wallet is already being tracked for the user.');
    }

    throw error;
  }
}

export async function listWallets(userId) {
  return listWalletsByUserId(userId);
}

export async function removeWallet(walletId, userId) {
  const existingWallet = await findWalletById(walletId, userId);

  if (!existingWallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  const deletedWallet = await deleteWalletById(walletId, userId);

  if (!deletedWallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  const persistedWallet = await findWalletById(walletId, userId);

  if (persistedWallet) {
    throw new HttpError(500, 'WALLET_DELETE_VERIFICATION_FAILED', 'Wallet deletion could not be verified.', {
      expose: false
    });
  }

  try {
    await syncAlchemyWebhookAddressOnWalletDelete(existingWallet);
  } catch (error) {
    walletsServiceLogger.error(
      { err: error, walletId: existingWallet.id, enabledChains: existingWallet.enabledChains, address: existingWallet.address },
      'Unexpected Alchemy webhook sync error after wallet delete'
    );
  }

  return deletedWallet;
}

export async function updateWallet(walletId, userId, payload) {
  const existingWallet = await findWalletById(walletId, userId);

  if (!existingWallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  const updatedWallet = await updateWalletById(walletId, userId, payload);

  if (!updatedWallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  if (payload.address !== undefined || payload.enabledChains !== undefined) {
    try {
      await syncAlchemyWebhookAddressOnWalletUpdate(existingWallet, updatedWallet);
    } catch (error) {
      walletsServiceLogger.error(
        {
          err: error,
          walletId: updatedWallet.id,
          previousAddress: existingWallet.address,
          nextAddress: updatedWallet.address,
          previousEnabledChains: existingWallet.enabledChains,
          nextEnabledChains: updatedWallet.enabledChains
        },
        'Unexpected Alchemy webhook sync error after wallet update'
      );
    }
  }

  return updatedWallet;
}
