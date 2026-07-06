import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../config/logger.js';
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID } from '../chains/chains.config.js';
import { findWalletById, findWalletByIdOnly } from '../wallets/wallets.repository.js';
import {
  fetchWalletPositionsForChain,
  peekCachedWalletPositionsForChain
} from './positions.provider.js';

const POSITIONS_CACHE_TTL_MS = 60 * 1000;
const DEGRADED_POSITIONS_CACHE_TTL_MS = 30 * 1000;
const CHAIN_FETCH_DELAY_MS = 150;
const positionsCache = new Map();
const inFlightPositionsPromises = new Map();
const positionsServiceLogger = logger.child({ module: 'positions-service' });

async function findSupportedWallet(walletId, userId = null) {
  const wallet = userId
    ? await findWalletById(walletId, userId)
    : await findWalletByIdOnly(walletId);

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

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getSortablePositionValueUsd(position) {
  return typeof position?.valueUsd === 'number' && Number.isFinite(position.valueUsd)
    ? position.valueUsd
    : null;
}

function sortPositionsByValueUsdDescending(positions) {
  return [...positions].sort((left, right) => {
    const leftUsd = getSortablePositionValueUsd(left);
    const rightUsd = getSortablePositionValueUsd(right);

    if (leftUsd != null && rightUsd != null) {
      return rightUsd - leftUsd;
    }

    if (leftUsd != null) {
      return -1;
    }

    if (rightUsd != null) {
      return 1;
    }

    const leftLabel = `${left?.protocolName ?? ''}:${left?.assetSymbol ?? ''}:${left?.assetName ?? ''}`;
    const rightLabel = `${right?.protocolName ?? ''}:${right?.assetSymbol ?? ''}:${right?.assetName ?? ''}`;
    return leftLabel.localeCompare(rightLabel);
  });
}

function aggregatePositionsResponse({ wallet, enabledChains, chainResponses, partialReasons }) {
  return {
    walletId: wallet.id,
    chainId: wallet.chainId,
    enabledChains,
    positions: sortPositionsByValueUsdDescending(
      chainResponses.flatMap((response) => response.positions ?? [])
    ),
    isPartial: partialReasons.length > 0,
    partialReasons: [...new Set(partialReasons)]
  };
}

export async function getWalletPositions(walletId, { userId = null } = {}) {
  const { wallet, enabledChains, supportedChains } = await findSupportedWallet(walletId, userId);
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
      const partialReasons = [];
      const successfulResponses = [];
      let firstNonUnsupportedError = null;

      positionsServiceLogger.info(
        {
          walletId: wallet.id,
          enabledChains
        },
        'Starting sequential multi-chain positions fetch'
      );

      for (let index = 0; index < supportedChains.length; index += 1) {
        const chainId = supportedChains[index];
        const cachedChainResponse = peekCachedWalletPositionsForChain(wallet, chainId);

        positionsServiceLogger.info(
          {
            walletId: wallet.id,
            enabledChains,
            chainId,
            cacheState: cachedChainResponse ? 'hit' : 'miss'
          },
          cachedChainResponse ? 'Per-chain positions cache hit before fetch' : 'Per-chain positions cache miss before fetch'
        );

        try {
          const chainResponse = await fetchWalletPositionsForChain(wallet, chainId);
          successfulResponses.push(chainResponse);

          positionsServiceLogger.info(
            {
              walletId: wallet.id,
              enabledChains,
              chainId,
              positionsCount: Array.isArray(chainResponse.positions) ? chainResponse.positions.length : 0
            },
            'Fetched positions for enabled chain'
          );

          if (chainResponse.isPartial === true && Array.isArray(chainResponse.partialReasons)) {
            partialReasons.push(...chainResponse.partialReasons);
            positionsServiceLogger.warn(
              {
                walletId: wallet.id,
                enabledChains,
                chainId,
                partialReasons: chainResponse.partialReasons
              },
              'Per-chain positions result is partial'
            );
          }
        } catch (error) {
          if (error?.code === 'UNSUPPORTED_ZERION_CHAIN') {
            const reason = buildPartialReason('UNSUPPORTED_CHAIN', chainId);
            partialReasons.push(reason);
            positionsServiceLogger.warn(
              {
                walletId: wallet.id,
                enabledChains,
                chainId,
                partialReason: reason
              },
              'Per-chain positions are unsupported'
            );
          } else {
            const reason = buildPartialReason('FETCH_FAILED', chainId);
            partialReasons.push(reason);
            if (!firstNonUnsupportedError) {
              firstNonUnsupportedError = error;
            }
            positionsServiceLogger.warn(
              {
                walletId: wallet.id,
                enabledChains,
                chainId,
                partialReason: reason,
                err: error
              },
              'Per-chain positions fetch failed'
            );
          }
        }

        if (index < supportedChains.length - 1) {
          await delay(CHAIN_FETCH_DELAY_MS);
        }
      }

      if (successfulResponses.length === 0) {
        if (partialReasons.some((reason) => reason.startsWith('UNSUPPORTED_CHAIN:'))) {
          throw new HttpError(
            400,
            'UNSUPPORTED_POSITIONS_CHAIN',
            `Wallet positions are not currently supported for ${wallet.chainId}.`
          );
        }

        throw firstNonUnsupportedError ?? new Error('No enabled chain positions could be fetched.');
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
