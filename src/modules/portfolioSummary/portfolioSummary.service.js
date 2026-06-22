import { getWalletHoldings } from '../holdings/holdings.service.js';
import { getCachedWalletPositions, getWalletPositions } from '../positions/positions.service.js';
import { logger } from '../../config/logger.js';

const portfolioSummaryLogger = logger.child({ module: 'portfolio-summary' });
const PORTFOLIO_SUMMARY_CACHE_TTL_MS = 10 * 1000;
const PARTIAL_PORTFOLIO_SUMMARY_CACHE_TTL_MS = 2 * 1000;
const portfolioSummaryCache = new Map();
const inFlightPortfolioSummaryPromises = new Map();
const POSITIONS_NOT_FETCHED_LIST_MODE_REASON = 'POSITIONS_NOT_FETCHED_LIST_MODE';
const POSITIONS_UNSUPPORTED_CHAIN_REASON = 'POSITIONS_UNSUPPORTED_CHAIN';

function buildValuationReason({ hasAnyHoldings, hasAnyPositions, holdingsTotalUsd, positionsTotalUsd }) {
  const reasons = [];

  if (hasAnyHoldings && holdingsTotalUsd == null) {
    reasons.push('HOLDINGS_VALUATION_UNAVAILABLE');
  }

  if (hasAnyPositions && positionsTotalUsd == null) {
    reasons.push('POSITIONS_VALUATION_UNAVAILABLE');
  }

  return reasons.length > 0 ? reasons.join(',') : null;
}

function summarizePositions(positions) {
  const summary = positions.reduce((result, position) => {
    const hasPosition =
      typeof position?.amount === 'string' ||
      typeof position?.assetSymbol === 'string' ||
      typeof position?.assetName === 'string' ||
      typeof position?.protocolName === 'string';

    if (hasPosition) {
      result.hasAnyPositions = true;
    }

    if (typeof position.valueUsd !== 'number' || !Number.isFinite(position.valueUsd)) {
      return result;
    }

    result.hasAnyValuedPositions = true;
    result.totalUsd += position.valueUsd;
    return result;
  }, {
    totalUsd: 0,
    hasAnyPositions: false,
    hasAnyValuedPositions: false
  });

  return {
    totalUsd: summary.hasAnyValuedPositions ? summary.totalUsd : summary.hasAnyPositions ? null : 0,
    hasAnyPositions: summary.hasAnyPositions
  };
}

function buildPortfolioSummaryCacheKey(walletId, { includePositions = true } = {}) {
  return `${walletId}:includePositions=${includePositions ? 'true' : 'false'}`;
}

function getCachedPortfolioSummary(walletId, options) {
  const cacheKey = buildPortfolioSummaryCacheKey(walletId, options);
  const entry = portfolioSummaryCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    portfolioSummaryCache.delete(cacheKey);
    return null;
  }

  return entry.value;
}

function setCachedPortfolioSummary(walletId, summary, options) {
  const ttlMs = summary.isPartial
    ? PARTIAL_PORTFOLIO_SUMMARY_CACHE_TTL_MS
    : PORTFOLIO_SUMMARY_CACHE_TTL_MS;

  portfolioSummaryCache.set(buildPortfolioSummaryCacheKey(walletId, options), {
    value: summary,
    expiresAt: Date.now() + ttlMs
  });
}

function getOrCreateInFlightPortfolioSummaryPromise(walletId, options, factory) {
  const cacheKey = buildPortfolioSummaryCacheKey(walletId, options);
  const existingPromise = inFlightPortfolioSummaryPromises.get(cacheKey);

  if (existingPromise) {
    return existingPromise;
  }

  const nextPromise = Promise.resolve()
    .then(factory)
    .finally(() => {
      inFlightPortfolioSummaryPromises.delete(cacheKey);
    });

  inFlightPortfolioSummaryPromises.set(cacheKey, nextPromise);
  return nextPromise;
}

export async function getWalletPortfolioSummary(walletId, { includePositions = true } = {}) {
  const cachedSummary = getCachedPortfolioSummary(walletId, { includePositions });

  if (cachedSummary) {
    portfolioSummaryLogger.info({ walletId, includePositions }, 'Portfolio summary cache hit');
    return cachedSummary;
  }

  portfolioSummaryLogger.info({ walletId, includePositions }, 'Portfolio summary cache miss');

  return getOrCreateInFlightPortfolioSummaryPromise(walletId, { includePositions }, async () => {
    const holdingsPromise = getWalletHoldings(walletId);
    const positionsPromise = includePositions
      ? getWalletPositions(walletId)
      : getCachedWalletPositions(walletId);
    const [holdingsResult, positionsResult] = await Promise.allSettled([holdingsPromise, positionsPromise]);

    if (holdingsResult.status !== 'fulfilled') {
      throw holdingsResult.reason;
    }

    const holdings = holdingsResult.value;
    let positions = null;
    let positionsUnsupported = false;

    if (positionsResult.status === 'fulfilled') {
      positions = positionsResult.value;
    } else if (positionsResult.reason?.code === 'UNSUPPORTED_POSITIONS_CHAIN') {
      positionsUnsupported = true;
      portfolioSummaryLogger.info(
        { walletId, includePositions, chainId: holdings.chainId },
        'Positions are unsupported for this chain; continuing with holdings-only portfolio summary'
      );
    } else {
      throw positionsResult.reason;
    }

    const usedCachedPositions = !includePositions && positions != null;
    const positionItems = usedCachedPositions
      ? positions.positions ?? []
      : includePositions
        ? positions?.positions ?? []
        : [];
    const holdingsTotalUsd =
      typeof holdings.totalBalanceUsd === 'number' && Number.isFinite(holdings.totalBalanceUsd)
        ? holdings.totalBalanceUsd
        : null;
    const positionsSummary = summarizePositions(positionItems);
    const positionsTotalUsd = positionsUnsupported
      ? null
      : includePositions || usedCachedPositions
        ? positionsSummary.totalUsd
        : null;
    const hasAnyHoldings = Array.isArray(holdings.holdings) && holdings.holdings.length > 0;
    const hasAnyPositions = positionsUnsupported
      ? false
      : includePositions || usedCachedPositions
        ? positionsSummary.hasAnyPositions
        : false;
    const holdingsValuationAvailable = !hasAnyHoldings || holdingsTotalUsd != null;
    const positionsValuationAvailable = positionsUnsupported
      ? false
      : includePositions || usedCachedPositions
        ? !hasAnyPositions || positionsTotalUsd != null
        : false;
    const skippedFreshPositions = !includePositions && !usedCachedPositions;
    const isPartial =
      holdings.isPartial === true ||
      !holdingsValuationAvailable ||
      positionsUnsupported ||
      positions?.isPartial === true ||
      (includePositions && !positionsValuationAvailable) ||
      skippedFreshPositions;
    const reason = buildValuationReason({
      hasAnyHoldings,
      hasAnyPositions,
      holdingsTotalUsd,
      positionsTotalUsd
    });
    let normalizedReason = reason;

    if (positionsUnsupported) {
      normalizedReason = POSITIONS_UNSUPPORTED_CHAIN_REASON;
    } else if (positions?.isPartial) {
      normalizedReason = Array.isArray(positions.partialReasons) && positions.partialReasons.length > 0
        ? positions.partialReasons.join(',')
        : reason;
    } else if (!includePositions && usedCachedPositions) {
      normalizedReason = reason;
    } else if (skippedFreshPositions) {
      normalizedReason = POSITIONS_NOT_FETCHED_LIST_MODE_REASON;
    } else if (holdings.isPartial) {
      normalizedReason = Array.isArray(holdings.partialReasons) && holdings.partialReasons.length > 0
        ? holdings.partialReasons.join(',')
        : reason;
    }

    let totalPortfolioUsd = null;

    if (holdingsTotalUsd != null && positionsTotalUsd != null) {
      totalPortfolioUsd = holdingsTotalUsd + positionsTotalUsd;
    } else if (holdingsTotalUsd != null && includePositions) {
      totalPortfolioUsd = holdingsTotalUsd;
    } else if (holdingsTotalUsd != null && usedCachedPositions) {
      totalPortfolioUsd = holdingsTotalUsd;
    } else if (holdingsTotalUsd != null && skippedFreshPositions) {
      totalPortfolioUsd = holdingsTotalUsd;
    } else if (includePositions && positionsTotalUsd != null) {
      totalPortfolioUsd = positionsTotalUsd;
    } else if (usedCachedPositions && positionsTotalUsd != null) {
      totalPortfolioUsd = positionsTotalUsd;
    } else if (!hasAnyHoldings && (!includePositions || !hasAnyPositions || usedCachedPositions)) {
      totalPortfolioUsd = 0;
    }

    const summary = {
      walletId: holdings.walletId,
      chainId: holdings.chainId,
      holdingsTotalUsd,
      positionsTotalUsd,
      totalPortfolioUsd,
      holdingsValuationAvailable,
      positionsValuationAvailable,
      isPartial,
      reason: normalizedReason,
      enabledChains: Array.isArray(holdings.enabledChains) && holdings.enabledChains.length > 0
        ? holdings.enabledChains
        : [holdings.chainId]
    };

    setCachedPortfolioSummary(walletId, summary, { includePositions });

    portfolioSummaryLogger.info(
      {
        walletId,
        includePositions,
        usedCachedPositions,
        holdingsTotalUsd,
        positionsCount: Array.isArray(positionItems) ? positionItems.length : 0,
        positionsTotalUsd,
        totalPortfolioUsd,
        holdingsValuationAvailable,
        positionsValuationAvailable,
        isPartial,
        reason: normalizedReason
      },
      'Computed wallet portfolio summary'
    );

    if (summary.isPartial) {
      portfolioSummaryLogger.info(
        { walletId, includePositions, ttlMs: PARTIAL_PORTFOLIO_SUMMARY_CACHE_TTL_MS, reason: normalizedReason },
        'Cached partial portfolio summary with short TTL'
      );
    }

    return summary;
  });
}
