import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { pool } from '../../db/pool.js';
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID } from '../chains/chains.config.js';
import { listActiveTrackedAddressesByChainId } from '../wallets/wallets.repository.js';
import { getAlchemyAddressActivityWebhookIdForChain, listAlchemyWebhookWatchedAddresses } from './alchemyAddressSync.service.js';
import { markAlchemyAddressPairsDirty } from './alchemyAddressReconciliation.repository.js';
import { safeErrorDetails } from '../../utils/safeError.js';

const reconciliationLogger = logger.child({ module: 'reconcile-alchemy-webhook-addresses' });
const CHAIN_IDS = [ETHEREUM_MAINNET_CHAIN_ID, BASE_MAINNET_CHAIN_ID];

function toSortedUnique(values) {
  return [...new Set(values.map((value) => value.toLowerCase()))].sort();
}

async function enqueueDriftPairs(pairs) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await markAlchemyAddressPairsDirty(client, pairs);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// The CLI detects drift and marks pairs. Only the worker mutates Alchemy.
export async function reconcileAlchemyWebhookAddresses({
  dryRun = false,
  listDbAddresses = listActiveTrackedAddressesByChainId,
  listWatchedAddresses = listAlchemyWebhookWatchedAddresses,
  enqueuePairs = enqueueDriftPairs
} = {}) {
  const reports = [];
  const failures = [];

  for (const chainId of CHAIN_IDS) {
    const report = {
      chainId,
      webhookId: getAlchemyAddressActivityWebhookIdForChain(chainId),
      dryRun,
      watchedSource: dryRun && chainId === ETHEREUM_MAINNET_CHAIN_ID &&
        (env.ALCHEMY_RECONCILE_WATCHED_ADDRESSES_JSON || env.ALCHEMY_RECONCILE_WATCHED_ADDRESSES_FILE)
        ? 'override' : 'alchemy',
      dbActiveAddressCount: null,
      watchedAddressCount: null,
      addressesToAddCount: null,
      addressesToRemoveCount: null,
      queuedCount: 0,
      failedCount: 0
    };

    try {
      const dbAddresses = toSortedUnique(await listDbAddresses(chainId));
      const watchedAddresses = toSortedUnique(await listWatchedAddresses(chainId, { allowOverride: dryRun }));
      const dbSet = new Set(dbAddresses);
      const watchedSet = new Set(watchedAddresses);
      const addressesToAdd = dbAddresses.filter((address) => !watchedSet.has(address));
      const addressesToRemove = watchedAddresses.filter((address) => !dbSet.has(address));
      const dirtyPairs = [...addressesToAdd, ...addressesToRemove].map((address) => ({ chainId, address }));

      report.dbActiveAddressCount = dbAddresses.length;
      report.watchedAddressCount = watchedAddresses.length;
      report.addressesToAddCount = addressesToAdd.length;
      report.addressesToRemoveCount = addressesToRemove.length;

      if (!dryRun && dirtyPairs.length > 0) {
        await enqueuePairs(dirtyPairs);
        report.queuedCount = dirtyPairs.length;
      }
    } catch (error) {
      failures.push(error);
      report.failedCount += 1;
      reconciliationLogger.error({ chainId, ...safeErrorDetails(error) },
        'Alchemy reconciliation could not enqueue drift');
    }

    reports.push(report);
    reconciliationLogger.info(report, dryRun ? 'Alchemy reconciliation dry-run result' : 'Alchemy reconciliation enqueue result');
  }

  if (failures.length > 0) {
    const error = new AggregateError(failures, 'Alchemy webhook address reconciliation failed');
    error.reports = reports;
    throw error;
  }

  return reports;
}
