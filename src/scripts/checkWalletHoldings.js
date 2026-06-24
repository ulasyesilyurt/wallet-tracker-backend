import { logger } from '../config/logger.js';
import { pool } from '../db/pool.js';
import { getWalletHoldings } from '../modules/holdings/holdings.service.js';

const scriptLogger = logger.child({ module: 'check-wallet-holdings' });
const SAMPLE_LIMIT = 10;

function resolveWalletId() {
  return process.argv[2] ?? process.env.WALLET_ID ?? null;
}

function getHoldingDisplaySymbol(holding) {
  return holding.symbol ?? holding.name ?? holding.tokenAddress ?? 'unknown';
}

function buildTotalsByChain(holdings) {
  const totals = holdings.reduce((accumulator, holding) => {
    const chainId = holding.chainId ?? 'unknown';

    if (!accumulator[chainId]) {
      accumulator[chainId] = {
        holdingsCount: 0,
        suspiciousCount: 0,
        nonSuspiciousCount: 0,
        totalBalanceUsd: 0,
        hasPricedNonSuspiciousHoldings: false
      };
    }

    const chainTotals = accumulator[chainId];
    chainTotals.holdingsCount += 1;

    if (holding.isSuspicious) {
      chainTotals.suspiciousCount += 1;
    } else {
      chainTotals.nonSuspiciousCount += 1;
    }

    if (
      typeof holding.balanceUsd === 'number' &&
      Number.isFinite(holding.balanceUsd) &&
      !holding.isSuspicious
    ) {
      chainTotals.totalBalanceUsd += holding.balanceUsd;
      chainTotals.hasPricedNonSuspiciousHoldings = true;
    }

    return accumulator;
  }, {});

  return Object.fromEntries(
    Object.entries(totals).map(([chainId, summary]) => [
      chainId,
      {
        holdingsCount: summary.holdingsCount,
        suspiciousCount: summary.suspiciousCount,
        nonSuspiciousCount: summary.nonSuspiciousCount,
        totalBalanceUsd: summary.hasPricedNonSuspiciousHoldings
          ? Number(summary.totalBalanceUsd.toFixed(2))
          : null
      }
    ])
  );
}

async function run() {
  const walletId = resolveWalletId();

  if (!walletId) {
    throw new Error('Wallet ID is required. Use `npm run check:wallet-holdings -- <wallet-id>` or set WALLET_ID.');
  }

  const holdings = await getWalletHoldings(walletId);
  const nativeEthHolding = holdings.holdings.find((holding) => holding.tokenAddress == null && holding.symbol === 'ETH');
  const suspiciousCount = holdings.holdings.filter((holding) => holding.isSuspicious).length;
  const normalHoldings = holdings.holdings.filter((holding) => !holding.isSuspicious);
  const suspiciousHoldings = holdings.holdings.filter((holding) => holding.isSuspicious);
  const pricedHoldingsCount = holdings.holdings.filter(
    (holding) => typeof holding.balanceUsd === 'number' && Number.isFinite(holding.balanceUsd)
  ).length;
  const unpricedHoldingsCount = holdings.holdings.length - pricedHoldingsCount;
  const normalSampleSymbols = normalHoldings
    .slice(0, SAMPLE_LIMIT)
    .map(getHoldingDisplaySymbol);
  const suspiciousSampleSymbols = suspiciousHoldings
    .slice(0, SAMPLE_LIMIT)
    .map(getHoldingDisplaySymbol);
  const suspiciousSampleDetails = suspiciousHoldings
    .slice(0, SAMPLE_LIMIT)
    .map((holding) => ({
      chainId: holding.chainId ?? null,
      symbol: holding.symbol ?? null,
      name: holding.name ?? null,
      tokenAddress: holding.tokenAddress ?? null,
      balanceUsd: holding.balanceUsd ?? null,
      suspicionReasons: holding.suspicionReasons ?? []
    }));
  const totalsByChain = buildTotalsByChain(holdings.holdings);

  scriptLogger.info(
    {
      walletId: holdings.walletId,
      chainId: holdings.chainId,
      holdingsCount: holdings.holdings.length,
      pricedHoldingsCount,
      unpricedHoldingsCount,
      totalBalanceUsd: holdings.totalBalanceUsd,
      nativeEthIncluded: Boolean(nativeEthHolding),
      nativeEthBalance: nativeEthHolding?.balance ?? null,
      nativeEthUsdBalance: nativeEthHolding?.balanceUsd ?? null,
      tokenBalancesAvailable: holdings.tokenBalancesAvailable ?? true,
      tokenBalancesReason: holdings.tokenBalancesReason ?? null,
      suspiciousCount,
      sampleSymbols: holdings.holdings.slice(0, SAMPLE_LIMIT).map(getHoldingDisplaySymbol),
      normalSampleSymbols,
      suspiciousSampleSymbols,
      suspiciousSampleDetails,
      totalsByChain
    },
    'Wallet holdings sanity check completed'
  );
}

run()
  .catch((error) => {
    scriptLogger.error({ err: error }, 'Wallet holdings sanity check failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
