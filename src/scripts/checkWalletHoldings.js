import { logger } from '../config/logger.js';
import { pool } from '../db/pool.js';
import { getWalletHoldings } from '../modules/holdings/holdings.service.js';

const scriptLogger = logger.child({ module: 'check-wallet-holdings' });

function resolveWalletId() {
  return process.argv[2] ?? process.env.WALLET_ID ?? null;
}

async function run() {
  const walletId = resolveWalletId();

  if (!walletId) {
    throw new Error('Wallet ID is required. Use `npm run check:wallet-holdings -- <wallet-id>` or set WALLET_ID.');
  }

  const holdings = await getWalletHoldings(walletId);
  const nativeEthHolding = holdings.holdings.find((holding) => holding.tokenAddress == null && holding.symbol === 'ETH');
  const suspiciousCount = holdings.holdings.filter((holding) => holding.isSuspicious).length;
  const pricedHoldingsCount = holdings.holdings.filter(
    (holding) => typeof holding.balanceUsd === 'number' && Number.isFinite(holding.balanceUsd)
  ).length;
  const unpricedHoldingsCount = holdings.holdings.length - pricedHoldingsCount;

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
      sampleSymbols: holdings.holdings.slice(0, 10).map((holding) => holding.symbol ?? holding.name ?? holding.tokenAddress)
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
