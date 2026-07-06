import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { pool } from './db/pool.js';
import { EthereumWalletActivityTracker } from './modules/ethereum/ethereum.tracker.js';
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID } from './modules/chains/chains.config.js';
import { getAlchemyAddressActivityWebhookIdForChain } from './modules/webhooks/alchemyAddressSync.service.js';
import { PortfolioSnapshotJob } from './modules/performance/performance.job.js';
import { NotificationOutboxWorker } from './modules/notifications/notificationOutbox.worker.js';

const app = createApp();
const ethereumTracker = env.ENABLE_ETHEREUM_TRACKER ? new EthereumWalletActivityTracker() : null;
const portfolioSnapshotJob = env.ENABLE_PORTFOLIO_SNAPSHOT_JOB
  ? new PortfolioSnapshotJob({ intervalMs: env.PORTFOLIO_SNAPSHOT_INTERVAL_MS })
  : null;
const notificationOutboxWorker = new NotificationOutboxWorker();

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      realtimeMode: 'alchemy_webhook_primary',
      webhookEndpoint: '/api/v1/webhooks/alchemy',
      pollingTrackerEnabled: Boolean(ethereumTracker),
      portfolioSnapshotJobEnabled: Boolean(portfolioSnapshotJob),
      notificationOutboxWorkerEnabled: true
    },
    'Wallet tracker backend is running'
  );

  logger.info(
    {
      hasNotifyApiKey: Boolean(env.ALCHEMY_NOTIFY_API_KEY),
      hasEthereumWebhookId: Boolean(getAlchemyAddressActivityWebhookIdForChain(ETHEREUM_MAINNET_CHAIN_ID)),
      ethereumWebhookId: getAlchemyAddressActivityWebhookIdForChain(ETHEREUM_MAINNET_CHAIN_ID),
      hasBaseWebhookId: Boolean(getAlchemyAddressActivityWebhookIdForChain(BASE_MAINNET_CHAIN_ID)),
      baseWebhookId: getAlchemyAddressActivityWebhookIdForChain(BASE_MAINNET_CHAIN_ID)
    },
    'Alchemy address sync configuration'
  );

  if (ethereumTracker) {
    logger.info(
      {
        enableEthereumTracker: true,
        expectedMode: 'polling_fallback_or_debug'
      },
      'Ethereum polling tracker is enabled; webhook ingestion should still be treated as the primary real-time path'
    );
  } else {
    logger.info(
      {
        enableEthereumTracker: false,
        expectedMode: 'webhook_primary'
      },
      'Webhook-first mode is active; real-time notifications are expected to arrive through Alchemy webhooks'
    );
  }

  if (portfolioSnapshotJob) {
    logger.info(
      {
        enablePortfolioSnapshotJob: true,
        intervalMs: env.PORTFOLIO_SNAPSHOT_INTERVAL_MS
      },
      'Portfolio snapshot job is enabled; wallet performance history will be captured periodically'
    );
  } else {
    logger.info(
      {
        enablePortfolioSnapshotJob: false
      },
      'Portfolio snapshot job is disabled; 24h performance data will not accumulate'
    );
  }

  logger.info(
    {
      notificationOutboxWorkerEnabled: true
    },
    'Notification outbox worker is enabled; push delivery is decoupled from wallet event ingestion'
  );
});

if (ethereumTracker) {
  ethereumTracker.start().catch((error) => {
    logger.error({ err: error }, 'Failed to start Ethereum wallet activity tracker');
  });
}

if (portfolioSnapshotJob) {
  portfolioSnapshotJob.start().catch((error) => {
    logger.error({ err: error }, 'Failed to start portfolio snapshot job');
  });
}

notificationOutboxWorker.start().catch((error) => {
  logger.error({ err: error }, 'Failed to start notification outbox worker');
});

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down gracefully');
  await ethereumTracker?.stop();
  await portfolioSnapshotJob?.stop();
  await notificationOutboxWorker.stop();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
