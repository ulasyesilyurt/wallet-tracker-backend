import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { ETHEREUM_MAINNET_CHAIN_ID } from '../modules/ethereum/ethereum.constants.js';
import {
  addAddressToAlchemyWebhookSync,
  getAlchemyAddressActivityWebhookIdForChain,
  listAlchemyWebhookWatchedAddresses,
  removeAddressFromAlchemyWebhookSync
} from '../modules/webhooks/alchemyAddressSync.service.js';
import { listActiveTrackedAddressesByChainId } from '../modules/wallets/wallets.repository.js';

const scriptLogger = logger.child({ module: 'reconcile-alchemy-webhook-addresses' });

function isDryRun() {
  return process.argv.includes('--dry-run');
}

function ensureRequiredConfig() {
  if (!env.ALCHEMY_NOTIFY_API_KEY || !getAlchemyAddressActivityWebhookIdForChain(ETHEREUM_MAINNET_CHAIN_ID)) {
    throw new Error(
      'ALCHEMY_NOTIFY_API_KEY and an Ethereum Address Activity webhook ID are required for reconciliation.'
    );
  }
}

function toSortedUnique(values) {
  return [...new Set(values.map((value) => `${value}`.trim().toLowerCase()).filter(Boolean))].sort();
}

async function run() {
  ensureRequiredConfig();

  const dryRun = isDryRun();
  const chainId = ETHEREUM_MAINNET_CHAIN_ID;
  const dbAddresses = toSortedUnique(await listActiveTrackedAddressesByChainId(chainId));
  let watchedAddresses = [];

  try {
    watchedAddresses = toSortedUnique(await listAlchemyWebhookWatchedAddresses());
  } catch (error) {
    if (!dryRun) {
      throw error;
    }

    scriptLogger.warn(
      {
        chainId,
        webhookId: getAlchemyAddressActivityWebhookIdForChain(chainId),
        status: error.status ?? null,
        endpoint: error.endpoint ?? null
      },
      'Alchemy watched-address list is unavailable during dry-run; falling back to DB-only summary'
    );

    scriptLogger.info(
      {
        dryRun,
        chainId,
        webhookId: getAlchemyAddressActivityWebhookIdForChain(chainId),
        dbActiveAddressCount: dbAddresses.length,
        dbAddresses,
        watchedAddressCount: null,
        addressesToAddCount: null,
        addressesToRemoveCount: null,
        warning: 'Watched-address list unavailable. Configure ALCHEMY_RECONCILE_WATCHED_ADDRESSES_JSON or ALCHEMY_RECONCILE_WATCHED_ADDRESSES_FILE for full reconciliation dry-run.'
      },
      'Alchemy webhook reconciliation dry-run DB-only summary'
    );

    return;
  }

  const watchedAddressSet = new Set(watchedAddresses);
  const dbAddressSet = new Set(dbAddresses);

  const addressesToAdd = dbAddresses.filter((address) => !watchedAddressSet.has(address));
  const addressesToRemove = watchedAddresses.filter((address) => !dbAddressSet.has(address));

  scriptLogger.info(
    {
      dryRun,
      chainId,
      webhookId: getAlchemyAddressActivityWebhookIdForChain(chainId),
      dbActiveAddressCount: dbAddresses.length,
      watchedAddressCount: watchedAddresses.length,
      addressesToAddCount: addressesToAdd.length,
      addressesToRemoveCount: addressesToRemove.length,
      addressesToAdd,
      addressesToRemove
    },
    dryRun
      ? 'Alchemy webhook address reconciliation dry-run summary'
      : 'Alchemy webhook address reconciliation summary'
  );

  if (dryRun) {
    return;
  }

  for (const address of addressesToAdd) {
    await addAddressToAlchemyWebhookSync({
      chainId,
      address,
      reason: 'reconcile_script_add'
    });
  }

  for (const address of addressesToRemove) {
    await removeAddressFromAlchemyWebhookSync({
      chainId,
      address,
      reason: 'reconcile_script_remove'
    });
  }

  scriptLogger.info(
    {
      chainId,
      addedCount: addressesToAdd.length,
      removedCount: addressesToRemove.length
    },
    'Alchemy webhook address reconciliation completed'
  );
}

run()
  .catch((error) => {
    scriptLogger.error({ err: error }, 'Alchemy webhook address reconciliation failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
