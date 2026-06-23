import { formatEther, formatUnits, getAddress } from 'ethers';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../utils/httpError.js';
import {
  ETHEREUM_MAINNET_CHAIN_ID,
  getExplorerTxBaseUrl,
  resolveChainIdFromAlchemyWebhookNetwork
} from '../chains/chains.config.js';
import { detectNativeEthImpersonation } from '../events/eventSpamFilter.js';
import { insertWalletEvents } from '../events/events.repository.js';
import { findTrackedWalletsByAddresses } from '../wallets/wallets.repository.js';

const webhookLogger = logger.child({ module: 'alchemy-webhook' });

function normalizeAddress(address) {
  if (!address) {
    return null;
  }

  try {
    return getAddress(address).toLowerCase();
  } catch {
    return address.toLowerCase();
  }
}

function parseBlockNumber(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return value.startsWith('0x') ? parseInt(value, 16) : Number(value);
  }

  return null;
}

function parseLogIndex(value) {
  const parsed = parseBlockNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestamp(input) {
  if (input) {
    return new Date(input).toISOString();
  }

  return new Date().toISOString();
}

function resolveWebhookNetwork(network) {
  return resolveChainIdFromAlchemyWebhookNetwork(network);
}

function getRawContractValue(activity) {
  return activity.rawContract?.rawValue ?? activity.rawContract?.value ?? null;
}

function hasPositiveRawValue(value) {
  if (value == null) {
    return false;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (trimmed === '') {
      return false;
    }

    try {
      return BigInt(trimmed) > 0n;
    } catch {
      const numericValue = Number(trimmed);
      return Number.isFinite(numericValue) && numericValue > 0;
    }
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0;
  }

  return false;
}

function buildExplorerUrl(chainId, transactionHash) {
  const baseUrl = getExplorerTxBaseUrl(chainId);

  if (!baseUrl) {
    return null;
  }

  return `${baseUrl}${transactionHash}`;
}

function resolveDirection(wallet, fromAddress, toAddress) {
  if (wallet.address === fromAddress) {
    return 'outgoing';
  }

  if (wallet.address === toAddress) {
    return 'incoming';
  }

  return null;
}

function determineAlchemyEventKind(activity) {
  const category = activity.category.toLowerCase();
  const hasErc1155 = Array.isArray(activity.erc1155Metadata) && activity.erc1155Metadata.length > 0;
  const hasErc721 = activity.erc721TokenId != null;
  const contractAddress = activity.rawContract?.address ?? activity.log?.address ?? null;

  if (hasErc1155 || category.includes('erc1155')) {
    return {
      eventType: 'nft_transfer',
      assetType: 'nft',
      tokenStandard: 'erc1155',
      contractAddress: contractAddress ? normalizeAddress(contractAddress) : null
    };
  }

  if (hasErc721 || category.includes('erc721')) {
    return {
      eventType: 'nft_transfer',
      assetType: 'nft',
      tokenStandard: 'erc721',
      contractAddress: contractAddress ? normalizeAddress(contractAddress) : null
    };
  }

  if (category === 'token' || category.includes('erc20')) {
    return {
      eventType: 'token_transfer',
      assetType: 'token',
      tokenStandard: 'erc20',
      contractAddress: contractAddress ? normalizeAddress(contractAddress) : null
    };
  }

  return {
    eventType: 'native_transfer',
    assetType: 'coin',
    tokenStandard: 'native',
    contractAddress: null
  };
}

function buildLifecycleContext({ transactionHash, blockNumber, contractAddress, fromAddress, toAddress, eventType, wallets }) {
  const matchedWalletIds = wallets.map((wallet) => wallet.id);

  return {
    transactionHash,
    blockNumber,
    contractAddress,
    fromAddress,
    toAddress,
    eventType,
    fromAddressMatched: wallets.some((wallet) => wallet.address === fromAddress),
    toAddressMatched: wallets.some((wallet) => wallet.address === toAddress),
    matchedWalletIds,
    matched: wallets.length > 0
  };
}

function buildEventBase({ wallet, activity, chainId, blockNumber, logIndex, fromAddress, toAddress, occurredAt, eventType, assetType, assetSymbol, assetName, amount, amountWei, nftContractAddress, nftTokenId, tokenStandard, contractAddress, lifecycle }) {
  return {
    walletId: wallet.id,
    chainId,
    transactionHash: activity.hash,
    eventType,
    assetType,
    assetSymbol,
    assetName,
    amount,
    nftContractAddress,
    nftTokenId,
    marketplace: null,
    occurredAt,
    explorerUrl: buildExplorerUrl(chainId, activity.hash),
    rawPayload: {
      source: 'alchemy-webhook',
      tokenStandard,
      contractAddress,
      activity,
      walletId: wallet.id
    },
    blockNumber,
    logIndex,
    fromAddress,
    toAddress,
    amountWei,
    direction: resolveDirection(wallet, fromAddress, toAddress),
    lifecycle
  };
}

function normalizeAlchemyActivityToEvents({ activity, chainId, createdAt, trackedWalletsByAddress }) {
  const fromAddress = normalizeAddress(activity.fromAddress);
  const toAddress = normalizeAddress(activity.toAddress);
  const fromWallets = trackedWalletsByAddress.get(fromAddress) ?? [];
  const toWallets = trackedWalletsByAddress.get(toAddress) ?? [];
  const candidateWallets = new Map();

  for (const wallet of fromWallets) {
    candidateWallets.set(wallet.id, wallet);
  }

  for (const wallet of toWallets) {
    candidateWallets.set(wallet.id, wallet);
  }

  const activityKind = determineAlchemyEventKind(activity);
  const candidateWalletList = [...candidateWallets.values()];
  const wallets = candidateWalletList.filter((wallet) => wallet.trackTypes.includes(activityKind.eventType));
  const blockNumber = parseBlockNumber(activity.blockNum);
  const logIndex = parseLogIndex(activity.log?.logIndex);
  const occurredAt = normalizeTimestamp(createdAt);
  const lifecycle = buildLifecycleContext({
    transactionHash: activity.hash,
    blockNumber,
    contractAddress: activityKind.contractAddress,
    fromAddress,
    toAddress,
    eventType: activityKind.eventType,
    wallets
  });

  webhookLogger.info({
    transactionHash: activity.hash,
    blockNumber,
    contractAddress: activityKind.contractAddress,
    fromAddress,
    toAddress,
    category: activity.category,
    eventType: activityKind.eventType,
    fromAddressCandidateWalletIds: fromWallets.map((wallet) => wallet.id),
    toAddressCandidateWalletIds: toWallets.map((wallet) => wallet.id),
    candidateWalletIds: candidateWalletList.map((wallet) => wallet.id),
    candidateWalletUsers: candidateWalletList.map((wallet) => ({
      walletId: wallet.id,
      userId: wallet.userId,
      trackTypes: wallet.trackTypes
    })),
    matchedWalletIds: lifecycle.matchedWalletIds,
    matched: lifecycle.matched
  }, 'Normalized Alchemy webhook activity');

  if (wallets.length === 0) {
    const rejectionReason =
      candidateWalletList.length === 0 ? 'address_mismatch' : 'track_type_filter';

    webhookLogger.info({
      transactionHash: activity.hash,
      blockNumber,
      eventType: activityKind.eventType,
      outcome: 'rejected',
      rejectionReason,
      candidateWalletIds: candidateWalletList.map((wallet) => wallet.id),
      candidateWalletUsers: candidateWalletList.map((wallet) => ({
        walletId: wallet.id,
        userId: wallet.userId,
        trackTypes: wallet.trackTypes
      }))
    }, 'Alchemy webhook activity did not match any tracked wallet');
    return [];
  }

  if (activityKind.tokenStandard === 'erc1155') {
    return wallets.flatMap((wallet) =>
      (activity.erc1155Metadata ?? []).map((item, index) =>
        buildEventBase({
          wallet,
          activity,
          chainId,
          blockNumber,
          logIndex: logIndex != null ? logIndex + index : null,
          fromAddress,
          toAddress,
          occurredAt,
          eventType: 'nft_transfer',
          assetType: 'nft',
          assetSymbol: activity.asset ?? 'NFT',
          assetName: activity.asset ?? 'NFT',
          amount: item.value != null ? String(item.value) : '1',
          amountWei: null,
          nftContractAddress: activityKind.contractAddress,
          nftTokenId: item.tokenId,
          tokenStandard: 'erc1155',
          contractAddress: activityKind.contractAddress,
          lifecycle
        })
      )
    );
  }

  if (activityKind.tokenStandard === 'erc721') {
    return wallets.map((wallet) =>
      buildEventBase({
        wallet,
        activity,
        chainId,
        blockNumber,
        logIndex,
        fromAddress,
        toAddress,
        occurredAt,
        eventType: 'nft_transfer',
        assetType: 'nft',
        assetSymbol: activity.asset ?? 'NFT',
        assetName: activity.asset ?? 'NFT',
        amount: '1',
        amountWei: null,
        nftContractAddress: activityKind.contractAddress,
        nftTokenId: activity.erc721TokenId,
        tokenStandard: 'erc721',
        contractAddress: activityKind.contractAddress,
        lifecycle
      })
    );
  }

  if (activityKind.tokenStandard === 'erc20') {
    const decimals = activity.rawContract?.decimals != null ? Number(activity.rawContract.decimals) : 18;
    const rawValue = getRawContractValue(activity);
    const amount = rawValue != null ? formatUnits(rawValue, decimals) : activity.value != null ? String(activity.value) : null;
    const impersonationCheck = detectNativeEthImpersonation({
      chainId,
      eventType: 'token_transfer',
      tokenStandard: 'erc20',
      contractAddress: activityKind.contractAddress,
      assetSymbol: activity.asset ?? null,
      assetName: activity.asset ?? null
    });

    if (impersonationCheck.shouldReject) {
      webhookLogger.info({
        transactionHash: activity.hash,
        blockNumber,
        contractAddress: activityKind.contractAddress,
        fromAddress,
        toAddress,
        eventType: 'token_transfer',
        assetSymbol: activity.asset ?? null,
        assetName: activity.asset ?? null,
        normalizedSymbol: impersonationCheck.normalizedSymbol,
        normalizedName: impersonationCheck.normalizedName,
        matchedWalletIds: lifecycle.matchedWalletIds,
        matched: lifecycle.matched,
        outcome: 'rejected',
        rejectionReason: impersonationCheck.rejectionReason
      }, 'Alchemy ERC-20 transfer skipped because token impersonates native ETH');

      return [];
    }

    return wallets.map((wallet) =>
      buildEventBase({
        wallet,
        activity,
        chainId,
        blockNumber,
        logIndex,
        fromAddress,
        toAddress,
        occurredAt,
        eventType: 'token_transfer',
        assetType: 'token',
        assetSymbol: activity.asset ?? null,
        assetName: activity.asset ?? null,
        amount,
        amountWei: null,
        nftContractAddress: null,
        nftTokenId: null,
        tokenStandard: 'erc20',
        contractAddress: activityKind.contractAddress,
        lifecycle
      })
    );
  }

  const nativeWei = getRawContractValue(activity);
  const nativeValue = activity.value;
  const hasPositiveNativeWei = hasPositiveRawValue(nativeWei);
  const hasPositiveNativeValue = hasPositiveRawValue(nativeValue);

  if (!hasPositiveNativeWei && !hasPositiveNativeValue) {
    webhookLogger.info({
      transactionHash: activity.hash,
      blockNumber,
      fromAddress,
      toAddress,
      category: activity.category,
      rawContractValue: nativeWei,
      activityValue: nativeValue,
      outcome: 'rejected',
      rejectionReason: 'zero_native_amount'
    }, 'Alchemy native transfer skipped because amount is zero');
    return [];
  }

  const nativeAmount = hasPositiveNativeWei
    ? formatEther(nativeWei)
    : nativeValue != null
      ? String(nativeValue)
      : null;

  return wallets.map((wallet) =>
    buildEventBase({
      wallet,
      activity,
      chainId,
      blockNumber,
      logIndex,
      fromAddress,
      toAddress,
      occurredAt,
      eventType: 'native_transfer',
      assetType: 'coin',
      assetSymbol: activity.asset ?? 'ETH',
      assetName: activity.asset ?? 'ETH',
      amount: nativeAmount,
      amountWei: nativeWei,
      nftContractAddress: null,
      nftTokenId: null,
      tokenStandard: 'native',
      contractAddress: null,
      lifecycle
    })
  );
}

export async function handleAlchemyWebhook(payload) {
  const chainId = resolveWebhookNetwork(payload.event.network);

  if (!chainId) {
    throw new HttpError(400, 'UNSUPPORTED_WEBHOOK_NETWORK', `Unsupported Alchemy webhook network: ${payload.event.network}`);
  }

  const normalizedAddresses = new Set();

  for (const activity of payload.event.activity) {
    normalizedAddresses.add(normalizeAddress(activity.fromAddress));
    normalizedAddresses.add(normalizeAddress(activity.toAddress));
  }

  normalizedAddresses.delete(null);

  const trackedWallets = await findTrackedWalletsByAddresses(chainId, [...normalizedAddresses]);
  const trackedWalletsByAddress = new Map();

  for (const wallet of trackedWallets) {
    const group = trackedWalletsByAddress.get(wallet.address) ?? [];
    group.push(wallet);
    trackedWalletsByAddress.set(wallet.address, group);
  }

  const normalizedEvents = payload.event.activity.flatMap((activity) =>
    normalizeAlchemyActivityToEvents({
      activity,
      chainId,
      createdAt: payload.createdAt,
      trackedWalletsByAddress
    })
  );

  webhookLogger.info({
    webhookId: payload.webhookId,
    network: payload.event.network,
    activityCount: payload.event.activity.length,
    trackedWalletsConsidered: trackedWallets.length,
    trackedWallets: trackedWallets.map((wallet) => ({
      walletId: wallet.id,
      userId: wallet.userId,
      address: wallet.address,
      trackTypes: wallet.trackTypes
    })),
    normalizedEventsCount: normalizedEvents.length
  }, 'Processed Alchemy webhook payload');

  const insertedEvents = await insertWalletEvents(normalizedEvents, webhookLogger);

  webhookLogger.info({
    webhookId: payload.webhookId,
    normalizedEventsCount: normalizedEvents.length,
    insertedWalletEventsCount: insertedEvents.length,
    insertedWalletEventIds: insertedEvents.map((event) => event.id)
  }, 'Alchemy webhook insert summary');

  return {
    accepted: true,
    chainId,
    receivedActivities: payload.event.activity.length,
    normalizedEvents: normalizedEvents.length,
    insertedEvents: insertedEvents.length
  };
}
