import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID } from '../chains/chains.config.js';
import { listActiveTrackedAddressesByChainId } from '../wallets/wallets.repository.js';
import {
  addAddressToAlchemyWebhookSync,
  getAlchemyAddressActivityWebhookIdForChain,
  listAlchemyWebhookWatchedAddresses,
  removeAddressFromAlchemyWebhookSync
} from './alchemyAddressSync.service.js';
import { safeErrorDetails } from '../../utils/safeError.js';
import {
  recordAlchemySyncFailure,
  recordAlchemySyncSuccess
} from '../operations/operationalState.js';

const reconciliationLogger = logger.child({ module: 'reconcile-alchemy-webhook-addresses' });
const CHAIN_IDS = [ETHEREUM_MAINNET_CHAIN_ID, BASE_MAINNET_CHAIN_ID];

function toSortedUnique(values) {
  return [...new Set(values.map((value) => value.toLowerCase()))].sort();
}

export async function reconcileAlchemyWebhookAddresses({
  dryRun = false,
  listDbAddresses = listActiveTrackedAddressesByChainId,
  listWatchedAddresses = listAlchemyWebhookWatchedAddresses,
  addAddress = addAddressToAlchemyWebhookSync,
  removeAddress = removeAddressFromAlchemyWebhookSync
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
        ? 'override'
        : 'alchemy',
      dbActiveAddressCount: null,
      watchedAddressCount: null,
      addressesToAddCount: null,
      addressesToRemoveCount: null,
      addedCount: 0,
      removedCount: 0,
      skippedRemovalCount: 0,
      failedCount: 0
    };

    try {
      const dbAddresses = toSortedUnique(await listDbAddresses(chainId));
      const watchedAddresses = toSortedUnique(await listWatchedAddresses(chainId, { allowOverride: dryRun }));
      const dbSet = new Set(dbAddresses);
      const watchedSet = new Set(watchedAddresses);
      const addressesToAdd = dbAddresses.filter((address) => !watchedSet.has(address));
      const addressesToRemove = watchedAddresses.filter((address) => !dbSet.has(address));

      report.dbActiveAddressCount = dbAddresses.length;
      report.watchedAddressCount = watchedAddresses.length;
      report.addressesToAddCount = addressesToAdd.length;
      report.addressesToRemoveCount = addressesToRemove.length;

      if (!dryRun) {
        for (const address of addressesToAdd) {
          try {
            if (await addAddress({ chainId, address, reason: 'reconcile_script_add' })) {
              report.addedCount += 1;
            }
          } catch (error) {
            failures.push(error);
            report.failedCount += 1;
            recordAlchemySyncFailure(error);
            reconciliationLogger.error({
              provider: 'alchemy',
              operation: 'reconciliation_add',
              chainId,
              ...safeErrorDetails(error)
            }, 'Alchemy reconciliation add failed');
          }
        }

        for (const address of addressesToRemove) {
          try {
            if (await removeAddress({ chainId, address, reason: 'reconcile_script_remove' })) {
              report.removedCount += 1;
            } else {
              report.skippedRemovalCount += 1;
            }
          } catch (error) {
            failures.push(error);
            report.failedCount += 1;
            recordAlchemySyncFailure(error);
            reconciliationLogger.error({
              provider: 'alchemy',
              operation: 'reconciliation_remove',
              chainId,
              ...safeErrorDetails(error)
            }, 'Alchemy reconciliation remove failed');
          }
        }
      }
    } catch (error) {
      failures.push(error);
      report.failedCount += 1;
      recordAlchemySyncFailure(error);
      reconciliationLogger.error({
        provider: 'alchemy',
        operation: 'reconciliation_compare',
        chainId,
        ...safeErrorDetails(error)
      }, 'Alchemy reconciliation could not compare addresses');
    }

    reports.push(report);
    if (report.failedCount === 0) {
      recordAlchemySyncSuccess();
    }
    reconciliationLogger.info(report, dryRun ? 'Alchemy reconciliation dry-run result' : 'Alchemy reconciliation result');
  }

  if (failures.length > 0) {
    const error = new AggregateError(failures, 'Alchemy webhook address reconciliation failed');
    error.reports = reports;
    throw error;
  }

  return reports;
}
