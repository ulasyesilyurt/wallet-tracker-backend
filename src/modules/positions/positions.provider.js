import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getChainConfigById } from '../chains/chains.config.js';
import { fetchWithTimeout, safeProviderError } from '../../utils/providerRequests.js';

const positionsProviderLogger = logger.child({ module: 'positions-provider' });
const ZERION_API_BASE_URL = 'https://api.zerion.io/v1';
const POSITIONS_CACHE_TTL_MS = 60 * 1000;
const DEGRADED_POSITIONS_CACHE_TTL_MS = 60 * 1000;
const POSITIONS_LAST_KNOWN_GOOD_TTL_MS = 15 * 60 * 1000;
const ZERION_RATE_LIMIT_COOLDOWN_MS = 15 * 1000;
const ZERION_PAGE_SIZE = 100;
const positionsCache = new Map();
const positionsLastKnownGoodCache = new Map();
const inFlightPositionsPromises = new Map();
let zerionCooldownUntil = 0;

function isZerionCooldownActive() {
  return zerionCooldownUntil > Date.now();
}

function getZerionCooldownRemainingMs() {
  return Math.max(0, zerionCooldownUntil - Date.now());
}

function startZerionCooldown(context = {}) {
  zerionCooldownUntil = Date.now() + ZERION_RATE_LIMIT_COOLDOWN_MS;
  positionsProviderLogger.warn(
    {
      cooldownMs: ZERION_RATE_LIMIT_COOLDOWN_MS,
      ...context
    },
    'Zerion positions 429 cooldown started'
  );
}

function buildEmptyResponse(wallet, options = {}) {
  return {
    walletId: wallet.id,
    chainId: wallet.chainId,
    positions: [],
    isPartial: options.isPartial === true,
    partialReasons: Array.isArray(options.partialReasons) ? options.partialReasons : []
  };
}

function buildPositionsCacheKey(wallet) {
  return `${wallet.chainId}:${wallet.address.toLowerCase()}`;
}

function getLastKnownGoodCacheKey(wallet) {
  return buildPositionsCacheKey(wallet);
}

export function peekCachedWalletPositionsForChain(wallet, chainId = wallet.chainId) {
  const chainWallet = {
    ...wallet,
    chainId
  };
  const cacheKey = buildPositionsCacheKey(chainWallet);
  const cachedEntry = positionsCache.get(cacheKey);

  if (!cachedEntry) {
    return null;
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    positionsCache.delete(cacheKey);
    return null;
  }

  return cachedEntry.value;
}

function peekLastKnownGoodPositionsForChain(wallet, chainId = wallet.chainId) {
  const chainWallet = {
    ...wallet,
    chainId
  };
  const cacheKey = getLastKnownGoodCacheKey(chainWallet);
  const cachedEntry = positionsLastKnownGoodCache.get(cacheKey);

  if (!cachedEntry) {
    return null;
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    positionsLastKnownGoodCache.delete(cacheKey);
    return null;
  }

  return cachedEntry.value;
}

export function peekCachedWalletPositions(wallet) {
  return peekCachedWalletPositionsForChain(wallet, wallet.chainId);
}

function setCachedPositionsResponse(wallet, value, { isDegraded = false } = {}) {
  positionsCache.set(buildPositionsCacheKey(wallet), {
    value,
    expiresAt: Date.now() + (isDegraded ? DEGRADED_POSITIONS_CACHE_TTL_MS : POSITIONS_CACHE_TTL_MS),
    isDegraded
  });

  positionsProviderLogger.info(
    {
      walletId: wallet.id,
      walletAddress: wallet.address,
      chainId: wallet.chainId,
      ttlMs: isDegraded ? DEGRADED_POSITIONS_CACHE_TTL_MS : POSITIONS_CACHE_TTL_MS,
      isDegraded
    },
    isDegraded ? 'Cached degraded positions response' : 'Cached positions response'
  );
}

function setLastKnownGoodPositionsResponse(wallet, value) {
  positionsLastKnownGoodCache.set(getLastKnownGoodCacheKey(wallet), {
    value,
    expiresAt: Date.now() + POSITIONS_LAST_KNOWN_GOOD_TTL_MS
  });

  positionsProviderLogger.info(
    {
      walletId: wallet.id,
      walletAddress: wallet.address,
      chainId: wallet.chainId,
      positionsCount: Array.isArray(value?.positions) ? value.positions.length : 0,
      ttlMs: POSITIONS_LAST_KNOWN_GOOD_TTL_MS
    },
    'Stored last known good positions response'
  );
}

function buildPartialResponseFromLastKnownGood(lastKnownGoodResponse, partialReason) {
  const existingPartialReasons = Array.isArray(lastKnownGoodResponse?.partialReasons)
    ? lastKnownGoodResponse.partialReasons
    : [];

  return {
    ...lastKnownGoodResponse,
    positions: Array.isArray(lastKnownGoodResponse?.positions)
      ? [...lastKnownGoodResponse.positions]
      : [],
    isPartial: true,
    partialReasons: [...new Set([...existingPartialReasons, partialReason])]
  };
}

function buildZerionAuthorizationHeader() {
  return `Basic ${Buffer.from(`${env.ZERION_API_KEY}:`).toString('base64')}`;
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function formatAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString();
  }

  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }

  return '0';
}

function extractPositionType(attributes) {
  return (
    normalizeString(attributes?.position_type) ??
    normalizeString(attributes?.position_type_display) ??
    normalizeString(attributes?.position_category) ??
    normalizeString(attributes?.interface) ??
    'Position'
  );
}

function extractProtocolName(position, includedMap) {
  const applicationMetadata = position?.attributes?.application_metadata;

  return (
    normalizeString(applicationMetadata?.name) ??
    normalizeString(applicationMetadata?.slug) ??
    normalizeString(position?.relationships?.protocol?.data?.id) ??
    normalizeString(includedMap.get(position?.relationships?.protocol?.data?.id)?.attributes?.name) ??
    'Unknown protocol'
  );
}

function extractAssetName(attributes) {
  return (
    normalizeString(attributes?.fungible_info?.name) ??
    normalizeString(attributes?.name) ??
    normalizeString(attributes?.display_name) ??
    'Position asset'
  );
}

function extractAssetSymbol(attributes) {
  return (
    normalizeString(attributes?.fungible_info?.symbol) ??
    normalizeString(attributes?.symbol) ??
    normalizeString(attributes?.display_symbol) ??
    'UNKNOWN'
  );
}

function extractAmount(attributes) {
  const quantity = attributes?.quantity ?? {};

  return formatAmount(
    quantity?.numeric ??
      quantity?.float ??
      quantity?.int ??
      attributes?.value_quantity ??
      attributes?.balance
  );
}

function extractValueUsd(attributes) {
  const candidates = [
    attributes?.value,
    attributes?.value_usd,
    attributes?.usd_value,
    attributes?.financial_metrics?.market_value
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === 'string' && candidate.trim() !== '') {
      const normalizedCandidate = candidate.replace(/,/g, '').trim();
      const parsed = Number(normalizedCandidate);

      if (Number.isFinite(parsed)) {
        return parsed;
      }

      const matchedNumericPrefix = normalizedCandidate.match(/-?\d+(\.\d+)?/);

      if (matchedNumericPrefix) {
        const prefixedParsed = Number(matchedNumericPrefix[0]);

        if (Number.isFinite(prefixedParsed)) {
          return prefixedParsed;
        }
      }
    }
  }

  return null;
}

function buildIncludedMap(included) {
  const includedMap = new Map();

  for (const item of Array.isArray(included) ? included : []) {
    if (typeof item?.id === 'string') {
      includedMap.set(item.id, item);
    }
  }

  return includedMap;
}

function mapZerionPosition(position, includedMap) {
  const attributes = position?.attributes ?? {};

  return {
    protocolName: extractProtocolName(position, includedMap),
    positionType: extractPositionType(attributes),
    assetName: extractAssetName(attributes),
    assetSymbol: extractAssetSymbol(attributes),
    amount: extractAmount(attributes),
    valueUsd: extractValueUsd(attributes)
  };
}

async function fetchJson(url, options) {
  const response = await fetchWithTimeout(url, options, env.PROVIDER_REQUEST_TIMEOUT_MS);
  const data = await response.json().catch((error) => {
    if (['AbortError', 'TimeoutError'].includes(error?.name)) {
      throw error;
    }
    return null;
  });

  if (!response.ok) {
    const error = new Error(`Zerion positions request failed with status ${response.status}`);
    error.status = response.status;
    error.responseBody = data;
    throw error;
  }

  return data;
}

function getZerionChainId(chainId) {
  return getChainConfigById(chainId)?.zerionChainId ?? null;
}

function isUnsupportedZerionChainError(error) {
  const status = error?.status ?? null;

  if (![400, 404, 422].includes(status)) {
    return false;
  }

  const message = `${error?.message ?? ''} ${JSON.stringify(error?.responseBody ?? {})}`.toLowerCase();

  return (
    message.includes('unsupported') ||
    message.includes('chain') ||
    message.includes('filter[chain_ids]') ||
    message.includes('invalid') ||
    message.includes('not supported')
  );
}

async function fetchAllWalletPositions(walletAddress, zerionChainId) {
  const headers = {
    accept: 'application/json',
    authorization: buildZerionAuthorizationHeader()
  };
  let nextUrl = `${ZERION_API_BASE_URL}/wallets/${walletAddress}/positions/?filter[chain_ids]=${encodeURIComponent(zerionChainId)}&filter[positions]=only_complex&currency=usd&sort=-value&page[size]=${ZERION_PAGE_SIZE}`;
  const initialUrl = new URL(nextUrl);
  const seenUrls = new Set();
  const maxItems = env.ZERION_MAX_PAGES * ZERION_PAGE_SIZE;
  const aggregatedData = [];
  const aggregatedIncluded = [];
  let pageCount = 0;
  let isPartial = false;

  while (nextUrl && pageCount < env.ZERION_MAX_PAGES) {
    const pageUrl = new URL(nextUrl, initialUrl);
    if (pageUrl.origin !== initialUrl.origin || pageUrl.pathname !== initialUrl.pathname ||
        pageUrl.username || pageUrl.password) {
      const error = new Error('Zerion pagination returned an unsafe next link');
      error.code = 'PROVIDER_INVALID_PAGINATION';
      throw error;
    }
    if (seenUrls.has(pageUrl.href)) {
      isPartial = true;
      break;
    }
    seenUrls.add(pageUrl.href);
    const response = await fetchJson(pageUrl.href, { headers });
    pageCount += 1;
    if (!Array.isArray(response?.data) ||
        (response?.links?.next != null && typeof response.links.next !== 'string')) {
      const error = new Error('Zerion positions pagination response was invalid');
      error.code = 'PROVIDER_INVALID_PAGINATION';
      throw error;
    }
    const pageData = response.data;
    const pageIncluded = Array.isArray(response?.included) ? response.included : [];

    const remainingData = maxItems - aggregatedData.length;
    const remainingIncluded = maxItems * 2 - aggregatedIncluded.length;
    aggregatedData.push(...pageData.slice(0, remainingData));
    aggregatedIncluded.push(...pageIncluded.slice(0, remainingIncluded));
    if (pageData.length > remainingData || pageIncluded.length > remainingIncluded) {
      isPartial = true;
      break;
    }
    nextUrl = typeof response?.links?.next === 'string' && response.links.next !== '' ? response.links.next : null;
    if (nextUrl && (aggregatedData.length >= maxItems || aggregatedIncluded.length >= maxItems * 2)) {
      isPartial = true;
      break;
    }
  }

  if (nextUrl) {
    isPartial = true;
  }

  return {
    data: aggregatedData,
    included: aggregatedIncluded,
    isPartial,
    pageCount
  };
}

export async function fetchWalletPositionsForChain(wallet, chainId = wallet.chainId) {
  const chainWallet = {
    ...wallet,
    chainId
  };
  const cachedResponse = peekCachedWalletPositionsForChain(chainWallet, chainId);

  if (cachedResponse) {
    positionsProviderLogger.info(
      {
        walletId: chainWallet.id,
        walletAddress: chainWallet.address,
        chainId: chainWallet.chainId
      },
      'Positions cache hit'
    );
    positionsProviderLogger.info(
      {
        walletId: chainWallet.id,
        walletAddress: chainWallet.address,
        chainId: chainWallet.chainId
      },
      'Zerion request skipped because cache exists'
    );
    return cachedResponse;
  }

  positionsProviderLogger.info(
    {
      walletId: chainWallet.id,
      walletAddress: chainWallet.address,
      chainId: chainWallet.chainId
    },
    'Positions cache miss'
  );

  const emptyResponse = buildEmptyResponse(chainWallet);
  const normalCacheKey = buildPositionsCacheKey(chainWallet);
  const staleCacheKey = getLastKnownGoodCacheKey(chainWallet);
  const freshCacheEntry = peekCachedWalletPositionsForChain(chainWallet, chainId);
  const staleSuccessfulResponse = peekLastKnownGoodPositionsForChain(chainWallet, chainId);
  const zerionChainId = getZerionChainId(chainWallet.chainId);

  positionsProviderLogger.info(
    {
      walletId: chainWallet.id,
      chainId: chainWallet.chainId,
      normalCacheKey,
      staleSuccessCacheKey: staleCacheKey,
      hasFreshCache: Boolean(freshCacheEntry),
      hasStaleSuccessCache: Boolean(staleSuccessfulResponse),
      positionsCountFromStale: Array.isArray(staleSuccessfulResponse?.positions) ? staleSuccessfulResponse.positions.length : 0,
      degradedReason: null
    },
    'Positions cache diagnostics before provider fetch'
  );

  if (!env.ZERION_API_KEY) {
    positionsProviderLogger.warn(
      { walletId: chainWallet.id, chainId: chainWallet.chainId },
      'ZERION_API_KEY is not configured; returning empty positions response'
    );

    if (staleSuccessfulResponse) {
      positionsProviderLogger.warn(
        {
          walletId: chainWallet.id,
          walletAddress: chainWallet.address,
          chainId: chainWallet.chainId,
          positionsCount: staleSuccessfulResponse.positions.length,
          degradedReason: `ZERION_API_KEY_MISSING:${chainWallet.chainId}`
        },
        'Using stale successful positions cache because Zerion API key is unavailable'
      );
      return staleSuccessfulResponse;
    }

    return buildEmptyResponse(chainWallet, {
      isPartial: true,
      partialReasons: [`ZERION_API_KEY_MISSING:${chainWallet.chainId}`]
    });
  }

  if (!zerionChainId) {
    const error = new Error(`Zerion positions are not configured for chain ${chainWallet.chainId}`);
    error.code = 'UNSUPPORTED_ZERION_CHAIN';
    throw error;
  }

  if (isZerionCooldownActive()) {
    const cooldownReason = `ZERION_COOLDOWN_ACTIVE:${chainWallet.chainId}`;

    positionsProviderLogger.warn(
      {
        walletId: chainWallet.id,
        walletAddress: chainWallet.address,
        chainId: chainWallet.chainId,
        cooldownRemainingMs: getZerionCooldownRemainingMs()
      },
      'Zerion 429 cooldown active'
    );

    if (staleSuccessfulResponse) {
      const partialStaleResponse = buildPartialResponseFromLastKnownGood(
        staleSuccessfulResponse,
        cooldownReason
      );

      positionsProviderLogger.warn(
        {
          walletId: chainWallet.id,
          walletAddress: chainWallet.address,
          chainId: chainWallet.chainId,
          positionsCount: staleSuccessfulResponse.positions.length,
          degradedReason: cooldownReason
        },
        'Using stale successful positions cache during Zerion cooldown'
      );

      setCachedPositionsResponse(chainWallet, partialStaleResponse, { isDegraded: true });
      return partialStaleResponse;
    }

    const degradedResponse = buildEmptyResponse(chainWallet, {
      isPartial: true,
      partialReasons: [cooldownReason]
    });
    setCachedPositionsResponse(chainWallet, degradedResponse, { isDegraded: true });
    return degradedResponse;
  }

  const cacheKey = buildPositionsCacheKey(chainWallet);
  const existingPromise = inFlightPositionsPromises.get(cacheKey);

  if (existingPromise) {
    positionsProviderLogger.info(
      {
        walletId: chainWallet.id,
        walletAddress: chainWallet.address,
        chainId: chainWallet.chainId
      },
      'Positions in-flight request reused'
    );
    return existingPromise;
  }

  const positionsPromise = Promise.resolve()
    .then(async () => {
      try {
        positionsProviderLogger.info(
          {
            walletId: chainWallet.id,
            walletAddress: chainWallet.address,
            chainId: chainWallet.chainId,
            zerionChainId
          },
          'Zerion positions request started'
        );

        const zerionResponse = await fetchAllWalletPositions(chainWallet.address, zerionChainId);
        const includedMap = buildIncludedMap(zerionResponse.included);
        const positions = (Array.isArray(zerionResponse.data) ? zerionResponse.data : [])
          .map((position) => ({
            ...mapZerionPosition(position, includedMap),
            chainId: chainWallet.chainId
          }))
          .filter((position) => position.valueUsd == null || position.valueUsd > 0);

        const response = {
          walletId: chainWallet.id,
          chainId: chainWallet.chainId,
          positions,
          isPartial: zerionResponse.isPartial,
          partialReasons: zerionResponse.isPartial ? [`ZERION_PAGE_LIMIT:${chainWallet.chainId}`] : []
        };

        setCachedPositionsResponse(chainWallet, response, { isDegraded: zerionResponse.isPartial });
        if (!zerionResponse.isPartial) {
          setLastKnownGoodPositionsResponse(chainWallet, response);
        } else {
          positionsProviderLogger.warn({
            provider: 'zerion',
            operation: 'positions',
            pageCount: zerionResponse.pageCount,
            itemCount: positions.length,
            maxPages: env.ZERION_MAX_PAGES
          }, 'Zerion positions pagination limit reached; returning partial data');
        }

        return response;
      } catch (error) {
        if (isUnsupportedZerionChainError(error)) {
          positionsProviderLogger.warn(
            {
              ...safeProviderError('zerion', 'positions', error),
              walletId: chainWallet.id,
              walletAddress: chainWallet.address,
              chainId: chainWallet.chainId,
              zerionChainId,
              status: error?.status ?? null
            },
            'Zerion positions provider reported unsupported chain'
          );

          error.code = 'UNSUPPORTED_ZERION_CHAIN';
          throw error;
        }

        if (error?.status === 429) {
          const rateLimitedReason = `ZERION_RATE_LIMITED:${chainWallet.chainId}`;

          positionsProviderLogger.warn(
            safeProviderError('zerion', 'positions', error),
            'Zerion positions rate limit response received'
          );

          startZerionCooldown({
            walletId: wallet.id,
            walletAddress: chainWallet.address,
            chainId: chainWallet.chainId
          });
          if (staleSuccessfulResponse) {
            const partialStaleResponse = buildPartialResponseFromLastKnownGood(
              staleSuccessfulResponse,
              rateLimitedReason
            );

            positionsProviderLogger.warn(
              {
                walletId: chainWallet.id,
                walletAddress: chainWallet.address,
                chainId: chainWallet.chainId,
                positionsCount: staleSuccessfulResponse.positions.length,
                degradedReason: rateLimitedReason
              },
              'Using stale successful positions cache after Zerion rate limit'
            );

            setCachedPositionsResponse(chainWallet, partialStaleResponse, { isDegraded: true });
            return partialStaleResponse;
          }

          const degradedResponse = buildEmptyResponse(chainWallet, {
            isPartial: true,
            partialReasons: [rateLimitedReason]
          });
          setCachedPositionsResponse(chainWallet, degradedResponse, { isDegraded: true });
          return degradedResponse;
        }

        const failure = safeProviderError('zerion', 'positions', error);
        positionsProviderLogger.error(
          {
            ...failure,
            walletId: chainWallet.id,
            walletAddress: chainWallet.address,
            chainId: chainWallet.chainId
          },
          'Zerion positions provider request failed; returning empty positions response'
        );

        const failureReason = failure.isTimeout ? 'ZERION_TIMEOUT' : 'FETCH_FAILED';
        if (staleSuccessfulResponse) {
          positionsProviderLogger.warn(
            {
              walletId: chainWallet.id,
              walletAddress: chainWallet.address,
              chainId: chainWallet.chainId,
              positionsCount: staleSuccessfulResponse.positions.length,
              degradedReason: `${failureReason}:${chainWallet.chainId}`
            },
            'Using stale successful positions cache after provider failure'
          );
          const partialStaleResponse = buildPartialResponseFromLastKnownGood(
            staleSuccessfulResponse,
            `${failureReason}:${chainWallet.chainId}`
          );
          setCachedPositionsResponse(chainWallet, partialStaleResponse, { isDegraded: true });
          return partialStaleResponse;
        }

        return buildEmptyResponse(chainWallet, {
          isPartial: true,
          partialReasons: [`${failureReason}:${chainWallet.chainId}`]
        });
      }
    })
    .finally(() => {
      inFlightPositionsPromises.delete(cacheKey);
    });

  inFlightPositionsPromises.set(cacheKey, positionsPromise);
  return positionsPromise;
}

export async function fetchWalletPositions(wallet) {
  return fetchWalletPositionsForChain(wallet, wallet.chainId);
}

export async function fetchEthereumMainnetPositions(wallet) {
  return fetchWalletPositions(wallet);
}

export function peekCachedEthereumMainnetPositions(wallet) {
  return peekCachedWalletPositions(wallet);
}
