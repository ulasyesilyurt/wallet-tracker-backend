import { HttpError } from '../../utils/httpError.js';
import { findWalletByIdOnly } from '../wallets/wallets.repository.js';
import { fetchEthereumMainnetPositions, peekCachedEthereumMainnetPositions } from './positions.provider.js';

async function findSupportedWallet(walletId) {
  const wallet = await findWalletByIdOnly(walletId);

  if (!wallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  if (wallet.chainId !== 'ethereum-mainnet') {
    throw new HttpError(
      400,
      'UNSUPPORTED_POSITIONS_CHAIN',
      'Wallet positions are currently supported only for ethereum-mainnet.'
    );
  }

  return wallet;
}

export async function getWalletPositions(walletId) {
  const wallet = await findSupportedWallet(walletId);

  return fetchEthereumMainnetPositions(wallet);
}

export async function getCachedWalletPositions(walletId) {
  const wallet = await findSupportedWallet(walletId);
  return peekCachedEthereumMainnetPositions(wallet);
}
