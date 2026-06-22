import { JsonRpcProvider, formatEther, formatUnits } from 'ethers';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  BASE_MAINNET_CHAIN_ID,
  ETHEREUM_MAINNET_CHAIN_ID,
  getChainConfigById
} from '../chains/chains.config.js';

const providersByChainId = new Map();
const holdingsProviderLogger = logger.child({ module: 'holdings-provider' });
const ALCHEMY_PRICES_BASE_URL = 'https://api.g.alchemy.com/prices/v1';
const COINGECKO_SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
const TOKEN_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_METADATA_NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const TOKEN_METADATA_PERMANENT_NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_METADATA_MAX_CONCURRENCY = 4;
const PRICING_REQUEST_DELAY_MS = 150;
const ALCHEMY_PRICING_COOLDOWN_MS = 60 * 1000;
const TOKEN_BALANCE_REQUEST_DELAY_MS = 150;
const TOKEN_BALANCE_COOLDOWN_MS = 60 * 1000;
const TOKEN_BALANCE_MAX_RETRIES = 1;
const priceCache = new Map();
const tokenMetadataCache = new Map();
let pricingQueue = Promise.resolve();
let lastSuccessfulEthUsdPrice = null;
let lastSuccessfulEthUsdPriceAt = null;
let alchemyPricingCooldownUntil = 0;
let lastCooldownActiveLogAt = 0;
const inFlightPricePromises = new Map();
const inFlightTokenMetadataPromises = new Map();
let tokenBalanceQueue = Promise.resolve();
let tokenBalanceCooldownUntil = 0;
let lastTokenBalanceCooldownLogAt = 0;
const inFlightTokenBalancePromises = new Map();
let activeTokenMetadataRequests = 0;
const queuedTokenMetadataResolvers = [];

function verboseHoldingsLoggingEnabled() {
  return process.env.SUPPRESS_HOLDINGS_PROVIDER_LOGS !== 'true';
}

function detailedHoldingsLoggingEnabled() {
  return verboseHoldingsLoggingEnabled() && process.env.DEBUG_HOLDINGS_DETAILS === 'true';
}

function logHoldingsInfo(context, message) {
  if (!detailedHoldingsLoggingEnabled()) {
    return;
  }

  holdingsProviderLogger.info(context, message);
}

function logHoldingsWarn(context, message) {
  if (!detailedHoldingsLoggingEnabled()) {
    return;
  }

  holdingsProviderLogger.warn(context, message);
}

function getPriceCacheEntry(cacheKey) {
  const entry = priceCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    priceCache.delete(cacheKey);
    return null;
  }

  return entry;
}

function isAlchemyPricingCooldownActive() {
  return alchemyPricingCooldownUntil > Date.now();
}

function getAlchemyPricingCooldownRemainingMs() {
  return Math.max(0, alchemyPricingCooldownUntil - Date.now());
}

function startAlchemyPricingCooldown(context = {}) {
  alchemyPricingCooldownUntil = Date.now() + ALCHEMY_PRICING_COOLDOWN_MS;
  holdingsProviderLogger.warn(
    {
      cooldownMs: ALCHEMY_PRICING_COOLDOWN_MS,
      ...context
    },
    'Alchemy pricing cooldown started'
  );
}

function logAlchemyPricingCooldownActive(context = {}) {
  const now = Date.now();

  if (now - lastCooldownActiveLogAt < 10_000) {
    return;
  }

  lastCooldownActiveLogAt = now;
  holdingsProviderLogger.info(
    {
      cooldownRemainingMs: getAlchemyPricingCooldownRemainingMs(),
      ...context
    },
    'Alchemy pricing cooldown active'
  );
}

function isTokenBalanceCooldownActive() {
  return tokenBalanceCooldownUntil > Date.now();
}

function getTokenBalanceCooldownRemainingMs() {
  return Math.max(0, tokenBalanceCooldownUntil - Date.now());
}

function startTokenBalanceCooldown(context = {}) {
  tokenBalanceCooldownUntil = Date.now() + TOKEN_BALANCE_COOLDOWN_MS;
  holdingsProviderLogger.warn(
    {
      cooldownMs: TOKEN_BALANCE_COOLDOWN_MS,
      ...context
    },
    'Alchemy token balance cooldown started'
  );
}

function logTokenBalanceCooldownActive(context = {}) {
  const now = Date.now();

  if (now - lastTokenBalanceCooldownLogAt < 10_000) {
    return;
  }

  lastTokenBalanceCooldownLogAt = now;
  holdingsProviderLogger.info(
    {
      cooldownRemainingMs: getTokenBalanceCooldownRemainingMs(),
      ...context
    },
    'Alchemy token balance cooldown active'
  );
}

function setPriceCacheEntry(cacheKey, value) {
  priceCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + PRICE_CACHE_TTL_MS
  });
}

function buildAddressCacheKey(chainId, address) {
  return `${chainId}:address:${address.toLowerCase()}`;
}

function buildSymbolCacheKey(chainId, symbol) {
  return `${chainId}:symbol:${symbol}`;
}

function buildEthCacheKey(chainId) {
  return `${chainId}:symbol:ETH`;
}

function buildTokenMetadataCacheKey(chainId, contractAddress) {
  return `${chainId}:metadata:${contractAddress.toLowerCase()}`;
}

function getTokenMetadataCacheEntry(chainId, contractAddress) {
  const cacheKey = buildTokenMetadataCacheKey(chainId, contractAddress);
  const entry = tokenMetadataCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    tokenMetadataCache.delete(cacheKey);
    return null;
  }

  return entry;
}

function setTokenMetadataCacheEntry(chainId, contractAddress, value, { isNegative = false, ttlMs, reason = null } = {}) {
  tokenMetadataCache.set(buildTokenMetadataCacheKey(chainId, contractAddress), {
    value,
    isNegative,
    reason,
    expiresAt: Date.now() + (ttlMs ?? (isNegative ? TOKEN_METADATA_NEGATIVE_CACHE_TTL_MS : TOKEN_METADATA_CACHE_TTL_MS))
  });
}

function classifyTokenMetadataError(error) {
  const code = error?.code ?? null;
  const status = error?.status ?? null;
  const message = `${error?.message ?? ''} ${error?.shortMessage ?? ''}`.toLowerCase();
  const rateLimited =
    code === 429 ||
    status === 429 ||
    message.includes('429') ||
    message.includes('too many requests') ||
    message.includes('concurrent requests capacity');

  if (rateLimited) {
    return {
      reason: 'rate_limited',
      ttlMs: TOKEN_METADATA_NEGATIVE_CACHE_TTL_MS
    };
  }

  if (code === -32000) {
    return {
      reason: 'rpc_metadata_unavailable',
      ttlMs: TOKEN_METADATA_PERMANENT_NEGATIVE_CACHE_TTL_MS
    };
  }

  return {
    reason: 'metadata_unavailable',
    ttlMs: TOKEN_METADATA_NEGATIVE_CACHE_TTL_MS
  };
}

function getLastSuccessfulEthPriceFallback() {
  if (typeof lastSuccessfulEthUsdPrice !== 'number' || !Number.isFinite(lastSuccessfulEthUsdPrice)) {
    return null;
  }

  return {
    value: lastSuccessfulEthUsdPrice,
    lastUpdatedAt: lastSuccessfulEthUsdPriceAt
  };
}

function rememberSuccessfulEthPrice(usdPrice, source) {
  setPriceCacheEntry(buildEthCacheKey(ETHEREUM_MAINNET_CHAIN_ID), usdPrice);
  setPriceCacheEntry(buildEthCacheKey(BASE_MAINNET_CHAIN_ID), usdPrice);
  lastSuccessfulEthUsdPrice = usdPrice;
  lastSuccessfulEthUsdPriceAt = new Date().toISOString();

  holdingsProviderLogger.info(
    {
      pricingTarget: 'ETH',
      priceSource: source,
      usdPrice,
      cachedAt: lastSuccessfulEthUsdPriceAt
    },
    'ETH price stored successfully'
  );
}

function shouldSkipLiveAlchemyPricing() {
  return isAlchemyPricingCooldownActive();
}

function createInFlightPricePromise(cacheKey, factory) {
  const existingPromise = inFlightPricePromises.get(cacheKey);

  if (existingPromise) {
    return existingPromise;
  }

  const nextPromise = Promise.resolve()
    .then(factory)
    .finally(() => {
      inFlightPricePromises.delete(cacheKey);
    });

  inFlightPricePromises.set(cacheKey, nextPromise);
  return nextPromise;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function acquireTokenMetadataSlot() {
  if (activeTokenMetadataRequests < TOKEN_METADATA_MAX_CONCURRENCY) {
    activeTokenMetadataRequests += 1;
    return;
  }

  await new Promise((resolve) => {
    queuedTokenMetadataResolvers.push(resolve);
  });

  activeTokenMetadataRequests += 1;
}

function releaseTokenMetadataSlot() {
  activeTokenMetadataRequests = Math.max(0, activeTokenMetadataRequests - 1);
  const nextResolver = queuedTokenMetadataResolvers.shift();

  if (nextResolver) {
    nextResolver();
  }
}

async function enqueuePricingRequest(task) {
  const runTask = async () => {
    try {
      return await task();
    } finally {
      await delay(PRICING_REQUEST_DELAY_MS);
    }
  };

  const nextRun = pricingQueue.then(runTask, runTask);
  pricingQueue = nextRun.then(() => undefined, () => undefined);
  return nextRun;
}

async function enqueueTokenBalanceRequest(task) {
  const runTask = async () => {
    try {
      return await task();
    } finally {
      await delay(TOKEN_BALANCE_REQUEST_DELAY_MS);
    }
  };

  const nextRun = tokenBalanceQueue.then(runTask, runTask);
  tokenBalanceQueue = nextRun.then(() => undefined, () => undefined);
  return nextRun;
}

function getAlchemyRpcUrl(chainId) {
  if (chainId === ETHEREUM_MAINNET_CHAIN_ID) {
    return env.ALCHEMY_ETHEREUM_RPC_URL ?? env.ETHEREUM_RPC_URL ?? null;
  }

  if (chainId === BASE_MAINNET_CHAIN_ID) {
    return env.ALCHEMY_BASE_RPC_URL ?? null;
  }

  return null;
}

function getAlchemyProvider(chainId) {
  const existingProvider = providersByChainId.get(chainId);

  if (existingProvider) {
    return existingProvider;
  }

  const rpcUrl = getAlchemyRpcUrl(chainId);

  if (!rpcUrl) {
    throw new Error(`Alchemy holdings provider requires an RPC URL for chain ${chainId}.`);
  }

  const provider = new JsonRpcProvider(rpcUrl);
  providersByChainId.set(chainId, provider);
  return provider;
}

function extractAlchemyApiKey(chainId) {
  const rpcUrl = getAlchemyRpcUrl(chainId);

  if (!rpcUrl) {
    throw new Error(`Alchemy pricing requires an RPC URL for chain ${chainId}.`);
  }

  const match = rpcUrl.match(/\/v2\/([^/?#]+)/);

  if (!match?.[1]) {
    throw new Error('Could not extract Alchemy API key from configured RPC URL.');
  }

  return match[1];
}

function normalizeDecimals(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function normalizeTokenMetadata(contractAddress, metadata) {
  const decimals = normalizeDecimals(metadata?.decimals);
  const symbol = typeof metadata?.symbol === 'string' ? metadata.symbol : null;
  const name = typeof metadata?.name === 'string' ? metadata.name : null;
  const logoUrl = typeof metadata?.logo === 'string' ? metadata.logo : null;

  return {
    tokenAddress: contractAddress,
    symbol,
    name,
    decimals,
    logoUrl
  };
}

function buildFallbackMetadata(contractAddress) {
  return {
    tokenAddress: contractAddress,
    symbol: null,
    name: null,
    decimals: 0,
    logoUrl: null
  };
}

async function fetchTokenMetadataWithCache(alchemyProvider, chainId, contractAddress) {
  const normalizedAddress = contractAddress.toLowerCase();
  const cachedEntry = getTokenMetadataCacheEntry(chainId, normalizedAddress);

  if (cachedEntry) {
    logHoldingsInfo(
      {
        tokenAddress: normalizedAddress,
        negativeReason: cachedEntry.reason ?? null
      },
      cachedEntry.isNegative ? 'Token metadata negative cache hit' : 'Token metadata cache hit'
    );

    return cachedEntry.value;
  }

  logHoldingsInfo(
    {
      tokenAddress: normalizedAddress
    },
    'Token metadata cache miss'
  );

  const cacheKey = buildTokenMetadataCacheKey(chainId, normalizedAddress);
  const existingPromise = inFlightTokenMetadataPromises.get(cacheKey);

  if (existingPromise) {
    return existingPromise;
  }

  const metadataPromise = Promise.resolve()
    .then(async () => {
      await acquireTokenMetadataSlot();

      try {
        const metadata = await alchemyProvider.send('alchemy_getTokenMetadata', [contractAddress]);
        setTokenMetadataCacheEntry(chainId, normalizedAddress, metadata, { isNegative: false, reason: null });
        return metadata;
      } catch (error) {
        const fallbackMetadata = buildFallbackMetadata(contractAddress);
        const classifiedError = classifyTokenMetadataError(error);

        holdingsProviderLogger.warn(
          {
            tokenAddress: normalizedAddress,
            method: 'alchemy_getTokenMetadata',
            errorCode: error?.code ?? null,
            errorStatus: error?.status ?? null,
            errorMessage: error?.message ?? null,
            metadataFailureReason: classifiedError.reason,
            negativeCacheTtlMs: classifiedError.ttlMs
          },
          'Token metadata fetch failed'
        );

        setTokenMetadataCacheEntry(chainId, normalizedAddress, fallbackMetadata, {
          isNegative: true,
          ttlMs: classifiedError.ttlMs,
          reason: classifiedError.reason
        });
        return fallbackMetadata;
      } finally {
        releaseTokenMetadataSlot();
      }
    })
    .finally(() => {
      inFlightTokenMetadataPromises.delete(cacheKey);
    });

  inFlightTokenMetadataPromises.set(cacheKey, metadataPromise);
  return metadataPromise;
}

function normalizeTokenBalance(rawBalance) {
  if (typeof rawBalance !== 'string' || rawBalance.trim() === '') {
    return 0n;
  }

  try {
    return BigInt(rawBalance);
  } catch {
    return 0n;
  }
}

function mapHolding({ contractAddress, tokenBalance, metadata }) {
  if (typeof tokenBalance?.error === 'string') {
    logHoldingsWarn(
      {
        contractAddress,
        error: tokenBalance.error
      },
      'Excluding token holding because Alchemy returned an error instead of a balance'
    );

    return null;
  }

  const rawBalance = normalizeTokenBalance(tokenBalance);

  if (rawBalance === 0n) {
    return null;
  }

  const normalizedMetadata = normalizeTokenMetadata(contractAddress, metadata);

  return {
    tokenAddress: normalizedMetadata.tokenAddress,
    symbol: normalizedMetadata.symbol,
    name: normalizedMetadata.name,
    balance: formatUnits(rawBalance, normalizedMetadata.decimals),
    decimals: normalizedMetadata.decimals,
    logoUrl: normalizedMetadata.logoUrl,
    balanceUsd: null,
    isSuspicious: false,
    suspicionReasons: []
  };
}

async function fetchAllErc20Balances(alchemyProvider, chainId, walletAddress) {
  const normalizedWalletAddress = `${chainId}:${walletAddress.toLowerCase()}`;

  if (inFlightTokenBalancePromises.has(normalizedWalletAddress)) {
    return inFlightTokenBalancePromises.get(normalizedWalletAddress);
  }

  const tokenBalancePromise = (async () => {
    if (isTokenBalanceCooldownActive()) {
      logTokenBalanceCooldownActive({
        chainId,
        walletAddress: walletAddress.toLowerCase()
      });

      return {
        tokenBalances: [],
        tokenBalancesAvailable: false,
        tokenBalancesReason: 'TOKEN_BALANCES_RATE_LIMITED'
      };
    }

    const tokenBalances = [];
    let pageKey;

    do {
      const params = [walletAddress, 'erc20', { maxCount: 100 }];

      if (pageKey) {
        params[2] = { pageKey, maxCount: 100 };
      }

      let response;
      let attempt = 0;

      while (attempt <= TOKEN_BALANCE_MAX_RETRIES) {
        try {
          response = await enqueueTokenBalanceRequest(() =>
            alchemyProvider.send('alchemy_getTokenBalances', params)
          );
          break;
        } catch (error) {
          const isRateLimited =
            error?.code === 429 ||
            error?.status === 429 ||
            (typeof error?.message === 'string' &&
              (error.message.includes('code: 429') ||
                error.message.includes('concurrent requests capacity') ||
                error.message.includes('429')));

          if (!isRateLimited || attempt >= TOKEN_BALANCE_MAX_RETRIES) {
            if (isRateLimited) {
              startTokenBalanceCooldown({
                walletAddress: normalizedWalletAddress,
                chainId,
                method: 'alchemy_getTokenBalances',
                code: error?.code ?? error?.status ?? null
              });

              holdingsProviderLogger.warn(
                {
                  walletAddress: normalizedWalletAddress,
                  chainId,
                  method: 'alchemy_getTokenBalances',
                  code: error?.code ?? error?.status ?? null,
                  reason: 'TOKEN_BALANCES_RATE_LIMITED'
                },
                'Alchemy token balances request was rate-limited; returning degraded holdings response'
              );

              return {
                tokenBalances,
                tokenBalancesAvailable: false,
                tokenBalancesReason: 'TOKEN_BALANCES_RATE_LIMITED'
              };
            }

            throw error;
          }

          await delay(500 * (attempt + 1));
          attempt += 1;
        }
      }

      const currentPageBalances = Array.isArray(response?.tokenBalances) ? response.tokenBalances : [];

      tokenBalances.push(...currentPageBalances);
      pageKey = typeof response?.pageKey === 'string' ? response.pageKey : undefined;
    } while (pageKey);

    return {
      tokenBalances,
      tokenBalancesAvailable: true,
      tokenBalancesReason: null
    };
  })().finally(() => {
    inFlightTokenBalancePromises.delete(normalizedWalletAddress);
  });

  inFlightTokenBalancePromises.set(normalizedWalletAddress, tokenBalancePromise);
  return tokenBalancePromise;
}

function buildNativeHolding(chainId, rawBalance) {
  if (rawBalance === 0n) {
    return null;
  }

  const chainConfig = getChainConfigById(chainId);

  return {
    tokenAddress: null,
    symbol: chainConfig?.nativeSymbol ?? 'ETH',
    name: chainConfig?.nativeName ?? 'Ethereum',
    balance: formatEther(rawBalance),
    decimals: 18,
    logoUrl: null,
    balanceUsd: null,
    isSuspicious: false,
    suspicionReasons: []
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(`Alchemy pricing request failed with status ${response.status}`);
    error.status = response.status;
    error.responseBody = data;
    error.rateLimited = response.status === 429;
    throw error;
  }

  return data;
}

function chunkArray(values, size) {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function findUsdPrice(prices) {
  if (!Array.isArray(prices)) {
    return null;
  }

  const usdPrice = prices.find((price) => typeof price?.currency === 'string' && price.currency.toLowerCase() === 'usd');

  if (!usdPrice || typeof usdPrice.value !== 'string') {
    return null;
  }

  const parsed = Number(usdPrice.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function findUsdPriceFromEntry(entry) {
  return findUsdPrice(entry?.prices ?? entry?.tokenPrices);
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeTokenSymbol(symbol) {
  if (typeof symbol !== 'string') {
    return null;
  }

  const normalizedSymbol = symbol.trim().toUpperCase();
  return normalizedSymbol === '' ? null : normalizedSymbol;
}

async function fetchCoinGeckoEthUsdPrice() {
  holdingsProviderLogger.info(
    {
      pricingTarget: 'ETH',
      priceSource: 'coingecko'
    },
    'CoinGecko ETH fallback attempted'
  );

  const response = await fetch(`${COINGECKO_SIMPLE_PRICE_URL}?ids=ethereum&vs_currencies=usd`);
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(`CoinGecko ETH price request failed with status ${response.status}`);
    error.status = response.status;
    error.responseBody = data;
    throw error;
  }

  const usdPrice = data?.ethereum?.usd;

  if (typeof usdPrice !== 'number' || !Number.isFinite(usdPrice)) {
    const error = new Error('CoinGecko ETH price response did not contain a usable usd value.');
    error.responseBody = data;
    throw error;
  }

  holdingsProviderLogger.info(
    {
      pricingTarget: 'ETH',
      priceSource: 'coingecko',
      usdPrice
    },
    'CoinGecko ETH fallback succeeded'
  );

  return usdPrice;
}

function shouldSkipPrePricingForHolding(holding) {
  const { missingIdentity, symbolLooksWeak, nameLooksWeak, missingLogo } = hasWeakMetadata(holding);
  const numericBalance = Number(holding.balance);
  const isTinyBalance = Number.isFinite(numericBalance) && Math.abs(numericBalance) < 0.000001;

  return (
    (missingIdentity && missingLogo) ||
    (symbolLooksWeak && nameLooksWeak && missingLogo) ||
    (isTinyBalance && (missingIdentity || missingLogo))
  );
}

async function fetchNativeEthUsdPrice(apiKey, chainId) {
  const ethCacheKey = buildEthCacheKey(chainId);
  const cachedEntry = getPriceCacheEntry(ethCacheKey);

  if (cachedEntry) {
    logHoldingsInfo(
      {
        cacheKey: ethCacheKey,
        pricingTarget: 'ETH',
        priceSource: 'fresh-cache'
      },
      'ETH pricing cache hit'
    );
    return cachedEntry.value;
  }

  if (shouldSkipLiveAlchemyPricing()) {
    logAlchemyPricingCooldownActive({ pricingTarget: 'ETH' });
    const fallback = getLastSuccessfulEthPriceFallback();

    if (fallback) {
      holdingsProviderLogger.info(
        {
          pricingTarget: 'ETH',
          priceSource: 'stale-cache',
          lastSuccessfulEthPriceAt: fallback.lastUpdatedAt
        },
        'Stale ETH price reused during pricing cooldown'
      );

      return fallback.value;
    }
  }

  const query = new URLSearchParams();
  query.append('symbols', 'ETH');

  try {
    const response = await createInFlightPricePromise(ethCacheKey, () =>
      enqueuePricingRequest(() =>
        fetchJson(`${ALCHEMY_PRICES_BASE_URL}/${apiKey}/tokens/by-symbol?${query.toString()}`, {
          headers: {
            Authorization: `Bearer ${apiKey}`
          }
        })
      )
    );
    const priceEntry = Array.isArray(response?.data) ? response.data[0] : null;
    const usdPrice = findUsdPriceFromEntry(priceEntry);

    if (usdPrice != null) {
      rememberSuccessfulEthPrice(usdPrice, 'alchemy');
      return usdPrice;
    }

    holdingsProviderLogger.warn(
      {
        pricingReason: 'malformed_or_missing_eth_price_response',
        priceSource: 'alchemy'
      },
      'Alchemy native ETH pricing response did not contain a usable USD price'
    );
  } catch (error) {
    const pricingReason = error?.rateLimited ? 'rate_limited' : 'pricing_unavailable';

    if (error?.rateLimited) {
      startAlchemyPricingCooldown({
        pricingTarget: 'ETH',
        status: error?.status ?? null
      });
    }

    holdingsProviderLogger.warn(
      {
        status: error?.status ?? null,
        pricingReason,
        priceSource: 'alchemy'
      },
      'Alchemy native ETH pricing request failed'
    );
  }

  try {
    const coinGeckoPrice = await fetchCoinGeckoEthUsdPrice();
    rememberSuccessfulEthPrice(coinGeckoPrice, 'coingecko');
    return coinGeckoPrice;
  } catch (coinGeckoError) {
    holdingsProviderLogger.warn(
      {
        pricingTarget: 'ETH',
        priceSource: 'coingecko',
        status: coinGeckoError?.status ?? null
      },
      'CoinGecko ETH fallback failed'
    );
  }

  const fallback = getLastSuccessfulEthPriceFallback();

  if (fallback) {
    holdingsProviderLogger.info(
      {
        pricingTarget: 'ETH',
        priceSource: 'stale-cache',
        lastSuccessfulEthPriceAt: fallback.lastUpdatedAt
      },
      'Stale ETH price reused after live pricing fallbacks failed'
    );

    return fallback.value;
  }

  holdingsProviderLogger.warn(
    {
      pricingTarget: 'ETH',
      priceSource: 'null'
    },
    'ETH price unavailable after Alchemy and CoinGecko attempts'
  );

  return null;
}

async function fetchErc20PricesByAddress(apiKey, chainId, holdings) {
  const addressHoldings = holdings.filter((holding) => typeof holding.tokenAddress === 'string');
  const chainConfig = getChainConfigById(chainId);

  if (addressHoldings.length === 0) {
    return {
      priceMap: new Map(),
      reasonMap: new Map()
    };
  }

  if (!chainConfig?.alchemyPricingNetwork) {
    return {
      priceMap: new Map(),
      reasonMap: new Map(
        addressHoldings.map((holding) => [holding.tokenAddress.toLowerCase(), 'unsupported_pricing_chain'])
      )
    };
  }

  const priceMap = new Map();
  const reasonMap = new Map();
  const uncachedAddressPayload = [];
  const waitForCacheKeys = [];

  for (const holding of addressHoldings) {
    const normalizedAddress = holding.tokenAddress.toLowerCase();
    const cacheKey = buildAddressCacheKey(chainId, normalizedAddress);
    const cachedEntry = getPriceCacheEntry(cacheKey);

    if (cachedEntry) {
      priceMap.set(normalizedAddress, cachedEntry.value);
      reasonMap.set(
        normalizedAddress,
        cachedEntry.value == null ? 'pricing_unavailable' : 'priced_by_address'
      );
      continue;
    }

    if (shouldSkipLiveAlchemyPricing()) {
      priceMap.set(normalizedAddress, null);
      reasonMap.set(normalizedAddress, 'rate_limited');
      continue;
    }

    if (inFlightPricePromises.has(cacheKey)) {
      waitForCacheKeys.push(cacheKey);
      continue;
    }

    uncachedAddressPayload.push({
      network: chainConfig.alchemyPricingNetwork,
      address: holding.tokenAddress
    });
  }

  if (shouldSkipLiveAlchemyPricing()) {
    logAlchemyPricingCooldownActive({
      pricingTarget: 'erc20_by_address',
      requestedTokenCount: addressHoldings.length
    });
  }

  if (uncachedAddressPayload.length === 0) {
    logHoldingsInfo(
      {
        pricingTarget: 'erc20_by_address',
        requestedTokenCount: addressHoldings.length,
        uncachedTokenCount: 0
      },
      'Live ERC-20 address pricing skipped due to cache, cooldown, or in-flight requests'
    );

    return {
      priceMap,
      reasonMap
    };
  }

  const chunks = chunkArray(
    uncachedAddressPayload,
    25
  );

  for (const chunk of chunks) {
    const cacheKeys = chunk.map((item) => buildAddressCacheKey(chainId, item.address));
    const chunkFetchPromise = (async () => {
      const response = await enqueuePricingRequest(() =>
        fetchJson(`${ALCHEMY_PRICES_BASE_URL}/${apiKey}/tokens/by-address`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            addresses: chunk
          })
        })
      );

      const entries = Array.isArray(response?.data) ? response.data : [];

      for (const entry of entries) {
        if (typeof entry?.address !== 'string') {
          continue;
        }

        const normalizedAddress = entry.address.toLowerCase();
        const usdPrice = findUsdPriceFromEntry(entry);

        logHoldingsInfo(
          {
            tokenAddress: normalizedAddress,
            rawPriceResponse: entry,
            usdPrice
          },
          'Resolved ERC-20 token price response from Alchemy'
        );

        setPriceCacheEntry(buildAddressCacheKey(chainId, normalizedAddress), usdPrice);
      }

      return entries;
    })();

    for (const cacheKey of cacheKeys) {
      inFlightPricePromises.set(cacheKey, chunkFetchPromise);
    }

    try {
      const entries = await chunkFetchPromise;

      for (const entry of entries) {
        if (typeof entry?.address !== 'string') {
          continue;
        }

        const normalizedAddress = entry.address.toLowerCase();
        const usdPrice = findUsdPriceFromEntry(entry);
        priceMap.set(normalizedAddress, usdPrice);

        if (usdPrice == null) {
          reasonMap.set(normalizedAddress, 'no_provider_coverage_by_address');
        } else {
          reasonMap.set(normalizedAddress, 'priced_by_address');
        }
      }
    } catch (error) {
      const pricingReason = error?.rateLimited ? 'rate_limited' : 'pricing_unavailable';

      if (error?.rateLimited) {
        startAlchemyPricingCooldown({
          pricingTarget: 'erc20_by_address',
          status: error?.status ?? null,
          chunkSize: chunk.length
        });
      }

      holdingsProviderLogger.warn(
        {
          status: error?.status ?? null,
          chunkSize: chunk.length,
          pricingReason
        },
        'Alchemy ERC-20 address pricing unavailable; returning unpriced token balances'
      );

      for (const item of chunk) {
        const normalizedAddress = item.address.toLowerCase();
        priceMap.set(normalizedAddress, null);
        reasonMap.set(normalizedAddress, pricingReason);
        setPriceCacheEntry(buildAddressCacheKey(chainId, normalizedAddress), null);
      }

      continue;
    } finally {
      for (const cacheKey of cacheKeys) {
        inFlightPricePromises.delete(cacheKey);
      }
    }
  }

  for (const cacheKey of waitForCacheKeys) {
    try {
      await inFlightPricePromises.get(cacheKey);
    } catch {
      // The originating request already logged the pricing failure.
    }

    const normalizedAddress = cacheKey.split(':').at(-1);
    const cachedEntry = normalizedAddress ? getPriceCacheEntry(cacheKey) : null;

    if (!normalizedAddress) {
      continue;
    }

    priceMap.set(normalizedAddress, cachedEntry?.value ?? null);
    reasonMap.set(
      normalizedAddress,
      cachedEntry?.value == null ? 'pricing_unavailable' : 'priced_by_address'
    );
  }

  for (const holding of addressHoldings) {
    const normalizedAddress = holding.tokenAddress.toLowerCase();

    if (!reasonMap.has(normalizedAddress)) {
      reasonMap.set(normalizedAddress, 'address_not_returned_by_provider');
      setPriceCacheEntry(buildAddressCacheKey(chainId, normalizedAddress), null);
    }
  }

  return {
    priceMap,
    reasonMap
  };
}

async function fetchErc20PricesBySymbol(apiKey, chainId, holdings) {
  if (chainId !== ETHEREUM_MAINNET_CHAIN_ID) {
    const reasonMap = new Map();

    for (const holding of holdings) {
      const normalizedSymbol = normalizeTokenSymbol(holding.symbol);

      if (normalizedSymbol) {
        reasonMap.set(normalizedSymbol, 'symbol_fallback_disabled_for_chain');
      }
    }

    return {
      priceMap: new Map(),
      reasonMap
    };
  }

  const pricedBySymbol = new Map();
  const symbolReasonMap = new Map();
  const waitForSymbolCacheKeys = [];
  const uniqueSymbols = [
    ...new Set(
      holdings
        .map((holding) => normalizeTokenSymbol(holding.symbol))
        .filter(Boolean)
    )
  ];

  if (uniqueSymbols.length === 0) {
    return {
      priceMap: pricedBySymbol,
      reasonMap: symbolReasonMap
    };
  }

  const uncachedSymbols = [];

  for (const symbol of uniqueSymbols) {
    const cacheKey = buildSymbolCacheKey(chainId, symbol);
    const cachedEntry = getPriceCacheEntry(cacheKey);

    if (cachedEntry) {
      pricedBySymbol.set(symbol, cachedEntry.value);
      symbolReasonMap.set(
        symbol,
        cachedEntry.value == null ? 'pricing_unavailable' : 'priced_by_symbol'
      );
      continue;
    }

    if (shouldSkipLiveAlchemyPricing()) {
      pricedBySymbol.set(symbol, null);
      symbolReasonMap.set(symbol, 'rate_limited');
      continue;
    }

    if (inFlightPricePromises.has(cacheKey)) {
      waitForSymbolCacheKeys.push(cacheKey);
      continue;
    }

    uncachedSymbols.push(symbol);
  }

  if (shouldSkipLiveAlchemyPricing()) {
    logAlchemyPricingCooldownActive({
      pricingTarget: 'erc20_by_symbol',
      requestedSymbolCount: uniqueSymbols.length
    });
  }

  if (uncachedSymbols.length === 0) {
    logHoldingsInfo(
      {
        pricingTarget: 'erc20_by_symbol',
        requestedSymbolCount: uniqueSymbols.length,
        uncachedSymbolCount: 0
      },
      'Live ERC-20 symbol pricing skipped due to cache, cooldown, or in-flight requests'
    );

    return {
      priceMap: pricedBySymbol,
      reasonMap: symbolReasonMap
    };
  }

  const chunks = chunkArray(uncachedSymbols, 25);

  for (const chunk of chunks) {
    const query = new URLSearchParams();

    for (const symbol of chunk) {
      query.append('symbols', symbol);
    }

    const cacheKeys = chunk.map((symbol) => buildSymbolCacheKey(chainId, symbol));
    const chunkFetchPromise = (async () => {
      const response = await enqueuePricingRequest(() =>
        fetchJson(`${ALCHEMY_PRICES_BASE_URL}/${apiKey}/tokens/by-symbol?${query.toString()}`, {
          headers: {
            Authorization: `Bearer ${apiKey}`
          }
        })
      );

      const entries = Array.isArray(response?.data) ? response.data : [];

      for (const entry of entries) {
        const normalizedSymbol = normalizeTokenSymbol(entry?.symbol);

        if (!normalizedSymbol) {
          continue;
        }

        const usdPrice = findUsdPriceFromEntry(entry);

        logHoldingsInfo(
          {
            symbol: normalizedSymbol,
            rawPriceResponse: entry,
            usdPrice
          },
          'Resolved ERC-20 token price response from Alchemy symbol fallback'
        );

        setPriceCacheEntry(buildSymbolCacheKey(chainId, normalizedSymbol), usdPrice);
      }

      return entries;
    })();

    for (const cacheKey of cacheKeys) {
      inFlightPricePromises.set(cacheKey, chunkFetchPromise);
    }

    try {
      const entries = await chunkFetchPromise;

      for (const entry of entries) {
        const normalizedSymbol = normalizeTokenSymbol(entry?.symbol);

        if (!normalizedSymbol) {
          continue;
        }

        const usdPrice = findUsdPriceFromEntry(entry);
        pricedBySymbol.set(normalizedSymbol, usdPrice);
        symbolReasonMap.set(
          normalizedSymbol,
          usdPrice == null ? 'no_provider_coverage_by_symbol' : 'priced_by_symbol'
        );
      }
    } catch (error) {
      const pricingReason = error?.rateLimited ? 'rate_limited' : 'pricing_unavailable';

      if (error?.rateLimited) {
        startAlchemyPricingCooldown({
          pricingTarget: 'erc20_by_symbol',
          status: error?.status ?? null,
          chunkSize: chunk.length
        });
      }

      holdingsProviderLogger.warn(
        {
          status: error?.status ?? null,
          chunkSize: chunk.length,
          pricingReason
        },
        'Alchemy ERC-20 symbol pricing unavailable; returning unpriced token balances'
      );

      for (const symbol of chunk) {
        pricedBySymbol.set(symbol, null);
        symbolReasonMap.set(symbol, pricingReason);
        setPriceCacheEntry(buildSymbolCacheKey(chainId, symbol), null);
      }

      continue;
    } finally {
      for (const cacheKey of cacheKeys) {
        inFlightPricePromises.delete(cacheKey);
      }
    }
  }

  for (const cacheKey of waitForSymbolCacheKeys) {
    try {
      await inFlightPricePromises.get(cacheKey);
    } catch {
      // The originating request already logged the pricing failure.
    }

    const symbol = cacheKey.split(':').at(-1);
    const cachedEntry = symbol ? getPriceCacheEntry(cacheKey) : null;

    if (!symbol) {
      continue;
    }

    pricedBySymbol.set(symbol, cachedEntry?.value ?? null);
    symbolReasonMap.set(
      symbol,
      cachedEntry?.value == null ? 'pricing_unavailable' : 'priced_by_symbol'
    );
  }

  for (const symbol of uniqueSymbols) {
    if (!symbolReasonMap.has(symbol)) {
      symbolReasonMap.set(symbol, 'symbol_not_returned_by_provider');
      setPriceCacheEntry(buildSymbolCacheKey(chainId, symbol), null);
    }
  }

  return {
    priceMap: pricedBySymbol,
    reasonMap: symbolReasonMap
  };
}

function attachUsdPricing(holding, priceUsd) {
  if (priceUsd == null) {
    return {
      ...holding,
      balanceUsd: null
    };
  }

  const numericBalance = Number(holding.balance);

  if (!Number.isFinite(numericBalance)) {
    return {
      ...holding,
      balanceUsd: null
    };
  }

  return {
    ...holding,
    balanceUsd: numericBalance * priceUsd
  };
}

function hasWeakMetadata(holding) {
  const normalizedSymbol = normalizeTokenSymbol(holding.symbol);
  const normalizedName = normalizeString(holding.name);
  const missingIdentity = !normalizedSymbol || !normalizedName;
  const symbolLooksWeak =
    !normalizedSymbol ||
    normalizedSymbol.length > 12 ||
    /[^A-Z0-9.\-]/.test(normalizedSymbol) ||
    normalizedSymbol === 'UNKNOWN';
  const nameLooksWeak =
    !normalizedName ||
    normalizedName.length < 2 ||
    normalizedName.length > 50 ||
    (!!holding.tokenAddress && normalizedName.toLowerCase() === holding.tokenAddress.toLowerCase());

  return {
    missingIdentity,
    symbolLooksWeak,
    nameLooksWeak,
    missingLogo: !normalizeString(holding.logoUrl)
  };
}

function evaluateSuspicion(holding, pricingReason) {
  const reasons = [];
  const numericBalance = Number(holding.balance);
  const numericValueUsd =
    typeof holding.balanceUsd === 'number' && Number.isFinite(holding.balanceUsd) ? holding.balanceUsd : null;
  const { missingIdentity, symbolLooksWeak, nameLooksWeak, missingLogo } = hasWeakMetadata(holding);

  if (holding.tokenAddress == null) {
    return {
      isSuspicious: false,
      suspicionReasons: reasons
    };
  }

  if (numericValueUsd != null && numericValueUsd >= 10_000 && (missingIdentity || symbolLooksWeak || nameLooksWeak)) {
    reasons.push('high_usd_value_with_weak_metadata');
  }

  if (
    numericValueUsd != null &&
    numericBalance > 0 &&
    Number.isFinite(numericBalance) &&
    (numericBalance >= 1_000_000_000 || numericValueUsd / numericBalance > 1_000_000)
  ) {
    reasons.push('unrealistic_balance_to_value_ratio');
  }

  if (pricingReason === 'priced_by_symbol_fallback' && numericValueUsd != null && numericValueUsd >= 50) {
    reasons.push('symbol_fallback_price_without_address_price');
  }

  if (missingIdentity && missingLogo) {
    reasons.push('missing_core_token_metadata');
  } else if (symbolLooksWeak || nameLooksWeak) {
    reasons.push('low_quality_token_metadata');
  }

    if (
      numericValueUsd == null &&
    ['no_provider_coverage_by_address', 'address_not_returned_by_provider', 'no_provider_coverage_by_symbol', 'symbol_not_returned_by_provider', 'missing_symbol_for_fallback', 'rate_limited', 'pricing_unavailable'].includes(pricingReason)
  ) {
    reasons.push('unpriced_or_inconsistently_priced');
  }

  return {
    isSuspicious: reasons.length > 0,
    suspicionReasons: reasons
  };
}

export async function fetchWalletHoldingsForChain(wallet, chainId = wallet.chainId) {
  const chainWallet = {
    ...wallet,
    chainId
  };
  const alchemyProvider = getAlchemyProvider(chainWallet.chainId);
  const alchemyApiKey = extractAlchemyApiKey(chainWallet.chainId);
  const [nativeBalance, tokenBalanceResult] = await Promise.all([
    alchemyProvider.getBalance(chainWallet.address),
    fetchAllErc20Balances(alchemyProvider, chainWallet.chainId, chainWallet.address)
  ]);
  const tokenBalances = tokenBalanceResult.tokenBalances;

  const erc20Holdings = (
    await Promise.all(
      tokenBalances.map(async (tokenBalance) => {
        const metadata = await fetchTokenMetadataWithCache(
          alchemyProvider,
          chainWallet.chainId,
          tokenBalance.contractAddress
        );

        return mapHolding({
          contractAddress: tokenBalance.contractAddress,
          tokenBalance: tokenBalance.tokenBalance,
          metadata
        });
      })
    )
  )
    .filter(Boolean)
    .sort((left, right) => {
      if (left.symbol && right.symbol) {
        return left.symbol.localeCompare(right.symbol);
      }

      return left.tokenAddress.localeCompare(right.tokenAddress);
    });

  const nativeHolding = buildNativeHolding(chainWallet.chainId, nativeBalance);
  const baseHoldings = [nativeHolding, ...erc20Holdings].filter(Boolean);
  const erc20PricingCandidates = erc20Holdings.filter((holding) => !shouldSkipPrePricingForHolding(holding));
  const prefilteredPricingSkippedCount = erc20Holdings.length - erc20PricingCandidates.length;

  logHoldingsInfo(
    {
      walletId: wallet.id,
      chainId: chainWallet.chainId,
      totalErc20Holdings: erc20Holdings.length,
      pricingCandidateCount: erc20PricingCandidates.length,
      prefilteredPricingSkippedCount
    },
    'Selected ERC-20 tokens for pricing'
  );

  const [nativeEthUsdPrice, erc20AddressPricing] = await Promise.all([
    fetchNativeEthUsdPrice(alchemyApiKey, chainWallet.chainId).catch((error) => {
      const pricingReason = error?.rateLimited ? 'rate_limited' : 'pricing_unavailable';
      holdingsProviderLogger.warn(
        {
          status: error?.status ?? null,
          pricingReason
        },
        'Alchemy native ETH pricing unavailable; returning native balance without USD price'
      );
      return null;
    }),
    fetchErc20PricesByAddress(alchemyApiKey, chainWallet.chainId, erc20PricingCandidates).catch((error) => {
      const pricingReason = error?.rateLimited ? 'rate_limited' : 'pricing_unavailable';
      holdingsProviderLogger.warn(
        {
          status: error?.status ?? null,
          pricingReason
        },
        'Alchemy ERC-20 pricing unavailable; returning token balances without USD prices'
      );
      return {
        priceMap: new Map(),
        reasonMap: new Map()
      };
    })
  ]);
  const unpricedErc20Holdings = erc20PricingCandidates.filter((holding) => {
    const normalizedAddress = holding.tokenAddress?.toLowerCase();

    if (!normalizedAddress) {
      return false;
    }

    return (erc20AddressPricing.priceMap.get(normalizedAddress) ?? null) == null;
  });
  const erc20SymbolPricing = await fetchErc20PricesBySymbol(alchemyApiKey, chainWallet.chainId, unpricedErc20Holdings).catch((error) => {
    const pricingReason = error?.rateLimited ? 'rate_limited' : 'pricing_unavailable';
    holdingsProviderLogger.warn(
      {
        status: error?.status ?? null,
        pricingReason
      },
      'Alchemy ERC-20 symbol fallback pricing unavailable; returning token balances without USD prices'
    );
    return {
      priceMap: new Map(),
      reasonMap: new Map()
    };
  });

  const holdings = baseHoldings.map((holding) => {
    if (holding.tokenAddress == null) {
      const pricedHolding = attachUsdPricing(holding, nativeEthUsdPrice);

      logHoldingsInfo(
        {
          tokenAddress: holding.tokenAddress,
          symbol: holding.symbol,
          rawPriceResponse: { symbol: 'ETH', usdPrice: nativeEthUsdPrice },
          balanceUsd: pricedHolding.balanceUsd
        },
        'Computed holding USD balance'
      );

      return {
        ...pricedHolding,
        chainId: chainWallet.chainId
      };
    }

    const normalizedTokenAddress = holding.tokenAddress.toLowerCase();
    const normalizedSymbol = normalizeTokenSymbol(holding.symbol);
    const addressPrice = erc20AddressPricing.priceMap.get(normalizedTokenAddress) ?? null;
    const symbolPrice = normalizedSymbol ? erc20SymbolPricing.priceMap.get(normalizedSymbol) ?? null : null;
    const usdPrice = addressPrice ?? symbolPrice;
    const pricedHolding = attachUsdPricing(holding, usdPrice);
    const pricingReason =
      addressPrice != null
        ? 'priced_by_address'
        : symbolPrice != null
          ? 'priced_by_symbol_fallback'
          : erc20AddressPricing.reasonMap.get(normalizedTokenAddress)
            ?? (normalizedSymbol ? erc20SymbolPricing.reasonMap.get(normalizedSymbol) : null)
            ?? (shouldSkipPrePricingForHolding(holding) ? 'prefiltered_suspicious_candidate' : null)
            ?? (!normalizedSymbol ? 'missing_symbol_for_fallback' : 'unknown_pricing_gap');
    const suspicion = evaluateSuspicion(pricedHolding, pricingReason);
    const finalizedHolding = {
      ...pricedHolding,
      chainId: chainWallet.chainId,
      isSuspicious: suspicion.isSuspicious,
      suspicionReasons: suspicion.suspicionReasons
    };

    logHoldingsInfo(
      {
        tokenAddress: normalizedTokenAddress,
        symbol: holding.symbol,
        rawPriceResponse: {
          addressPrice,
          symbolPrice,
          pricingReason
        },
        balanceUsd: finalizedHolding.balanceUsd,
        isSuspicious: finalizedHolding.isSuspicious,
        suspicionReasons: finalizedHolding.suspicionReasons
      },
      'Computed holding USD balance'
    );

    if (finalizedHolding.balanceUsd == null) {
      logHoldingsWarn(
        {
          tokenAddress: normalizedTokenAddress,
          symbol: holding.symbol,
          name: holding.name,
          pricingReason
        },
        'Token remains unpriced after all pricing lookups'
      );
    }

    if (finalizedHolding.isSuspicious) {
      logHoldingsWarn(
        {
          tokenAddress: normalizedTokenAddress,
          symbol: holding.symbol,
          name: holding.name,
          suspicionReasons: finalizedHolding.suspicionReasons,
          pricingReason
        },
        'Token flagged as suspicious by holdings heuristics'
      );
    }

    return finalizedHolding;
  });

  const totalBalanceUsd = holdings.reduce((sum, holding) => {
    if (holding.balanceUsd == null || holding.isSuspicious) {
      return sum;
    }

    return sum + holding.balanceUsd;
  }, 0);
  const hasAnyHoldings = holdings.length > 0;
  const hasPricedNonSuspiciousHoldings = holdings.some(
    (holding) =>
      typeof holding.balanceUsd === 'number' &&
      Number.isFinite(holding.balanceUsd) &&
      !holding.isSuspicious
  );

  const result = {
    walletId: chainWallet.id,
    chainId: chainWallet.chainId,
    totalBalanceUsd: !hasAnyHoldings
      ? 0
      : hasPricedNonSuspiciousHoldings
        ? totalBalanceUsd
        : null,
    holdings,
    tokenBalancesAvailable: tokenBalanceResult.tokenBalancesAvailable,
    tokenBalancesReason: tokenBalanceResult.tokenBalancesReason
  };

  holdingsProviderLogger.info(
    {
      walletId: wallet.id,
      chainId: chainWallet.chainId,
      holdingsCount: holdings.length,
      pricedHoldingsCount: holdings.filter(
        (holding) => typeof holding.balanceUsd === 'number' && Number.isFinite(holding.balanceUsd)
      ).length,
      suspiciousCount: holdings.filter((holding) => holding.isSuspicious).length,
      totalBalanceUsd: result.totalBalanceUsd,
      tokenBalancesAvailable: result.tokenBalancesAvailable,
      tokenBalancesReason: result.tokenBalancesReason
    },
    'Computed wallet holdings summary'
  );

  return result;
}

export async function fetchWalletHoldings(wallet) {
  return fetchWalletHoldingsForChain(wallet, wallet.chainId);
}

export async function fetchEthereumMainnetHoldings(wallet) {
  return fetchWalletHoldings(wallet);
}
