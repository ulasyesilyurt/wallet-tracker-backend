import { readFile } from 'node:fs/promises';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  ETHEREUM_MAINNET_CHAIN_ID,
  getChainConfigById
} from '../chains/chains.config.js';
import { countActiveWalletsByChainIdAndAddress } from '../wallets/wallets.repository.js';

const alchemyAddressSyncLogger = logger.child({ module: 'alchemy-address-sync' });
// This management endpoint is intentionally isolated here so it is easy to adjust
// if Alchemy's Notify API path or auth header requirements differ by account/docs.
const ALCHEMY_NOTIFY_UPDATE_WEBHOOK_ADDRESSES_URL = 'https://dashboard.alchemy.com/api/update-webhook-addresses';
const ALCHEMY_NOTIFY_GET_WEBHOOK_URL = 'https://dashboard.alchemy.com/api/team-webhooks';

function normalizeAddress(address) {
  return typeof address === 'string' ? address.trim().toLowerCase() : '';
}

function getWalletSyncChains(wallet) {
  if (Array.isArray(wallet?.enabledChains) && wallet.enabledChains.length > 0) {
    return [...new Set(wallet.enabledChains)];
  }

  return wallet?.chainId ? [wallet.chainId] : [];
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

function buildConfigContext(chainId = ETHEREUM_MAINNET_CHAIN_ID) {
  const chainConfig = getChainConfigById(chainId);
  const resolvedWebhookId = getAlchemyAddressActivityWebhookId(chainId);

  return {
    chainId,
    hasNotifyApiKey: Boolean(env.ALCHEMY_NOTIFY_API_KEY),
    webhookEnvVar: chainConfig?.alchemyAddressActivityWebhookEnvVar ?? null,
    hasWebhookId: Boolean(resolvedWebhookId),
    webhookId: resolvedWebhookId
  };
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

function isIdempotentAlchemyAddressSyncFailure(status, responseText) {
  if (status == null) {
    return false;
  }

  const normalized = `${responseText ?? ''}`.toLowerCase();

  if (status === 404 && normalized.includes('not found')) {
    return true;
  }

  if ((status === 400 || status === 409 || status === 422) && (
    normalized.includes('already') ||
    normalized.includes('exists') ||
    normalized.includes('duplicate') ||
    normalized.includes('not found') ||
    normalized.includes('missing')
  )) {
    return true;
  }

  return false;
}

async function updateAlchemyWebhookAddresses({ chainId, addressesToAdd = [], addressesToRemove = [] }) {
  const webhookId = ensureAlchemyWebhookSyncConfigured(chainId);

  const response = await fetch(ALCHEMY_NOTIFY_UPDATE_WEBHOOK_ADDRESSES_URL, {
    method: 'PATCH',
    headers: buildAlchemyHeaders(),
    body: JSON.stringify({
      webhook_id: webhookId,
      addresses_to_add: addressesToAdd,
      addresses_to_remove: addressesToRemove
    })
  });

  const responseText = await response.text();

  if (!response.ok) {
    const error = new Error(`Alchemy webhook address sync failed with status ${response.status}`);
    error.status = response.status;
    error.responseText = responseText;
    throw error;
  }

  return responseText;
}

function collectAddressArrays(value, collector) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) {
      collector.push(...value);
      return;
    }

    for (const item of value) {
      collectAddressArrays(item, collector);
    }
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (Array.isArray(nestedValue) && key.toLowerCase().includes('address')) {
      for (const item of nestedValue) {
        if (typeof item === 'string') {
          collector.push(item);
        } else if (item && typeof item === 'object') {
          const candidateAddress = item.address ?? item.walletAddress ?? item.value;

          if (typeof candidateAddress === 'string') {
            collector.push(candidateAddress);
          }
        }
      }
    }

    collectAddressArrays(nestedValue, collector);
  }
}

function extractWatchedAddressesFromWebhookPayload(payload) {
  const candidates = [];
  collectAddressArrays(payload, candidates);
  return [...new Set(candidates.map(normalizeAddress).filter(Boolean))];
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

export async function listAlchemyWebhookWatchedAddresses() {
  const chainId = ETHEREUM_MAINNET_CHAIN_ID;
  const webhookId = ensureAlchemyWebhookSyncConfigured(chainId);

  const overrideAddresses = await loadWatchedAddressesOverride();

  if (overrideAddresses) {
    return overrideAddresses;
  }

  const response = await fetch(`${ALCHEMY_NOTIFY_GET_WEBHOOK_URL}/${webhookId}`, {
    method: 'GET',
    headers: buildAlchemyHeaders()
  });
  const responseText = await response.text();

  if (!response.ok) {
    const error = new Error(`Alchemy webhook address list failed with status ${response.status}`);
    error.status = response.status;
    error.responseText = responseText;
    error.endpoint = `${ALCHEMY_NOTIFY_GET_WEBHOOK_URL}/${webhookId}`;
    throw error;
  }

  let payload = null;

  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch (error) {
    const parseError = new Error('Alchemy webhook address list returned non-JSON response');
    parseError.status = response.status;
    parseError.responseText = responseText;
    throw parseError;
  }

  const addresses = extractWatchedAddressesFromWebhookPayload(payload);

  alchemyAddressSyncLogger.info(
    {
      webhookId,
      watchedAddressCount: addresses.length
    },
    'Fetched watched addresses from Alchemy webhook'
  );

  return addresses;
}

async function addAddressToAlchemyWebhook({ chainId, address, walletId, reason }) {
  const normalizedAddress = normalizeAddress(address);
  const chainConfig = getChainConfigById(chainId);

  if (!chainConfig) {
    alchemyAddressSyncLogger.info(
      { chainId, address: normalizedAddress, walletId, reason },
      'Alchemy webhook address sync add skipped for unsupported chain'
    );
    return;
  }

  const webhookId = getAlchemyAddressActivityWebhookId(chainId);

  if (!env.ALCHEMY_NOTIFY_API_KEY || !webhookId) {
    alchemyAddressSyncLogger.info(
      { chainId, address: normalizedAddress, walletId, reason, ...buildConfigContext(chainId) },
      'Alchemy webhook address sync add skipped because configuration is incomplete'
    );
    return;
  }

  alchemyAddressSyncLogger.info(
    { chainId, address: normalizedAddress, walletId, reason },
    'Alchemy webhook address sync add started'
  );

  try {
    await updateAlchemyWebhookAddresses({
      chainId,
      addressesToAdd: [normalizedAddress]
    });

    alchemyAddressSyncLogger.info(
      { chainId, address: normalizedAddress, walletId, reason },
      'Alchemy webhook address sync add succeeded'
    );
  } catch (error) {
    if (isIdempotentAlchemyAddressSyncFailure(error.status, error.responseText)) {
      alchemyAddressSyncLogger.info(
        {
          chainId,
          address: normalizedAddress,
          walletId,
          reason,
          status: error.status
        },
        'Alchemy webhook address sync add treated as idempotent success'
      );
      return;
    }

    alchemyAddressSyncLogger.error(
      {
        err: error,
        chainId,
        address: normalizedAddress,
        walletId,
        reason,
        status: error.status
      },
      'Alchemy webhook address sync add failed'
    );
  }
}

async function removeAddressFromAlchemyWebhookIfUnused({ chainId, address, walletId, reason }) {
  const normalizedAddress = normalizeAddress(address);
  const chainConfig = getChainConfigById(chainId);

  if (!chainConfig) {
    alchemyAddressSyncLogger.info(
      { chainId, address: normalizedAddress, walletId, reason },
      'Alchemy webhook address sync remove skipped for unsupported chain'
    );
    return;
  }

  const remainingWalletCount = await countActiveWalletsByChainIdAndAddress(chainId, normalizedAddress);

  if (remainingWalletCount > 0) {
    alchemyAddressSyncLogger.info(
      {
        chainId,
        address: normalizedAddress,
        walletId,
        reason,
        remainingWalletCount
      },
      'Alchemy webhook address sync remove skipped because address is still used by another wallet'
    );
    return;
  }

  const webhookId = getAlchemyAddressActivityWebhookId(chainId);

  if (!env.ALCHEMY_NOTIFY_API_KEY || !webhookId) {
    alchemyAddressSyncLogger.info(
      { chainId, address: normalizedAddress, walletId, reason, ...buildConfigContext(chainId) },
      'Alchemy webhook address sync remove skipped because configuration is incomplete'
    );
    return;
  }

  alchemyAddressSyncLogger.info(
    { chainId, address: normalizedAddress, walletId, reason },
    'Alchemy webhook address sync remove started'
  );

  try {
    await updateAlchemyWebhookAddresses({
      chainId,
      addressesToRemove: [normalizedAddress]
    });

    alchemyAddressSyncLogger.info(
      { chainId, address: normalizedAddress, walletId, reason },
      'Alchemy webhook address sync remove succeeded'
    );
  } catch (error) {
    if (isIdempotentAlchemyAddressSyncFailure(error.status, error.responseText)) {
      alchemyAddressSyncLogger.info(
        {
          chainId,
          address: normalizedAddress,
          walletId,
          reason,
          status: error.status
        },
        'Alchemy webhook address sync remove treated as idempotent success'
      );
      return;
    }

    alchemyAddressSyncLogger.error(
      {
        err: error,
        chainId,
        address: normalizedAddress,
        walletId,
        reason,
        status: error.status
      },
      'Alchemy webhook address sync remove failed'
    );
  }
}

export async function syncAlchemyWebhookAddressOnWalletCreate(wallet) {
  for (const chainId of getWalletSyncChains(wallet)) {
    await addAddressToAlchemyWebhook({
      chainId,
      address: wallet.address,
      walletId: wallet.id,
      reason: 'wallet_created'
    });
  }
}

export async function syncAlchemyWebhookAddressOnWalletDelete(wallet) {
  for (const chainId of getWalletSyncChains(wallet)) {
    await removeAddressFromAlchemyWebhookIfUnused({
      chainId,
      address: wallet.address,
      walletId: wallet.id,
      reason: 'wallet_deleted'
    });
  }
}

export async function syncAlchemyWebhookAddressOnWalletUpdate(previousWallet, updatedWallet) {
  const previousAddress = normalizeAddress(previousWallet?.address);
  const nextAddress = normalizeAddress(updatedWallet?.address);
  const previousChains = getWalletSyncChains(previousWallet);
  const nextChains = getWalletSyncChains(updatedWallet);

  if (!previousWallet || !updatedWallet) {
    return;
  }

  const addressChanged = previousAddress !== nextAddress;
  const chainsAdded = nextChains.filter((chainId) => !previousChains.includes(chainId));
  const chainsRemoved = previousChains.filter((chainId) => !nextChains.includes(chainId));

  if (!addressChanged && chainsAdded.length === 0 && chainsRemoved.length === 0) {
    alchemyAddressSyncLogger.info(
      {
        walletId: updatedWallet?.id ?? previousWallet?.id ?? null,
        previousAddress,
        nextAddress,
        previousChains,
        nextChains
      },
      'Alchemy webhook address sync update skipped because wallet address and enabled chains did not change'
    );
    return;
  }

  const chainsToAdd = addressChanged ? nextChains : chainsAdded;

  for (const chainId of chainsToAdd) {
    await addAddressToAlchemyWebhook({
      chainId,
      address: updatedWallet.address,
      walletId: updatedWallet.id,
      reason: addressChanged ? 'wallet_address_updated_add_new' : 'wallet_chain_enabled'
    });
  }

  const chainsToRemove = addressChanged ? previousChains : chainsRemoved;

  for (const chainId of chainsToRemove) {
    await removeAddressFromAlchemyWebhookIfUnused({
      chainId,
      address: previousWallet.address,
      walletId: updatedWallet.id,
      reason: addressChanged ? 'wallet_address_updated_remove_old' : 'wallet_chain_disabled'
    });
  }
}

export async function addAddressToAlchemyWebhookSync({ chainId, address, reason = 'manual_sync', walletId = null }) {
  await addAddressToAlchemyWebhook({ chainId, address, reason, walletId });
}

export async function removeAddressFromAlchemyWebhookSync({ chainId, address, reason = 'manual_sync', walletId = null }) {
  const normalizedAddress = normalizeAddress(address);
  const chainConfig = getChainConfigById(chainId);

  if (!chainConfig) {
    alchemyAddressSyncLogger.info(
      { chainId, address: normalizedAddress, walletId, reason },
      'Alchemy webhook address sync remove skipped for unsupported chain'
    );
    return;
  }

  const webhookId = getAlchemyAddressActivityWebhookId(chainId);

  if (!env.ALCHEMY_NOTIFY_API_KEY || !webhookId) {
    alchemyAddressSyncLogger.info(
      { chainId, address: normalizedAddress, walletId, reason, ...buildConfigContext(chainId) },
      'Alchemy webhook address sync remove skipped because configuration is incomplete'
    );
    return;
  }

  alchemyAddressSyncLogger.info(
    { chainId, address: normalizedAddress, walletId, reason },
    'Alchemy webhook address sync remove started'
  );

  try {
    await updateAlchemyWebhookAddresses({
      chainId,
      addressesToRemove: [normalizedAddress]
    });

    alchemyAddressSyncLogger.info(
      { chainId, address: normalizedAddress, walletId, reason },
      'Alchemy webhook address sync remove succeeded'
    );
  } catch (error) {
    if (isIdempotentAlchemyAddressSyncFailure(error.status, error.responseText)) {
      alchemyAddressSyncLogger.info(
        {
          chainId,
          address: normalizedAddress,
          walletId,
          reason,
          status: error.status
        },
        'Alchemy webhook address sync remove treated as idempotent success'
      );
      return;
    }

    alchemyAddressSyncLogger.error(
      {
        err: error,
        chainId,
        address: normalizedAddress,
        walletId,
        reason,
        status: error.status
      },
      'Alchemy webhook address sync remove failed'
    );
  }
}
