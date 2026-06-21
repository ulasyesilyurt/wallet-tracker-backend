import { logger } from '../config/logger.js';
import { pool } from '../db/pool.js';
import { query } from '../db/query.js';
import { listWalletsForSnapshotJob } from '../modules/wallets/wallets.repository.js';
import { getWalletPortfolioSummary } from '../modules/portfolioSummary/portfolioSummary.service.js';
import { insertWalletPortfolioSnapshot } from '../modules/performance/performance.repository.js';

const scriptLogger = logger.child({ module: 'seed-portfolio-snapshots' });
const ONE_HOUR_MS = 60 * 60 * 1000;
const HISTORY_WINDOW_START_HOURS = 26;
const HISTORY_WINDOW_END_HOURS = 24;
const SEEDED_SNAPSHOT_AGE_HOURS = 25;
const WALLET_SUMMARY_TIMEOUT_MS = 15_000;

function assertSafeEnvironment() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed:portfolio-snapshots is disabled in production.');
  }
}

function hashString(value) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function buildHistoricalTotals(summary, walletId) {
  const hash = hashString(walletId);
  const direction = hash % 2 === 0 ? -1 : 1;
  const percentageDelta = ((hash % 6) + 2) / 100;
  const factor = 1 + direction * percentageDelta;

  const holdingsUsd = Number((summary.holdingsTotalUsd * factor).toFixed(2));
  const positionsUsd = Number((summary.positionsTotalUsd * factor).toFixed(2));

  return {
    holdingsUsd,
    positionsUsd,
    totalUsd: Number((holdingsUsd + positionsUsd).toFixed(2)),
    percentageDelta
  };
}

async function clearSeedWindowSnapshots(walletIds) {
  if (walletIds.length === 0) {
    return 0;
  }

  const windowStart = new Date(Date.now() - HISTORY_WINDOW_START_HOURS * ONE_HOUR_MS).toISOString();
  const windowEnd = new Date(Date.now() - HISTORY_WINDOW_END_HOURS * ONE_HOUR_MS).toISOString();

  const result = await query(
    `
      DELETE FROM wallet_portfolio_snapshots
      WHERE wallet_id = ANY($1::uuid[])
        AND captured_at BETWEEN $2 AND $3
    `,
    [walletIds, windowStart, windowEnd]
  );

  return result.rowCount;
}

function formatUsd(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

async function getWalletPortfolioSummaryWithTimeout(walletId) {
  let timeoutId;

  try {
    return await Promise.race([
      getWalletPortfolioSummary(walletId),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Wallet portfolio summary exceeded ${WALLET_SUMMARY_TIMEOUT_MS}ms`));
        }, WALLET_SUMMARY_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function run() {
  assertSafeEnvironment();
  const previousSuppressHoldingsLogs = process.env.SUPPRESS_HOLDINGS_PROVIDER_LOGS;
  process.env.SUPPRESS_HOLDINGS_PROVIDER_LOGS = 'true';

  try {
    const wallets = await listWalletsForSnapshotJob();
    const activeWallets = wallets.filter((wallet) => wallet.chainId === 'ethereum-mainnet');

    scriptLogger.info(
      {
        walletCount: activeWallets.length
      },
      'Preparing to seed historical portfolio snapshots for development'
    );

    const deletedCount = await clearSeedWindowSnapshots(activeWallets.map((wallet) => wallet.id));
    let insertedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    scriptLogger.info(
      {
        deletedCount,
        seedWindowHours: [HISTORY_WINDOW_START_HOURS, HISTORY_WINDOW_END_HOURS]
      },
      'Cleared existing snapshots in the development seed window'
    );

    for (const [index, wallet] of activeWallets.entries()) {
      scriptLogger.info(
        {
          walletId: wallet.id,
          progress: `${index + 1}/${activeWallets.length}`
        },
        'Processing wallet for development portfolio snapshot seeding'
      );

      try {
        const summary = await getWalletPortfolioSummaryWithTimeout(wallet.id);
        const seededTotals = buildHistoricalTotals(summary, wallet.id);
        const capturedAt = new Date(Date.now() - SEEDED_SNAPSHOT_AGE_HOURS * ONE_HOUR_MS).toISOString();

        scriptLogger.info(
          {
            walletId: wallet.id,
            currentTotalUsd: formatUsd(summary.totalPortfolioUsd)
          },
          'Computed current portfolio total for wallet'
        );

        await insertWalletPortfolioSnapshot({
          walletId: wallet.id,
          chainId: wallet.chainId,
          totalUsd: seededTotals.totalUsd,
          holdingsUsd: seededTotals.holdingsUsd,
          positionsUsd: seededTotals.positionsUsd,
          capturedAt
        });

        insertedCount += 1;

        scriptLogger.info(
          {
            walletId: wallet.id,
            capturedAt,
            totalUsd: seededTotals.totalUsd
          },
          'Snapshot inserted'
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes(`exceeded ${WALLET_SUMMARY_TIMEOUT_MS}ms`)) {
          skippedCount += 1;

          scriptLogger.warn(
            {
              walletId: wallet.id,
              timeoutMs: WALLET_SUMMARY_TIMEOUT_MS
            },
            'Skipped wallet because portfolio summary computation exceeded timeout'
          );

          continue;
        }

        failedCount += 1;

        scriptLogger.error(
          {
            err: error,
            walletId: wallet.id
          },
          'Failed to seed development portfolio snapshot for wallet'
        );
      }
    }

    scriptLogger.info(
      {
        totalWallets: activeWallets.length,
        inserted: insertedCount,
        skipped: skippedCount,
        failed: failedCount
      },
      'Completed development portfolio snapshot seeding'
    );
  } catch (error) {
    scriptLogger.error({ err: error }, 'Failed to seed development portfolio snapshots');
    process.exitCode = 1;
  } finally {
    if (previousSuppressHoldingsLogs === undefined) {
      delete process.env.SUPPRESS_HOLDINGS_PROVIDER_LOGS;
    } else {
      process.env.SUPPRESS_HOLDINGS_PROVIDER_LOGS = previousSuppressHoldingsLogs;
    }

    await pool.end();
  }
}

run();
