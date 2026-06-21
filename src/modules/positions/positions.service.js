import { HttpError } from '../../utils/httpError.js';
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID } from '../chains/chains.config.js';
import { findWalletByIdOnly } from '../wallets/wallets.repository.js';
import { fetchWalletPositions, peekCachedWalletPositions } from './positions.provider.js';

async function findSupportedWallet(walletId) {
  const wallet = await findWalletByIdOnly(walletId);

  if (!wallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  if (wallet.chainId !== ETHEREUM_MAINNET_CHAIN_ID && wallet.chainId !== BASE_MAINNET_CHAIN_ID) {
    throw new HttpError(
      400,
      'UNSUPPORTED_POSITIONS_CHAIN',
      'Wallet positions are currently supported only for ethereum-mainnet and base-mainnet.'
    );
  }

  return wallet;
}

export async function getWalletPositions(walletId) {
  const wallet = await findSupportedWallet(walletId);

  try {
    return await fetchWalletPositions(wallet);
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_ZERION_CHAIN') {
      throw new HttpError(
        400,
        'UNSUPPORTED_POSITIONS_CHAIN',
        `Wallet positions are not currently supported for ${wallet.chainId}.`
      );
    }

    throw error;
  }
}

export async function getCachedWalletPositions(walletId) {
  const wallet = await findSupportedWallet(walletId);
  return peekCachedWalletPositions(wallet);
}
