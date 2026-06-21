import { EthereumWalletActivityTracker } from '../modules/ethereum/ethereum.tracker.js';
import { logger } from '../config/logger.js';
import { pool } from '../db/pool.js';

const tracker = new EthereumWalletActivityTracker();

logger.info(
  {
    realtimeMode: 'polling_tracker_only',
    expectedMode: 'fallback_or_debug'
  },
  'Starting standalone Ethereum polling tracker; this mode is intended for fallback/debug, not the primary real-time notification path'
);

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down Ethereum tracker');
  await tracker.stop();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

tracker.start().catch(async (error) => {
  logger.error({ err: error }, 'Ethereum tracker failed to start');
  await pool.end();
  process.exit(1);
});
