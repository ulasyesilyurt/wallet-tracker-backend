import { HttpError } from '../../utils/httpError.js';
import {
  createWalletWithPreferences,
  deleteWalletById,
  findWalletById,
  findWalletAlertSettingsByWalletId,
  findWalletByUserIdAndAddress,
  listWalletsByUserId,
  upsertWalletAlertSettings,
  updateWalletById
} from './wallets.repository.js';
import { applyWalletAlertSettingsDefaults } from '../notifications/notificationRules.service.js';

function toPublicWalletAlertSettings(settings) {
  return {
    walletId: settings.walletId,
    minimumAlertUsd: settings.minimumAlertUsd,
    notificationsEnabled: settings.notificationsEnabled,
    notifyFungibleTransfers: settings.notifyFungibleTransfers,
    notifyIncomingTransfers: settings.notifyIncomingTransfers,
    notifyOutgoingTransfers: settings.notifyOutgoingTransfers,
    notifyNftTransfers: settings.notifyNftTransfers
  };
}

export async function createWallet(payload) {
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

    return updatedExistingWallet;
  }

  try {
    return await createWalletWithPreferences(payload);
  } catch (error) {
    if (error.code === '23503' && error.constraint === 'tracked_wallets_user_id_fkey') {
      throw new HttpError(401, 'AUTH_USER_NOT_FOUND', 'Authenticated user no longer exists.');
    }
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

  return updatedWallet;
}

export async function getWalletAlertSettings(walletId, userId) {
  const wallet = await findWalletById(walletId, userId);

  if (!wallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  const alertSettings = await findWalletAlertSettingsByWalletId(walletId);

  return toPublicWalletAlertSettings(applyWalletAlertSettingsDefaults({
    walletId,
    ...alertSettings
  }));
}

export async function replaceWalletAlertSettings(walletId, userId, payload) {
  const wallet = await findWalletById(walletId, userId);

  if (!wallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  const existingSettings = applyWalletAlertSettingsDefaults({
    walletId,
    ...await findWalletAlertSettingsByWalletId(walletId)
  });
  const updatedSettings = await upsertWalletAlertSettings(walletId, {
    ...payload,
    notifyFungibleTransfers: payload.notifyFungibleTransfers ?? existingSettings.notifyFungibleTransfers,
    notifyIncomingTransfers: payload.notifyIncomingTransfers ?? existingSettings.notifyIncomingTransfers,
    notifyOutgoingTransfers: payload.notifyOutgoingTransfers ?? existingSettings.notifyOutgoingTransfers
  });
  return toPublicWalletAlertSettings(updatedSettings);
}
