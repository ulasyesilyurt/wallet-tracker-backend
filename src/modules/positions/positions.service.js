import { HttpError } from '../../utils/httpError.js';
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID } from '../chains/chains.config.js';
import { findWalletByIdOnly } from '../wallets/wallets.repository.js';
import {
  fetchWalletPositionsForChain,
  peekCachedWalletPositionsForChain
} from './positions.provider.js';

const POSITIONS_CACHE_TTL_MS = 60 * 1000;
const DEGRADED_POSITIONS_CACHE_TTL_MS = 5 * 1000;
const positionsCache = new Map();
const inFlightPositionsPromises = new Map();

async function findSupportedWallet(walletId) {
  const wallet = await findWalletByIdOnly(walletId);

  if (!wallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  const enabledChains = Array.isArray(wallet.enabledChains) && wallet.enabledChains.length > 0
    ? [...new Set(wallet.enabledChains)]
    : [wallet.chainId];
  const supportedChains = enabledChains.filter(
    (chainId) => chainId === ETHEREUM_MAINNET_CHAIN_ID || chainId === BASE_MAINNET_CHAIN_ID
  );

  if (supportedChains.length === 0) {
    throw new HttpError(
      400,
      'UNSUPPORTED_POSITIONS_CHAIN',
      'Wallet positions are currently supported only for ethereum-mainnet and base-mainnet.'
    );
  }

  return {
    wallet,
    enabledChains,
    supportedChains
  };
}

function buildPositionsCacheKey(wallet) {
  const enabledChains = Array.isArray(wallet.enabledChains) && wallet.enabledChains.length > 0
    ? [...new Set(wallet.enabledChains)].sort()
    : [wallet.chainId];

  return `${wallet.id}:${enabledChains.join('|')}`;
}

function getCachedPositions(cacheKey) {
  const entry = positionsCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    positionsCache.delete(cacheKey);
    return null;
  }

  return entry.value;
}

function setCachedPositions(cacheKey, value) {
  const isDegraded = value?.isPartial === true;
  positionsCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + (isDegraded ? DEGRADED_POSITIONS_CACHE_TTL_MS : POSITIONS_CACHE_TTL_MS)
  });
}

function buildPartialReason(kind, chainId) {
  return `${kind}:${chainId}`;
}

function aggregatePositionsResponse({ wallet, enabledChains, chainResponses, partialReasons }) {
  return {
    walletId: wallet.id,
    chainId: wallet.chainId,
    enabledChains,
    positions: chainResponses.flatMap((response) => response.positions ?? []),
    isPartial: partialReasons.length > 0,
    partialReasons: [...new Set(partialReasons)]
  };
}

export async function getWalletPositions(walletId) {
  const { wallet, enabledChains, supportedChains } = await findSupportedWallet(walletId);
  const cacheKey = buildPositionsCacheKey(wallet);
  const cachedPositions = getCachedPositions(cacheKey);

  if (cachedPositions) {
    return cachedPositions;
  }

  const existingPromise = inFlightPositionsPromises.get(cacheKey);

  if (existingPromise) {
    return existingPromise;
  }

  const positionsPromise = Promise.resolve()
    .then(async () => {
      const chainResults = await Promise.allSettled(
        supportedChains.map((chainId) => fetchWalletPositionsForChain(wallet, chainId))
      );
      const partialReasons = [];
      const successfulResponses = [];

      for (let index = 0; index < chainResults.length; index += 1) {
        const chainId = supportedChains[index];
        const result = chainResults[index];

        if (result.status === 'fulfilled') {
          successfulResponses.push(result.value);

          if (result.value.isPartial === true && Array.isArray(result.value.partialReasons)) {
            partialReasons.push(...result.value.partialReasons);
          }
          continue;
        }

        if (result.reason?.code === 'UNSUPPORTED_ZERION_CHAIN') {
          partialReasons.push(buildPartialReason('UNSUPPORTED_CHAIN', chainId));
          continue;
        }

        partialReasons.push(buildPartialReason('FETCH_FAILED', chainId));
      }

      if (successfulResponses.length === 0) {
        if (chainResults.some((result) => result.status === 'rejected' && result.reason?.code === 'UNSUPPORTED_ZERION_CHAIN')) {
          throw new HttpError(
            400,
            'UNSUPPORTED_POSITIONS_CHAIN',
            `Wallet positions are not currently supported for ${wallet.chainId}.`
          );
        }

        throw chainResults.find((result) => result.status === 'rejected')?.reason
          ?? new Error('No enabled chain positions could be fetched.');
      }

      const aggregatedResponse = aggregatePositionsResponse({
        wallet,
        enabledChains,
        chainResponses: successfulResponses,
        partialReasons
      });

      setCachedPositions(cacheKey, aggregatedResponse);
      return aggregatedResponse;
    })
    .finally(() => {
      inFlightPositionsPromises.delete(cacheKey);
    });

  inFlightPositionsPromises.set(cacheKey, positionsPromise);
  return positionsPromise;
}

export async function getCachedWalletPositions(walletId) {
  const { wallet, enabledChains, supportedChains } = await findSupportedWallet(walletId);
  const cacheKey = buildPositionsCacheKey(wallet);
  const cachedPositions = getCachedPositions(cacheKey);

  if (cachedPositions) {
    return cachedPositions;
  }

  const partialReasons = [];
  const cachedChainResponses = [];

  for (const chainId of supportedChains) {
    const cachedChainResponse = peekCachedWalletPositionsForChain(wallet, chainId);

    if (cachedChainResponse) {
      cachedChainResponses.push(cachedChainResponse);
    } else {
      partialReasons.push(buildPartialReason('CACHE_MISS', chainId));
    }
  }

  if (cachedChainResponses.length === 0) {
    return null;
  }

  const aggregatedResponse = aggregatePositionsResponse({
    wallet,
    enabledChains,
    chainResponses: cachedChainResponses,
    partialReasons
  });

  setCachedPositions(cacheKey, aggregatedResponse);
  return aggregatedResponse;
}
