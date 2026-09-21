import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { pool } from './db/pool.js';
import { checkDatabaseReadiness } from './db/readiness.js';
import { EthereumWalletActivityTracker } from './modules/ethereum/ethereum.tracker.js';
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID } from './modules/chains/chains.config.js';
import { getAlchemyAddressActivityWebhookIdForChain } from './modules/webhooks/alchemyAddressSync.service.js';
import { PortfolioSnapshotJob } from './modules/performance/performance.job.js';
import { NotificationOutboxWorker } from './modules/notifications/notificationOutbox.worker.js';

const ethereumTracker = env.ENABLE_ETHEREUM_TRACKER ? new EthereumWalletActivityTracker() : null;
const portfolioSnapshotJob = env.ENABLE_PORTFOLIO_SNAPSHOT_JOB
  ? new PortfolioSnapshotJob({ intervalMs: env.PORTFOLIO_SNAPSHOT_INTERVAL_MS })
  : null;
const notificationOutboxWorker = new NotificationOutboxWorker();
let shuttingDown = false;
let shutdownPromise = null;
let server = null;
const app = createApp({
  isWorkerReady: () => notificationOutboxWorker.isStarted(),
  isShuttingDown: () => shuttingDown
});
const SHUTDOWN_TIMEOUT_MS = 10_000;

function logListening() {
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
}

function closeHttpServer() {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function shutdown(signal, exitCode = 0) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shuttingDown = true;
  logger.info({ signal }, 'Shutting down gracefully');
  const deadline = setTimeout(() => {
    logger.error({ signal, timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Shutdown deadline exceeded');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  shutdownPromise = (async () => {
    const httpClosed = closeHttpServer();
    const stopped = await Promise.allSettled([
      httpClosed,
      ethereumTracker?.stop(),
      portfolioSnapshotJob?.stop(),
      notificationOutboxWorker.stop()
    ]);
    await pool.end();
    clearTimeout(deadline);
    process.exit(exitCode || stopped.some((result) => result.status === 'rejected') ? 1 : 0);
  })().catch((error) => {
    clearTimeout(deadline);
    logger.error({ errorName: error.name, errorCode: error.code ?? null }, 'Shutdown failed');
    process.exit(1);
  });

  return shutdownPromise;
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

async function start() {
  if (!(await checkDatabaseReadiness())) {
    logger.error('PostgreSQL is unavailable at startup; HTTP listener was not opened');
    void shutdown('STARTUP_DATABASE_UNAVAILABLE', 1);
    return;
  }

  if (shuttingDown) {
    return;
  }

  server = app.listen(env.PORT, logListening);
  server.on('error', (error) => {
    logger.error({ errorName: error.name, errorCode: error.code ?? null }, 'HTTP server error');
    void shutdown('HTTP_SERVER_ERROR', 1);
  });

  notificationOutboxWorker.start().catch((error) => {
    logger.error({ errorName: error.name, errorCode: error.code ?? null }, 'Notification outbox worker did not start');
    void shutdown('NOTIFICATION_WORKER_START_FAILURE', 1);
  });

  if (ethereumTracker) {
    ethereumTracker.start().catch((error) => {
      logger.error({ errorName: error.name, errorCode: error.code ?? null }, 'Failed to start Ethereum wallet activity tracker');
    });
  }

  if (portfolioSnapshotJob) {
    portfolioSnapshotJob.start().catch((error) => {
      logger.error({ errorName: error.name, errorCode: error.code ?? null }, 'Failed to start portfolio snapshot job');
    });
  }
}

start().catch((error) => {
  logger.error({ errorName: error.name, errorCode: error.code ?? null }, 'Backend startup failed');
  if (!shuttingDown) {
    void shutdown('STARTUP_FAILURE', 1);
  }
});
