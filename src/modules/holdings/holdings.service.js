import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../config/logger.js';
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID } from '../chains/chains.config.js';
import { findWalletByIdOnly } from '../wallets/wallets.repository.js';
import { fetchWalletHoldingsForChain } from './holdings.provider.js';
import { findWalletChainHoldingsCaches, upsertWalletChainHoldingsCache } from './holdings.repository.js';

const holdingsLogger = logger.child({ module: 'holdings-service' });
const HOLDINGS_CACHE_TTL_MS = 120 * 1000;
const AGGREGATED_DEGRADED_HOLDINGS_CACHE_TTL_MS = 15 * 1000;
const PER_CHAIN_DEGRADED_HOLDINGS_CACHE_TTL_MS = 60 * 1000;
const LAST_KNOWN_GOOD_HOLDINGS_CACHE_TTL_MS = 15 * 60 * 1000;
const HOLDINGS_CHAIN_TIMEOUT_MS = 8 * 1000;
const PERSISTED_HOLDINGS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const holdingsCache = new Map();
const lastKnownGoodHoldingsCache = new Map();
const inFlightHoldingsPromises = new Map();
const chainHoldingsCache = new Map();
const chainLastKnownGoodHoldingsCache = new Map();
const inFlightChainHoldingsPromises = new Map();
const CHAIN_LEVEL_TOKEN_BALANCE_PARTIAL_REASON_PREFIXES = [
  'FETCH_TIMEOUT:',
  'FETCH_FAILED:',
  'STALE_HOLDINGS_CACHE:',
  'PERSISTED_HOLDINGS_CACHE:',
  'UNSUPPORTED_CHAIN:'
];

function buildHoldingsCacheKey(wallet, { allowPersistedFallback = true, requireLive = false } = {}) {
  const enabledChains = Array.isArray(wallet.enabledChains) && wallet.enabledChains.length > 0
    ? [...new Set(wallet.enabledChains)].sort()
    : [wallet.chainId];

  return `${wallet.id}:${enabledChains.join('|')}:persisted=${allowPersistedFallback ? '1' : '0'}:live=${requireLive ? '1' : '0'}`;
}

function buildChainHoldingsCacheKey(wallet, chainId) {
  return `${wallet.id}:${wallet.address.toLowerCase()}:${chainId}`;
}

function supportsHoldingsForChain(chainId) {
  return chainId === ETHEREUM_MAINNET_CHAIN_ID || chainId === BASE_MAINNET_CHAIN_ID;
}

function getCachedHoldings(cacheKey, { requireLive = false } = {}) {
  const entry = holdingsCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    holdingsCache.delete(cacheKey);
    return null;
  }

  if (requireLive && entry.source === 'persisted') {
    return null;
  }

  return entry.value;
}

function getCachedChainHoldings(cacheKey, { requireLive = false } = {}) {
  const entry = chainHoldingsCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    chainHoldingsCache.delete(cacheKey);
    return null;
  }

  if (requireLive && entry.source === 'persisted') {
    return null;
  }

  return entry.value;
}

function getLastKnownGoodHoldings(cacheKey, { requireLive = false } = {}) {
  const entry = lastKnownGoodHoldingsCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    lastKnownGoodHoldingsCache.delete(cacheKey);
    return null;
  }

  if (requireLive && entry.source === 'persisted') {
    return null;
  }

  return entry.value;
}

function getLastKnownGoodChainHoldings(cacheKey, { requireLive = false } = {}) {
  const entry = chainLastKnownGoodHoldingsCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    chainLastKnownGoodHoldingsCache.delete(cacheKey);
    return null;
  }

  if (requireLive && entry.source === 'persisted') {
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

function setCachedHoldings(cacheKey, holdings, { source = 'live' } = {}) {
  const isDegraded = isDegradedHoldingsResult(holdings);
  const ttlMs = isDegraded ? AGGREGATED_DEGRADED_HOLDINGS_CACHE_TTL_MS : HOLDINGS_CACHE_TTL_MS;

  holdingsCache.set(cacheKey, {
    value: holdings,
    expiresAt: Date.now() + ttlMs,
    source
  });

  holdingsLogger.info(
    {
      cacheKey,
      walletId: holdings.walletId,
      chainId: holdings.chainId,
      ttlMs,
      isDegraded,
      source
    },
    isDegraded ? 'Cached degraded holdings result' : 'Cached holdings result'
  );
}

function setCachedChainHoldings(cacheKey, holdings, { walletId, chainId, enabledChains, source = 'live' }) {
  const isDegraded = isDegradedHoldingsResult(holdings);
  const ttlMs = isDegraded ? PER_CHAIN_DEGRADED_HOLDINGS_CACHE_TTL_MS : HOLDINGS_CACHE_TTL_MS;

  chainHoldingsCache.set(cacheKey, {
    value: holdings,
    expiresAt: Date.now() + ttlMs,
    source
  });

  holdingsLogger.info(
    {
      cacheKey,
      walletId,
      chainId,
      enabledChains,
      ttlMs,
      isDegraded,
      source
    },
    isDegraded ? 'Cached degraded per-chain holdings result' : 'Cached per-chain holdings result'
  );
}

function setLastKnownGoodHoldings(cacheKey, holdings, { source = 'live' } = {}) {
  if (!isUsableLastKnownGoodHoldingsResult(holdings)) {
    return;
  }

  lastKnownGoodHoldingsCache.set(cacheKey, {
    value: holdings,
    expiresAt: Date.now() + LAST_KNOWN_GOOD_HOLDINGS_CACHE_TTL_MS,
    source
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
      totalBalanceUsd: holdings.totalBalanceUsd,
      source
    },
    'Stored last-known-good holdings result'
  );
}

function setLastKnownGoodChainHoldings(cacheKey, holdings, { walletId, chainId, enabledChains, source = 'live' }) {
  if (!isUsableLastKnownGoodHoldingsResult(holdings)) {
    return;
  }

  chainLastKnownGoodHoldingsCache.set(cacheKey, {
    value: holdings,
    expiresAt: Date.now() + LAST_KNOWN_GOOD_HOLDINGS_CACHE_TTL_MS,
    source
  });

  holdingsLogger.info(
    {
      cacheKey,
      walletId,
      chainId,
      enabledChains,
      ttlMs: LAST_KNOWN_GOOD_HOLDINGS_CACHE_TTL_MS,
      isPartial: holdings.isPartial === true,
      holdingsCount: Array.isArray(holdings.holdings) ? holdings.holdings.length : 0,
      totalBalanceUsd: holdings.totalBalanceUsd,
      source
    },
    'Stored last-known-good per-chain holdings result'
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

function buildStaleHoldingsFallbackWithReasons(holdings, additionalPartialReasons) {
  const existingPartialReasons = Array.isArray(holdings?.partialReasons) ? holdings.partialReasons : [];
  const nextPartialReasons = [
    ...new Set([
      ...existingPartialReasons,
      ...additionalPartialReasons.filter(Boolean)
    ])
  ];
  const tokenBalanceReasons = [
    holdings?.tokenBalancesReason,
    ...additionalPartialReasons
  ].filter(Boolean);

  return {
    ...holdings,
    holdings: Array.isArray(holdings?.holdings) ? [...holdings.holdings] : [],
    isPartial: true,
    partialReasons: nextPartialReasons,
    tokenBalancesAvailable: false,
    tokenBalancesReason: tokenBalanceReasons.length > 0 ? [...new Set(tokenBalanceReasons)].join(',') : null
  };
}

function buildEmptyPartialHoldingsResponse(wallet, enabledChains, partialReasons) {
  const normalizedPartialReasons = [...new Set(partialReasons.filter(Boolean))];
  const tokenBalancesReason = normalizedPartialReasons.length > 0
    ? normalizedPartialReasons.join(',')
    : 'ALL_CHAINS_UNAVAILABLE';

  return {
    walletId: wallet.id,
    chainId: wallet.chainId,
    enabledChains,
    totalBalanceUsd: null,
    holdings: [],
    tokenBalancesAvailable: false,
    tokenBalancesReason,
    isPartial: true,
    partialReasons: normalizedPartialReasons.length > 0
      ? normalizedPartialReasons
      : ['ALL_CHAINS_UNAVAILABLE']
  };
}

function createChainTimeoutError(chainId) {
  const error = new Error(`Holdings fetch timed out for ${chainId}`);
  error.code = 'TIMEOUT';
  error.chainId = chainId;
  error.timeoutMs = HOLDINGS_CHAIN_TIMEOUT_MS;
  return error;
}

function withTimeout(promise, chainId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(createChainTimeoutError(chainId));
    }, HOLDINGS_CHAIN_TIMEOUT_MS);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function buildChainFetchContext(wallet, chainId, enabledChains, cacheKey) {
  return {
    walletId: wallet.id,
    chainId,
    enabledChains,
    cacheKey
  };
}

function buildChainLevelTokenBalancesReason(partialReasons, successfulResults) {
  const chainLevelReasons = partialReasons.filter((reason) =>
    CHAIN_LEVEL_TOKEN_BALANCE_PARTIAL_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix))
  );
  const tokenBalanceReasons = [
    ...new Set(
      successfulResults
        .map((result) => result.tokenBalancesReason)
        .filter(Boolean)
        .concat(chainLevelReasons)
    )
  ];

  return tokenBalanceReasons.length > 0 ? tokenBalanceReasons.join(',') : null;
}

function isPersistableChainHoldingsResult(holdings) {
  return isUsableLastKnownGoodHoldingsResult(holdings);
}

function buildPersistedPartialReasons(chainIds) {
  return chainIds.map((chainId) => buildPartialReason('PERSISTED_HOLDINGS_CACHE', chainId));
}

function aggregateHoldingsResults(wallet, enabledChains, successfulResults, partialReasons) {
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
  ) && !partialReasons.some((reason) =>
    CHAIN_LEVEL_TOKEN_BALANCE_PARTIAL_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix))
  );
  const tokenBalanceReason = buildChainLevelTokenBalancesReason(partialReasons, successfulResults);

  return {
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
    tokenBalancesReason: tokenBalanceReason,
    isPartial: partialReasons.length > 0,
    partialReasons
  };
}

async function persistChainHoldingsResult(wallet, chainId, holdings) {
  if (!isPersistableChainHoldingsResult(holdings)) {
    return;
  }

  try {
    const persistedRow = await upsertWalletChainHoldingsCache({
      walletId: wallet.id,
      walletAddress: wallet.address,
      chainId,
      payload: holdings,
      holdingsCount: Array.isArray(holdings.holdings) ? holdings.holdings.length : 0,
      totalBalanceUsd: holdings.totalBalanceUsd,
      tokenBalancesAvailable: holdings.tokenBalancesAvailable === true,
      isPartial: holdings.isPartial === true,
      capturedAt: new Date().toISOString()
    });

    holdingsLogger.info(
      {
        walletId: wallet.id,
        chainId,
        holdingsCount: persistedRow.holdingsCount,
        totalBalanceUsd: persistedRow.totalBalanceUsd,
        isPartial: persistedRow.isPartial,
        capturedAt: persistedRow.capturedAt
      },
      'Persisted holdings cache row upserted'
    );
  } catch (error) {
    holdingsLogger.warn(
      {
        walletId: wallet.id,
        chainId,
        err: error
      },
      'Failed to persist per-chain holdings cache row'
    );
  }
}

async function loadPersistedChainHoldings(wallet, chainIds) {
  const persistedRows = await findWalletChainHoldingsCaches({
    walletId: wallet.id,
    walletAddress: wallet.address,
    chainIds,
    maxAgeMs: PERSISTED_HOLDINGS_MAX_AGE_MS
  });

  if (persistedRows.length === 0) {
    return [];
  }

  holdingsLogger.info(
    {
      walletId: wallet.id,
      chainIds: persistedRows.map((row) => row.chainId),
      rowCount: persistedRows.length,
      maxAgeMs: PERSISTED_HOLDINGS_MAX_AGE_MS
    },
    'Persisted holdings cache loaded'
  );

  return persistedRows
    .map((row) => {
      const payload = row.payload;

      if (!payload || typeof payload !== 'object') {
        return null;
      }

      return {
        chainId: row.chainId,
        holdings: payload
      };
    })
    .filter(Boolean);
}

function hydratePersistedChainHoldingsToMemory(wallet, enabledChains, persistedChainResults) {
  for (const result of persistedChainResults) {
    const cacheKey = buildChainHoldingsCacheKey(wallet, result.chainId);
    setLastKnownGoodChainHoldings(
      cacheKey,
      result.holdings,
      {
        walletId: wallet.id,
        chainId: result.chainId,
        enabledChains,
        source: 'persisted'
      }
    );
  }
}

function buildPersistedAggregatedHoldings(wallet, enabledChains, persistedChainResults, unsupportedChains) {
  const partialReasons = [
    ...unsupportedChains.map((chainId) => buildPartialReason('UNSUPPORTED_CHAIN', chainId)),
    ...buildPersistedPartialReasons(persistedChainResults.map((result) => result.chainId))
  ];

  const aggregatedHoldings = aggregateHoldingsResults(
    wallet,
    enabledChains,
    persistedChainResults.map((result) => result.holdings),
    partialReasons
  );

  return {
    ...aggregatedHoldings,
    tokenBalancesAvailable: false,
    tokenBalancesReason: aggregatedHoldings.tokenBalancesReason
      ?? partialReasons.join(',')
  };
}

function createOrReuseFreshChainHoldingsPromise(wallet, chainId, enabledChains) {
  const cacheKey = buildChainHoldingsCacheKey(wallet, chainId);
  const existingPromise = inFlightChainHoldingsPromises.get(cacheKey);

  if (existingPromise) {
    return {
      cacheKey,
      promise: existingPromise,
      reused: true
    };
  }

  const nextPromise = Promise.resolve()
    .then(() => fetchWalletHoldingsForChain(wallet, chainId))
    .then(async (holdings) => {
      setCachedChainHoldings(cacheKey, holdings, buildChainFetchContext(wallet, chainId, enabledChains, cacheKey));
      setLastKnownGoodChainHoldings(cacheKey, holdings, buildChainFetchContext(wallet, chainId, enabledChains, cacheKey));
      await persistChainHoldingsResult(wallet, chainId, holdings);
      return holdings;
    })
    .finally(() => {
      inFlightChainHoldingsPromises.delete(cacheKey);
    });

  inFlightChainHoldingsPromises.set(cacheKey, nextPromise);

  return {
    cacheKey,
    promise: nextPromise,
    reused: false
  };
}

async function resolveChainHoldings(wallet, chainId, enabledChains, { requireLive = false } = {}) {
  const cacheKey = buildChainHoldingsCacheKey(wallet, chainId);
  const logContext = buildChainFetchContext(wallet, chainId, enabledChains, cacheKey);
  const cachedChainHoldings = getCachedChainHoldings(cacheKey, { requireLive });

  if (cachedChainHoldings) {
    holdingsLogger.info(logContext, 'Per-chain holdings cache hit');
    return {
      status: 'available',
      holdings: cachedChainHoldings,
      partialReasons: [],
      source: 'fresh-cache'
    };
  }

  const staleChainHoldings = getLastKnownGoodChainHoldings(cacheKey, { requireLive });
  const { promise: freshChainPromise } = createOrReuseFreshChainHoldingsPromise(wallet, chainId, enabledChains);

  try {
    const freshChainHoldings = await withTimeout(freshChainPromise, chainId);

    return {
      status: 'available',
      holdings: freshChainHoldings,
      partialReasons: [],
      source: 'fresh'
    };
  } catch (error) {
    if (error?.code === 'TIMEOUT') {
      holdingsLogger.warn(
        {
          ...logContext,
          timeoutMs: HOLDINGS_CHAIN_TIMEOUT_MS
        },
        'Per-chain holdings fetch timed out'
      );

      if (staleChainHoldings) {
        const partialReasons = [
          `FETCH_TIMEOUT:${chainId}`,
          `STALE_HOLDINGS_CACHE:${chainId}`
        ];

        holdingsLogger.warn(
          {
            ...logContext,
            partialReasons
          },
          'Serving stale per-chain holdings fallback after timeout'
        );

        return {
          status: 'available',
          holdings: staleChainHoldings,
          partialReasons,
          source: 'stale-timeout'
        };
      }

      return {
        status: 'unavailable',
        partialReasons: [`FETCH_TIMEOUT:${chainId}`],
        error
      };
    }

    holdingsLogger.warn(
      {
        ...logContext,
        err: error
      },
      'Per-chain holdings fetch failed'
    );

    if (staleChainHoldings) {
      const partialReasons = [
        `FETCH_FAILED:${chainId}`,
        `STALE_HOLDINGS_CACHE:${chainId}`
      ];

      holdingsLogger.warn(
        {
          ...logContext,
          partialReasons
        },
        'Serving stale per-chain holdings fallback after failure'
      );

      return {
        status: 'available',
        holdings: staleChainHoldings,
        partialReasons,
        source: 'stale-failure'
      };
    }

    return {
      status: 'unavailable',
      partialReasons: [`FETCH_FAILED:${chainId}`],
      error
    };
  }
}

export async function getWalletHoldings(
  walletId,
  {
    allowPersistedFallback = true,
    requireLive = false
  } = {}
) {
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

  const effectiveAllowPersistedFallback = requireLive ? false : allowPersistedFallback;
  const cacheKey = buildHoldingsCacheKey(wallet, {
    allowPersistedFallback: effectiveAllowPersistedFallback,
    requireLive
  });
  const cachedHoldings = getCachedHoldings(cacheKey, { requireLive });
  const lastKnownGoodHoldings = getLastKnownGoodHoldings(cacheKey, { requireLive });

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

  holdingsLogger.info(
    {
      cacheKey,
      walletId: wallet.id,
      chainId: wallet.chainId,
      enabledChains,
      allowPersistedFallback: effectiveAllowPersistedFallback,
      requireLive
    },
    'Holdings cache miss'
  );

  if (effectiveAllowPersistedFallback) {
    const persistedChainResults = await loadPersistedChainHoldings(wallet, supportedChains);

    if (persistedChainResults.length > 0) {
      hydratePersistedChainHoldingsToMemory(wallet, enabledChains, persistedChainResults);

      const persistedFallback = buildPersistedAggregatedHoldings(
        wallet,
        enabledChains,
        persistedChainResults,
        unsupportedChains
      );

      setCachedHoldings(cacheKey, persistedFallback, { source: 'persisted' });
      setLastKnownGoodHoldings(cacheKey, persistedFallback, { source: 'persisted' });

      holdingsLogger.warn(
        {
          walletId: wallet.id,
          chainId: wallet.chainId,
          enabledChains,
          persistedChains: persistedChainResults.map((result) => result.chainId),
          partialReasons: persistedFallback.partialReasons
        },
        'Persisted holdings fallback served'
      );

      return persistedFallback;
    }
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

  const holdingsPromise = Promise.resolve()
    .then(async () => {
      const chainResults = await Promise.allSettled(
        supportedChains.map((chainId) => resolveChainHoldings(wallet, chainId, enabledChains, { requireLive }))
      );
      const partialReasons = unsupportedChains.map((chainId) => buildPartialReason('UNSUPPORTED_CHAIN', chainId));
      const successfulResults = [];
      const successfulChainSources = [];
      let firstChainError = null;

      for (let index = 0; index < chainResults.length; index += 1) {
        const chainId = supportedChains[index];
        const result = chainResults[index];

        if (result.status === 'rejected') {
          const reason = result.reason;

          holdingsLogger.warn(
            {
              walletId: wallet.id,
              chainId,
              enabledChains,
              err: reason
            },
            'Per-chain holdings resolution rejected unexpectedly; continuing with partial holdings result'
          );

          if (Array.isArray(reason?.partialReasons) && reason.partialReasons.length > 0) {
            partialReasons.push(...reason.partialReasons);
          } else if (reason?.code === 'TIMEOUT') {
            partialReasons.push(buildPartialReason('FETCH_TIMEOUT', chainId));
          } else {
            partialReasons.push(buildPartialReason('FETCH_FAILED', chainId));
          }

          firstChainError ??= reason ?? null;
          continue;
        }

        if (result.value.status === 'available') {
          successfulResults.push(result.value.holdings);
          successfulChainSources.push({
            chainId,
            source: result.value.source
          });
          partialReasons.push(...result.value.partialReasons);

          if (result.value.holdings.totalBalanceUsd == null && (result.value.holdings.holdings?.length ?? 0) > 0) {
            partialReasons.push(buildPartialReason('VALUATION_UNAVAILABLE', chainId));
          }

          if (result.value.holdings.tokenBalancesAvailable === false || result.value.holdings.tokenBalancesReason) {
            partialReasons.push(
              buildPartialReason(
                result.value.holdings.tokenBalancesReason ?? 'TOKEN_BALANCES_UNAVAILABLE',
                chainId
              )
            );
          }

          continue;
        }

        partialReasons.push(...result.value.partialReasons);
        firstChainError ??= result.value.error ?? null;
      }

      if (successfulResults.length === 0) {
        const allChainsUnavailableReasons = [
          ...new Set([
            ...partialReasons,
            'ALL_CHAINS_UNAVAILABLE'
          ])
        ];

        holdingsLogger.warn(
          {
            walletId: wallet.id,
            chainId: wallet.chainId,
            enabledChains,
            partialReasons: allChainsUnavailableReasons,
            err: firstChainError
          },
          'All enabled chain holdings are currently unavailable'
        );

        if (lastKnownGoodHoldings) {
          holdingsLogger.warn(
            {
              walletId: wallet.id,
              chainId: wallet.chainId,
              enabledChains,
              partialReasons: allChainsUnavailableReasons
            },
            'Serving aggregated stale holdings fallback after all chain fetches failed'
          );

          return buildStaleHoldingsFallbackWithReasons(lastKnownGoodHoldings, [
            'ALL_CHAINS_FAILED_STALE_CACHE',
            ...partialReasons
          ]);
        }

        const staleChainResults = supportedChains
          .map((chainId) => {
            const staleHoldings = getLastKnownGoodChainHoldings(
              buildChainHoldingsCacheKey(wallet, chainId),
              { requireLive }
            );

            if (!staleHoldings) {
              return null;
            }

            return {
              chainId,
              holdings: staleHoldings
            };
          })
          .filter(Boolean);

        if (staleChainResults.length > 0) {
          const staleHoldingsResults = staleChainResults.map((result) => result.holdings);
          const holdings = staleHoldingsResults.flatMap((result) => result.holdings ?? []);
          const hasAnyHoldings = holdings.length > 0;
          const totalBalanceUsdSum = staleHoldingsResults.reduce((sum, result) => {
            if (typeof result.totalBalanceUsd !== 'number' || !Number.isFinite(result.totalBalanceUsd)) {
              return sum;
            }

            return sum + result.totalBalanceUsd;
          }, 0);
          const hasAnyValuedHoldings = staleHoldingsResults.some(
            (result) => typeof result.totalBalanceUsd === 'number' && Number.isFinite(result.totalBalanceUsd)
          );
          const staleReasons = staleChainResults.map((result) => buildPartialReason('STALE_HOLDINGS_CACHE', result.chainId));
          const mergedPartialReasons = [...new Set([
            ...partialReasons,
            ...staleReasons
          ])];
          const tokenBalanceReason = buildChainLevelTokenBalancesReason(mergedPartialReasons, staleHoldingsResults)
            ?? mergedPartialReasons.join(',');
          const staleOnlyAggregatedHoldings = {
            walletId: wallet.id,
            chainId: wallet.chainId,
            enabledChains,
            totalBalanceUsd: !hasAnyHoldings
              ? 0
              : hasAnyValuedHoldings
                ? Number(totalBalanceUsdSum.toFixed(2))
                : null,
            holdings,
            tokenBalancesAvailable: false,
            tokenBalancesReason: tokenBalanceReason,
            isPartial: true,
            partialReasons: mergedPartialReasons
          };

          holdingsLogger.warn(
            {
              walletId: wallet.id,
              chainId: wallet.chainId,
              enabledChains,
              staleChains: staleChainResults.map((result) => result.chainId),
              partialReasons: mergedPartialReasons
            },
            'Serving per-chain stale-only holdings fallback after all chain fetches failed'
          );

          return staleOnlyAggregatedHoldings;
        }

        const emptyPartialHoldings = buildEmptyPartialHoldingsResponse(wallet, enabledChains, allChainsUnavailableReasons);

        holdingsLogger.warn(
          {
            walletId: wallet.id,
            chainId: wallet.chainId,
            enabledChains,
            partialReasons: emptyPartialHoldings.partialReasons
          },
          'Serving empty partial holdings response because no fresh or stale chain data is available'
        );

        return emptyPartialHoldings;
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
      ) && !partialReasons.some((reason) =>
        CHAIN_LEVEL_TOKEN_BALANCE_PARTIAL_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix))
      );
      const tokenBalanceReason = buildChainLevelTokenBalancesReason(partialReasons, successfulResults);

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
        tokenBalancesReason: tokenBalanceReason,
        isPartial: partialReasons.length > 0,
        partialReasons
      };

      holdingsLogger.info(
        {
          walletId: wallet.id,
          chainId: wallet.chainId,
          enabledChains,
          successfulChains: successfulResults.map((result) => result.chainId),
          successfulChainSources,
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
