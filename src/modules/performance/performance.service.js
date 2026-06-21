import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../config/logger.js';
import { findWalletById, findWalletByIdOnly, listWalletsByUserId, listWalletsForSnapshotJob } from '../wallets/wallets.repository.js';
import { getWalletPortfolioSummary } from '../portfolioSummary/portfolioSummary.service.js';
import {
  findLatestSnapshotAtOrBefore,
  findLatestSnapshotsAtOrBefore,
  insertWalletPortfolioSnapshot
} from './performance.repository.js';

const performanceLogger = logger.child({ module: 'portfolio-performance' });
const SUPPORTED_CHAIN_ID = 'ethereum-mainnet';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function buildUnavailablePerformanceResult({ currentValue, reason = 'LIVE_PORTFOLIO_VALUATION_UNAVAILABLE', isPartial = false, snapshot }) {
  return {
    currentValue: typeof currentValue === 'number' && Number.isFinite(currentValue) ? currentValue : null,
    value24hAgo: snapshot?.totalUsd ?? null,
    change: null,
    changePercent: null,
    isAvailable: false,
    isPartial,
    reason
  };
}

function buildPerformanceResult(summary, snapshot) {
  const currentValue = summary?.totalPortfolioUsd;

  if (summary?.isPartial) {
    return buildUnavailablePerformanceResult({
      currentValue,
      reason: summary.reason ?? 'LIVE_PORTFOLIO_VALUATION_PARTIAL',
      isPartial: true,
      snapshot
    });
  }

  if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) {
    return buildUnavailablePerformanceResult({
      currentValue,
      reason: 'LIVE_PORTFOLIO_VALUATION_UNAVAILABLE',
      isPartial: false,
      snapshot
    });
  }

  if (!snapshot) {
    return {
      currentValue,
      value24hAgo: null,
      change: null,
      changePercent: null,
      isAvailable: false,
      isPartial: false,
      reason: 'INSUFFICIENT_HISTORY'
    };
  }

  const value24hAgo = snapshot.totalUsd;
  const change = currentValue - value24hAgo;
  const changePercent = value24hAgo > 0 ? Number(((change / value24hAgo) * 100).toFixed(2)) : null;

  return {
    currentValue,
    value24hAgo,
    change: Number(change.toFixed(2)),
    changePercent,
    isAvailable: true,
    isPartial: false,
    reason: null
  };
}

export async function getWalletPerformance(walletId, userId) {
  const wallet = await findWalletById(walletId, userId);

  if (!wallet) {
    throw new HttpError(404, 'WALLET_NOT_FOUND', 'Tracked wallet not found.');
  }

  if (wallet.chainId !== SUPPORTED_CHAIN_ID) {
    throw new HttpError(400, 'UNSUPPORTED_PERFORMANCE_CHAIN', 'Wallet performance is currently supported only for ethereum-mainnet.');
  }

  const summary = await getWalletPortfolioSummary(walletId);
  const cutoff = new Date(Date.now() - ONE_DAY_MS).toISOString();
  const snapshot = await findLatestSnapshotAtOrBefore(walletId, cutoff);

  return buildPerformanceResult(summary, snapshot);
}

export async function getAggregatedPortfolioPerformance(userId) {
  const wallets = await listWalletsByUserId(userId);
  const supportedWallets = wallets.filter((wallet) => wallet.chainId === SUPPORTED_CHAIN_ID);

  if (supportedWallets.length === 0) {
    return {
      currentValue: 0,
      value24hAgo: null,
      change: null,
      changePercent: null,
      isAvailable: false,
      isPartial: false,
      reason: 'NO_SUPPORTED_WALLETS'
    };
  }

  const summaries = await Promise.all(
    supportedWallets.map((wallet) => getWalletPortfolioSummary(wallet.id))
  );

  const validCurrentValues = summaries
    .map((summary) => summary.totalPortfolioUsd)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const currentValue = validCurrentValues.length > 0
    ? Number(validCurrentValues.reduce((sum, value) => sum + value, 0).toFixed(2))
    : null;
  const hasPartialSummary = summaries.some((summary) => summary.isPartial);

  const cutoff = new Date(Date.now() - ONE_DAY_MS).toISOString();
  const snapshots = await findLatestSnapshotsAtOrBefore(
    supportedWallets.map((wallet) => wallet.id),
    cutoff
  );

  if (hasPartialSummary) {
    return buildUnavailablePerformanceResult({
      currentValue,
      reason: 'PARTIAL_PORTFOLIO_VALUATION',
      isPartial: true,
      snapshot: null
    });
  }

  if (currentValue == null || snapshots.length !== supportedWallets.length) {
    return buildUnavailablePerformanceResult({
      currentValue,
      reason: currentValue == null ? 'LIVE_PORTFOLIO_VALUATION_UNAVAILABLE' : 'INSUFFICIENT_HISTORY',
      isPartial: false,
      snapshot: null
    });
  }

  const value24hAgo = Number(
    snapshots.reduce((sum, snapshot) => sum + snapshot.totalUsd, 0).toFixed(2)
  );
  const change = Number((currentValue - value24hAgo).toFixed(2));
  const changePercent = value24hAgo > 0 ? Number((((currentValue - value24hAgo) / value24hAgo) * 100).toFixed(2)) : null;

  return {
    currentValue,
    value24hAgo,
    change,
    changePercent,
    isAvailable: true,
    isPartial: false,
    reason: null
  };
}

export async function captureWalletPortfolioSnapshot(wallet) {
  if (wallet.chainId !== SUPPORTED_CHAIN_ID) {
    return null;
  }

  const summary = await getWalletPortfolioSummary(wallet.id);
  const capturedAt = new Date().toISOString();

  if (summary.isPartial || typeof summary.totalPortfolioUsd !== 'number' || !Number.isFinite(summary.totalPortfolioUsd)) {
    performanceLogger.warn(
      {
        walletId: wallet.id,
        chainId: wallet.chainId,
        reason: summary.reason ?? 'LIVE_PORTFOLIO_VALUATION_UNAVAILABLE'
      },
      'Skipped wallet portfolio snapshot because live portfolio total is unavailable'
    );

    return null;
  }

  return insertWalletPortfolioSnapshot({
    walletId: wallet.id,
    chainId: wallet.chainId,
    totalUsd: summary.totalPortfolioUsd,
    holdingsUsd: summary.holdingsTotalUsd ?? 0,
    positionsUsd: summary.positionsTotalUsd ?? 0,
    capturedAt
  });
}

export async function captureAllWalletPortfolioSnapshots() {
  const wallets = await listWalletsForSnapshotJob();
  let insertedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const wallet of wallets) {
    if (wallet.chainId !== SUPPORTED_CHAIN_ID) {
      skippedCount += 1;
      continue;
    }

    try {
      const insertedSnapshot = await captureWalletPortfolioSnapshot(wallet);

      if (insertedSnapshot) {
        insertedCount += 1;
      } else {
        skippedCount += 1;
      }
    } catch (error) {
      failedCount += 1;
      performanceLogger.error(
        { err: error, walletId: wallet.id, chainId: wallet.chainId },
        'Failed to capture wallet portfolio snapshot'
      );
    }
  }

  performanceLogger.info(
    {
      totalWallets: wallets.length,
      insertedCount,
      skippedCount,
      failedCount
    },
    'Completed wallet portfolio snapshot capture cycle'
  );

  return { totalWallets: wallets.length, insertedCount, skippedCount, failedCount };
}
