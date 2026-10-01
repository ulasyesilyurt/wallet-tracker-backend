import { readFile } from 'node:fs/promises';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  ETHEREUM_MAINNET_CHAIN_ID,
  getChainConfigById
} from '../chains/chains.config.js';
import { countActiveWalletsByChainIdAndAddress } from '../wallets/wallets.repository.js';
import { safeProviderError } from '../../utils/providerRequests.js';

const alchemyAddressSyncLogger = logger.child({ module: 'alchemy-address-sync' });
// This management endpoint is intentionally isolated here so it is easy to adjust
// if Alchemy's Notify API path or auth header requirements differ by account/docs.
const ALCHEMY_NOTIFY_UPDATE_WEBHOOK_ADDRESSES_URL = 'https://dashboard.alchemy.com/api/update-webhook-addresses';
const ALCHEMY_NOTIFY_GET_WEBHOOK_ADDRESSES_URL = 'https://dashboard.alchemy.com/api/webhook-addresses';
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const WEBHOOK_ADDRESS_PAGE_SIZE = 100;
const WEBHOOK_ADDRESS_MAX_PAGES = 100;

function normalizeAddress(address) {
  return typeof address === 'string' ? address.trim().toLowerCase() : '';
}

function getAlchemyAddressActivityWebhookId(chainId) {
  const chainConfig = getChainConfigById(chainId);

  if (!chainConfig) {
    return null;
  }

  const chainSpecificWebhookId = env[chainConfig.alchemyAddressActivityWebhookEnvVar];

  if (chainSpecificWebhookId) {
    return chainSpecificWebhookId;
  }

  if (chainConfig.legacyAlchemyAddressActivityWebhookEnvVar) {
    return env[chainConfig.legacyAlchemyAddressActivityWebhookEnvVar] ?? null;
  }

  return null;
}

export function getAlchemyAddressActivityWebhookIdForChain(chainId) {
  return getAlchemyAddressActivityWebhookId(chainId);
}

function buildAlchemyHeaders() {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${env.ALCHEMY_NOTIFY_API_KEY}`,
    'x-alchemy-token': env.ALCHEMY_NOTIFY_API_KEY
  };
}

function ensureAlchemyWebhookSyncConfigured(chainId) {
  const webhookId = getAlchemyAddressActivityWebhookId(chainId);

  if (!env.ALCHEMY_NOTIFY_API_KEY || !webhookId) {
    const error = new Error('Alchemy webhook address sync configuration is incomplete');
    error.code = 'ALCHEMY_WEBHOOK_SYNC_CONFIG_INCOMPLETE';
    error.chainId = chainId;
    throw error;
  }

  return webhookId;
}

function providerSignal(signal) {
  const timeout = AbortSignal.timeout(env.ALCHEMY_NOTIFY_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

async function updateAlchemyWebhookAddresses({ chainId, addressesToAdd = [], addressesToRemove = [], signal }) {
  const webhookId = ensureAlchemyWebhookSyncConfigured(chainId);

  let response;
  try {
    response = await fetch(ALCHEMY_NOTIFY_UPDATE_WEBHOOK_ADDRESSES_URL, {
      method: 'PATCH',
      headers: buildAlchemyHeaders(),
      body: JSON.stringify({
        webhook_id: webhookId,
        addresses_to_add: addressesToAdd,
        addresses_to_remove: addressesToRemove
      }),
      signal: providerSignal(signal)
    });
  } catch (error) {
    alchemyAddressSyncLogger.warn(
      safeProviderError('alchemy', 'webhook_address_update', error),
      'Alchemy webhook address update request failed'
    );
    throw error;
  }

  const responseText = await response.text();

  if (!response.ok) {
    const error = new Error(`Alchemy webhook address sync failed with status ${response.status}`);
    error.status = response.status;
    alchemyAddressSyncLogger.warn(
      safeProviderError('alchemy', 'webhook_address_update', error),
      'Alchemy webhook address update response failed'
    );
    throw error;
  }

  return responseText;
}

function parseWatchedAddressesOverride(rawValue, sourceLabel) {
  let parsedValue = null;

  try {
    parsedValue = JSON.parse(rawValue);
  } catch (error) {
    const parseError = new Error(`Alchemy watched-address override from ${sourceLabel} is not valid JSON`);
    parseError.cause = error;
    throw parseError;
  }

  if (!Array.isArray(parsedValue)) {
    throw new Error(`Alchemy watched-address override from ${sourceLabel} must be a JSON array`);
  }

  return [...new Set(parsedValue.map(normalizeAddress).filter(Boolean))];
}

async function loadWatchedAddressesOverride() {
  if (env.ALCHEMY_RECONCILE_WATCHED_ADDRESSES_JSON) {
    const addresses = parseWatchedAddressesOverride(
      env.ALCHEMY_RECONCILE_WATCHED_ADDRESSES_JSON,
      'ALCHEMY_RECONCILE_WATCHED_ADDRESSES_JSON'
    );

    alchemyAddressSyncLogger.info(
      { watchedAddressCount: addresses.length },
      'Loaded Alchemy watched addresses from JSON override'
    );

    return addresses;
  }

  if (env.ALCHEMY_RECONCILE_WATCHED_ADDRESSES_FILE) {
    const fileContents = await readFile(env.ALCHEMY_RECONCILE_WATCHED_ADDRESSES_FILE, 'utf8');
    const addresses = parseWatchedAddressesOverride(
      fileContents,
      `ALCHEMY_RECONCILE_WATCHED_ADDRESSES_FILE (${env.ALCHEMY_RECONCILE_WATCHED_ADDRESSES_FILE})`
    );

    alchemyAddressSyncLogger.info(
      {
        watchedAddressCount: addresses.length,
        filePath: env.ALCHEMY_RECONCILE_WATCHED_ADDRESSES_FILE
      },
      'Loaded Alchemy watched addresses from file override'
    );

    return addresses;
  }

  return null;
}

export async function listAlchemyWebhookWatchedAddresses(chainId = ETHEREUM_MAINNET_CHAIN_ID, { allowOverride = false, signal } = {}) {
  const webhookId = ensureAlchemyWebhookSyncConfigured(chainId);

  if (allowOverride && chainId === ETHEREUM_MAINNET_CHAIN_ID) {
    const overrideAddresses = await loadWatchedAddressesOverride();

    if (overrideAddresses) {
      return overrideAddresses;
    }
  }

  const addresses = new Set();
  const seenCursors = new Set();
  let after = null;
  let totalCount = null;
  let fetchedPages = 0;
  const maxItems = WEBHOOK_ADDRESS_MAX_PAGES * WEBHOOK_ADDRESS_PAGE_SIZE;

  do {
    signal?.throwIfAborted();
    if (fetchedPages >= WEBHOOK_ADDRESS_MAX_PAGES) {
      const error = new Error('Alchemy webhook address list exceeded the page limit; refusing reconciliation');
      error.code = 'PROVIDER_PAGE_LIMIT';
      alchemyAddressSyncLogger.warn({
        provider: 'alchemy',
        operation: 'webhook_address_list',
        errorCode: error.code,
        fetchedPages,
        maxPages: WEBHOOK_ADDRESS_MAX_PAGES
      }, 'Alchemy webhook address pagination limit reached');
      throw error;
    }
    const url = new URL(ALCHEMY_NOTIFY_GET_WEBHOOK_ADDRESSES_URL);
    url.searchParams.set('webhook_id', webhookId);
    url.searchParams.set('limit', String(WEBHOOK_ADDRESS_PAGE_SIZE));

    if (after) {
      url.searchParams.set('after', after);
    }

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: buildAlchemyHeaders(),
        signal: providerSignal(signal)
      });
    } catch (error) {
      alchemyAddressSyncLogger.warn(
        safeProviderError('alchemy', 'webhook_address_list', error),
        'Alchemy webhook address listing failed'
      );
      throw error;
    }
    fetchedPages += 1;

    if (!response.ok) {
      const error = new Error(`Alchemy webhook address list failed with status ${response.status}`);
      error.status = response.status;
      alchemyAddressSyncLogger.warn(
        safeProviderError('alchemy', 'webhook_address_list', error),
        'Alchemy webhook address listing response failed'
      );
      throw error;
    }

    const payload = await response.json().catch((error) => {
      if (['AbortError', 'TimeoutError'].includes(error?.name)) {
        throw error;
      }
      const invalidResponse = new Error('Alchemy webhook address list returned invalid JSON');
      invalidResponse.code = 'PROVIDER_INVALID_RESPONSE';
      throw invalidResponse;
    });
    const pageCount = payload?.pagination?.total_count;
    const pageAddresses = payload?.data;
    const nextCursor = payload?.pagination?.cursors?.after ?? null;

    if (Number.isInteger(pageCount) && pageCount > maxItems) {
      const error = new Error('Alchemy webhook address list exceeded the item limit; refusing reconciliation');
      error.code = 'PROVIDER_PAGE_LIMIT';
      throw error;
    }
    if (!Array.isArray(pageAddresses) || pageAddresses.length > WEBHOOK_ADDRESS_PAGE_SIZE ||
        !Number.isInteger(pageCount) || pageCount < 0 ||
        (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0))) {
      throw new Error('Alchemy webhook address list returned an invalid response');
    }

    if (totalCount !== null && totalCount !== pageCount) {
      throw new Error('Alchemy webhook address count changed during pagination');
    }

    totalCount = pageCount;
    const previousAddressCount = addresses.size;

    for (const address of pageAddresses) {
      if (typeof address !== 'string' || !ADDRESS_PATTERN.test(address)) {
        throw new Error('Alchemy webhook address list contained an invalid address');
      }

      addresses.add(address.toLowerCase());
    }

    if (addresses.size > totalCount) {
      throw new Error('Alchemy webhook address list exceeded its reported count');
    }

    if (nextCursor !== null) {
      if (addresses.size === previousAddressCount || seenCursors.has(nextCursor)) {
        throw new Error('Alchemy webhook address list pagination did not advance');
      }

      seenCursors.add(nextCursor);
    }

    after = nextCursor;
  } while (after !== null);

  if (addresses.size !== totalCount) {
    throw new Error('Alchemy webhook address list was incomplete; refusing reconciliation');
  }

  alchemyAddressSyncLogger.info(
    {
      chainId,
      webhookId,
      watchedAddressCount: addresses.size
    },
    'Fetched watched addresses from Alchemy webhook'
  );

  return [...addresses].sort();
}

async function addAddressToAlchemyWebhook({ chainId, address, walletId, reason, signal }) {
  const normalizedAddress = normalizeAddress(address);
  const chainConfig = getChainConfigById(chainId);

  if (!chainConfig) {
    alchemyAddressSyncLogger.info(
      { chainId, walletId, reason },
      'Alchemy webhook address sync add skipped for unsupported chain'
    );
    return false;
  }

  ensureAlchemyWebhookSyncConfigured(chainId);

  alchemyAddressSyncLogger.info(
    { chainId, walletId, reason },
    'Alchemy webhook address sync add started'
  );

  try {
    await updateAlchemyWebhookAddresses({
      chainId,
      addressesToAdd: [normalizedAddress],
      signal
    });

    alchemyAddressSyncLogger.info(
      { chainId, walletId, reason },
      'Alchemy webhook address sync add succeeded'
    );
    return true;
  } catch (error) {
    alchemyAddressSyncLogger.error(
      {
        ...safeProviderError('alchemy', 'webhook_address_add', error),
        chainId,
        walletId,
        reason
      },
      'Alchemy webhook address sync add failed'
    );
    throw error;
  }
}

async function removeAddressFromAlchemyWebhookIfUnused({ chainId, address, walletId, reason, signal }) {
  const normalizedAddress = normalizeAddress(address);
  const chainConfig = getChainConfigById(chainId);

  if (!chainConfig) {
    alchemyAddressSyncLogger.info(
      { chainId, walletId, reason },
      'Alchemy webhook address sync remove skipped for unsupported chain'
    );
    return false;
  }

  const remainingWalletCount = await countActiveWalletsByChainIdAndAddress(chainId, normalizedAddress);

  if (remainingWalletCount > 0) {
    alchemyAddressSyncLogger.info(
      {
        chainId,
        walletId,
        reason,
        remainingWalletCount
      },
      'Alchemy webhook address sync remove skipped because address is still used by another wallet'
    );
    return false;
  }

  ensureAlchemyWebhookSyncConfigured(chainId);

  alchemyAddressSyncLogger.info(
    { chainId, walletId, reason },
    'Alchemy webhook address sync remove started'
  );

  try {
    await updateAlchemyWebhookAddresses({
      chainId,
      addressesToRemove: [normalizedAddress],
      signal
    });

    alchemyAddressSyncLogger.info(
      { chainId, walletId, reason },
      'Alchemy webhook address sync remove succeeded'
    );
    return true;
  } catch (error) {
    alchemyAddressSyncLogger.error(
      {
        ...safeProviderError('alchemy', 'webhook_address_remove', error),
        chainId,
        walletId,
        reason
      },
      'Alchemy webhook address sync remove failed'
    );
    throw error;
  }
}

export async function addAddressToAlchemyWebhookSync({ chainId, address, reason = 'manual_sync', walletId = null, signal }) {
  return addAddressToAlchemyWebhook({ chainId, address, reason, walletId, signal });
}

export async function removeAddressFromAlchemyWebhookSync({ chainId, address, reason = 'manual_sync', walletId = null, signal }) {
  return removeAddressFromAlchemyWebhookIfUnused({ chainId, address, reason, walletId, signal });
}

// The reconciliation worker already checked current desired state while holding
// the pair advisory lock, so it must not acquire a second pool client here.
export async function removeAddressFromAlchemyWebhookAfterDesiredCheck({ chainId, address, signal }) {
  await updateAlchemyWebhookAddresses({
    chainId,
    addressesToRemove: [normalizeAddress(address)],
    signal
  });
}
