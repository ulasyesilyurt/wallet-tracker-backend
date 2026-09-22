import { logger } from '../config/logger.js';
import { pool } from '../db/pool.js';
import { reconcileAlchemyWebhookAddresses } from '../modules/webhooks/alchemyReconciliation.service.js';
import { safeErrorDetails } from '../utils/safeError.js';

const scriptLogger = logger.child({ module: 'reconcile-alchemy-webhook-addresses' });

reconcileAlchemyWebhookAddresses({ dryRun: process.argv.includes('--dry-run') })
  .catch((error) => {
    scriptLogger.error({
      operation: 'alchemy_webhook_reconciliation',
      ...safeErrorDetails(error),
      reports: error.reports
    }, 'Alchemy webhook reconciliation failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
