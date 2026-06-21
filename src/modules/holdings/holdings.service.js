import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../config/logger.js';
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID } from '../chains/chains.config.js';
import { findWalletByIdOnly } from '../wallets/wallets.repository.js';
import { fetchWalletHoldings } from './holdings.provider.js';

const holdingsLogger = logger.child({ module: 'holdings-service' });
const HOLDINGS_CACHE_TTL_MS = 15 * 1000;
const DEGRADED_HOLDINGS_CACHE_TTL_MS = 5 * 1000;
const holdingsCache = new Map();
const inFlightHoldingsPromises = new Map();

function buildHoldingsCacheKey(wallet) {
  return `${wallet.chainId}:${wallet.id}`;
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

function isDegradedHoldingsResult(holdings) {
  return (
    holdings?.tokenBalancesAvailable === false ||
    holdings?.tokenBalancesReason != null ||
    holdings?.totalBalanceUsd == null
  );
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

export async function getWalletHoldings(walletId) {
  const wallet = await findWalletByIdOnly(walletId);

  if (!wallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  if (!supportsHoldingsForChain(wallet.chainId)) {
    throw new HttpError(
      400,
      'UNSUPPORTED_HOLDINGS_CHAIN',
      'Wallet holdings are currently supported only for ethereum-mainnet and base-mainnet.'
    );
  }

  const cacheKey = buildHoldingsCacheKey(wallet);
  const cachedHoldings = getCachedHoldings(cacheKey);

  if (cachedHoldings) {
    holdingsLogger.info(
      {
        cacheKey,
        walletId: wallet.id,
        chainId: wallet.chainId
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
        chainId: wallet.chainId
      },
      'Holdings in-flight request reused'
    );
    return existingPromise;
  }

  holdingsLogger.info(
    {
      cacheKey,
      walletId: wallet.id,
      chainId: wallet.chainId
    },
    'Holdings cache miss'
  );

  const holdingsPromise = Promise.resolve()
    .then(() => fetchWalletHoldings(wallet))
    .then((holdings) => {
      setCachedHoldings(cacheKey, holdings);
      return holdings;
    })
    .finally(() => {
      inFlightHoldingsPromises.delete(cacheKey);
    });

  inFlightHoldingsPromises.set(cacheKey, holdingsPromise);
  return holdingsPromise;
}
