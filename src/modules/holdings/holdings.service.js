import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../config/logger.js';
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID } from '../chains/chains.config.js';
import { findWalletByIdOnly } from '../wallets/wallets.repository.js';
import { fetchWalletHoldingsForChain } from './holdings.provider.js';

const holdingsLogger = logger.child({ module: 'holdings-service' });
const HOLDINGS_CACHE_TTL_MS = 120 * 1000;
const DEGRADED_HOLDINGS_CACHE_TTL_MS = 60 * 1000;
const LAST_KNOWN_GOOD_HOLDINGS_CACHE_TTL_MS = 15 * 60 * 1000;
const holdingsCache = new Map();
const lastKnownGoodHoldingsCache = new Map();
const inFlightHoldingsPromises = new Map();

function buildHoldingsCacheKey(wallet) {
  const enabledChains = Array.isArray(wallet.enabledChains) && wallet.enabledChains.length > 0
    ? [...new Set(wallet.enabledChains)].sort()
    : [wallet.chainId];

  return `${wallet.id}:${enabledChains.join('|')}`;
}

function supportsHoldingsForChain(chainId) {
  return chainId === ETHEREUM_MAINNET_CHAIN_ID || chainId === BASE_MAINNET_CHAIN_ID;
}

function getCachedHoldings(cacheKey) {
  const entry = holdingsCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    holdingsCache.delete(cacheKey);
    return null;
  }

  return entry.value;
}

function getLastKnownGoodHoldings(cacheKey) {
  const entry = lastKnownGoodHoldingsCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    lastKnownGoodHoldingsCache.delete(cacheKey);
    return null;
  }

  return entry.value;
}

function isDegradedHoldingsResult(holdings) {
  return (
    holdings?.isPartial === true ||
    holdings?.tokenBalancesAvailable === false ||
    holdings?.tokenBalancesReason != null ||
    holdings?.totalBalanceUsd == null
  );
}

function isUsableLastKnownGoodHoldingsResult(holdings) {
  const holdingsCount = Array.isArray(holdings?.holdings) ? holdings.holdings.length : 0;
  const hasAnyHoldings = holdingsCount > 0;
  const isExplicitlyEmptyWallet =
    holdingsCount === 0 &&
    holdings?.tokenBalancesAvailable === true &&
    holdings?.totalBalanceUsd === 0 &&
    holdings?.isPartial !== true;

  return hasAnyHoldings || isExplicitlyEmptyWallet;
}

function getWalletEnabledChains(wallet) {
  if (Array.isArray(wallet.enabledChains) && wallet.enabledChains.length > 0) {
    return [...new Set(wallet.enabledChains)];
  }

  return wallet.chainId ? [wallet.chainId] : [];
}

function buildPartialReason(kind, chainId) {
  return `${kind}:${chainId}`;
}

function setCachedHoldings(cacheKey, holdings) {
  const isDegraded = isDegradedHoldingsResult(holdings);
  const ttlMs = isDegraded ? DEGRADED_HOLDINGS_CACHE_TTL_MS : HOLDINGS_CACHE_TTL_MS;

  holdingsCache.set(cacheKey, {
    value: holdings,
    expiresAt: Date.now() + ttlMs
  });

  holdingsLogger.info(
    {
      cacheKey,
      walletId: holdings.walletId,
      chainId: holdings.chainId,
      ttlMs,
      isDegraded
    },
    isDegraded ? 'Cached degraded holdings result' : 'Cached holdings result'
  );
}

function setLastKnownGoodHoldings(cacheKey, holdings) {
  if (!isUsableLastKnownGoodHoldingsResult(holdings)) {
    return;
  }

  lastKnownGoodHoldingsCache.set(cacheKey, {
    value: holdings,
    expiresAt: Date.now() + LAST_KNOWN_GOOD_HOLDINGS_CACHE_TTL_MS
  });

  holdingsLogger.info(
    {
      cacheKey,
      walletId: holdings.walletId,
      chainId: holdings.chainId,
      enabledChains: holdings.enabledChains,
      ttlMs: LAST_KNOWN_GOOD_HOLDINGS_CACHE_TTL_MS,
      isPartial: holdings.isPartial === true,
      holdingsCount: Array.isArray(holdings.holdings) ? holdings.holdings.length : 0,
      totalBalanceUsd: holdings.totalBalanceUsd
    },
    'Stored last-known-good holdings result'
  );
}

function buildStaleHoldingsFallback(holdings, partialReason) {
  const existingPartialReasons = Array.isArray(holdings?.partialReasons) ? holdings.partialReasons : [];
  const tokenBalanceReasons = [holdings?.tokenBalancesReason, partialReason].filter(Boolean);

  return {
    ...holdings,
    holdings: Array.isArray(holdings?.holdings) ? [...holdings.holdings] : [],
    isPartial: true,
    partialReasons: [...new Set([...existingPartialReasons, partialReason])],
    tokenBalancesReason: tokenBalanceReasons.length > 0 ? [...new Set(tokenBalanceReasons)].join(',') : null
  };
}

export async function getWalletHoldings(walletId) {
  const wallet = await findWalletByIdOnly(walletId);

  if (!wallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  const enabledChains = getWalletEnabledChains(wallet);
  const supportedChains = enabledChains.filter((chainId) => supportsHoldingsForChain(chainId));
  const unsupportedChains = enabledChains.filter((chainId) => !supportsHoldingsForChain(chainId));

  if (supportedChains.length === 0) {
    throw new HttpError(
      400,
      'UNSUPPORTED_HOLDINGS_CHAIN',
      'Wallet holdings are currently supported only for ethereum-mainnet and base-mainnet.'
    );
  }

  const cacheKey = buildHoldingsCacheKey(wallet);
  const cachedHoldings = getCachedHoldings(cacheKey);
  const lastKnownGoodHoldings = getLastKnownGoodHoldings(cacheKey);

  if (cachedHoldings) {
    holdingsLogger.info(
      {
        cacheKey,
        walletId: wallet.id,
        chainId: wallet.chainId,
        enabledChains
      },
      'Holdings cache hit'
    );
    return cachedHoldings;
  }

  const existingPromise = inFlightHoldingsPromises.get(cacheKey);

  if (existingPromise) {
    holdingsLogger.info(
      {
        cacheKey,
        walletId: wallet.id,
        chainId: wallet.chainId,
        enabledChains
      },
      'Holdings in-flight request reused'
    );
    return existingPromise;
  }

  holdingsLogger.info(
    {
      cacheKey,
      walletId: wallet.id,
      chainId: wallet.chainId,
      enabledChains
    },
    'Holdings cache miss'
  );

  const holdingsPromise = Promise.resolve()
    .then(async () => {
      const chainResults = await Promise.allSettled(
        supportedChains.map((chainId) => fetchWalletHoldingsForChain(wallet, chainId))
      );
      const partialReasons = unsupportedChains.map((chainId) => buildPartialReason('UNSUPPORTED_CHAIN', chainId));
      const successfulResults = [];

      for (let index = 0; index < chainResults.length; index += 1) {
        const chainId = supportedChains[index];
        const result = chainResults[index];

        if (result.status === 'fulfilled') {
          successfulResults.push(result.value);

          if (result.value.totalBalanceUsd == null && (result.value.holdings?.length ?? 0) > 0) {
            partialReasons.push(buildPartialReason('VALUATION_UNAVAILABLE', chainId));
          }

          if (result.value.tokenBalancesAvailable === false || result.value.tokenBalancesReason) {
            partialReasons.push(
              buildPartialReason(
                result.value.tokenBalancesReason ?? 'TOKEN_BALANCES_UNAVAILABLE',
                chainId
              )
            );
          }

          continue;
        }

        holdingsLogger.warn(
          {
            walletId: wallet.id,
            chainId,
            err: result.reason
          },
          'Failed to fetch holdings for enabled chain; continuing with partial holdings result'
        );
        partialReasons.push(buildPartialReason('FETCH_FAILED', chainId));
      }

      if (successfulResults.length === 0) {
        throw chainResults.find((result) => result.status === 'rejected')?.reason
          ?? new Error('No enabled chain holdings could be fetched.');
      }

      const holdings = successfulResults.flatMap((result) => result.holdings ?? []);
      const hasAnyHoldings = holdings.length > 0;
      const totalBalanceUsdSum = successfulResults.reduce((sum, result) => {
        if (typeof result.totalBalanceUsd !== 'number' || !Number.isFinite(result.totalBalanceUsd)) {
          return sum;
        }

        return sum + result.totalBalanceUsd;
      }, 0);
      const hasAnyValuedHoldings = successfulResults.some(
        (result) => typeof result.totalBalanceUsd === 'number' && Number.isFinite(result.totalBalanceUsd)
      );
      const tokenBalancesAvailable = successfulResults.every(
        (result) => result.tokenBalancesAvailable !== false
      ) && !partialReasons.some((reason) => reason.startsWith('FETCH_FAILED:'));
      const tokenBalanceReasons = [
        ...new Set(
          successfulResults
            .map((result) => result.tokenBalancesReason)
            .filter(Boolean)
            .concat(
              partialReasons.filter((reason) =>
                reason.startsWith('FETCH_FAILED:') || reason.startsWith('UNSUPPORTED_CHAIN:')
              )
            )
        )
      ];

      const aggregatedHoldings = {
        walletId: wallet.id,
        chainId: wallet.chainId,
        enabledChains,
        totalBalanceUsd: !hasAnyHoldings
          ? 0
          : hasAnyValuedHoldings
            ? Number(totalBalanceUsdSum.toFixed(2))
            : null,
        holdings,
        tokenBalancesAvailable,
        tokenBalancesReason: tokenBalanceReasons.length > 0 ? tokenBalanceReasons.join(',') : null,
        isPartial: partialReasons.length > 0,
        partialReasons
      };

      holdingsLogger.info(
        {
          walletId: wallet.id,
          chainId: wallet.chainId,
          enabledChains,
          successfulChains: successfulResults.map((result) => result.chainId),
          holdingsCount: holdings.length,
          totalBalanceUsd: aggregatedHoldings.totalBalanceUsd,
          partialReasons
        },
        'Aggregated wallet holdings across enabled chains'
      );

      return aggregatedHoldings;
    })
    .then((holdings) => {
      setCachedHoldings(cacheKey, holdings);
      setLastKnownGoodHoldings(cacheKey, holdings);
      return holdings;
    })
    .catch((error) => {
      if (!lastKnownGoodHoldings) {
        throw error;
      }

      const partialReason =
        error?.code === 'TIMEOUT'
          ? 'FETCH_FAILED_STALE_CACHE_TIMEOUT'
          : 'FETCH_FAILED_STALE_CACHE';
      const staleFallback = buildStaleHoldingsFallback(lastKnownGoodHoldings, partialReason);

      holdingsLogger.warn(
        {
          cacheKey,
          walletId: wallet.id,
          chainId: wallet.chainId,
          enabledChains,
          partialReason,
          err: error
        },
        'Serving stale last-known-good holdings fallback after fresh holdings fetch failed'
      );

      setCachedHoldings(cacheKey, staleFallback);
      return staleFallback;
    })
    .finally(() => {
      inFlightHoldingsPromises.delete(cacheKey);
    });

  inFlightHoldingsPromises.set(cacheKey, holdingsPromise);
  return holdingsPromise;
}
