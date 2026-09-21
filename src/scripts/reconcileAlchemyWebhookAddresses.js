import { logger } from '../config/logger.js';
import { pool } from '../db/pool.js';
import { reconcileAlchemyWebhookAddresses } from '../modules/webhooks/alchemyReconciliation.service.js';

const scriptLogger = logger.child({ module: 'reconcile-alchemy-webhook-addresses' });

reconcileAlchemyWebhookAddresses({ dryRun: process.argv.includes('--dry-run') })
  .catch((error) => {
    scriptLogger.error({ err: error, reports: error.reports }, 'Alchemy webhook reconciliation failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
