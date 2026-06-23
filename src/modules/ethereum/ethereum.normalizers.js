import { Interface, ZeroAddress, formatEther, formatUnits, getAddress, zeroPadValue } from 'ethers';
import {
  ERC1155_INTERFACE_ID,
  ERC1155_TRANSFER_BATCH_TOPIC,
  ERC1155_TRANSFER_SINGLE_TOPIC,
  ERC165_ABI,
  ERC20_ERC721_TRANSFER_TOPIC,
  ERC20_METADATA_ABI,
  ERC721_INTERFACE_ID,
  ETHEREUM_EXPLORER_TX_BASE_URL,
  ETHEREUM_MAINNET_CHAIN_ID
} from './ethereum.constants.js';
import { detectNativeEthImpersonation } from '../events/eventSpamFilter.js';

const erc721TransferInterface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
const erc20TransferInterface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const erc1155TransferSingleInterface = new Interface([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)'
]);
const erc1155TransferBatchInterface = new Interface([
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
]);
const erc165Interface = new Interface(ERC165_ABI);
const erc20MetadataInterface = new Interface(ERC20_METADATA_ABI);

function toLowerAddress(address) {
  return address ? getAddress(address).toLowerCase() : null;
}

function serializeValue(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, serializeValue(nestedValue)]));
  }

  return value;
}

function toIsoDate(block) {
  return new Date(Number(block.timestamp) * 1_000).toISOString();
}

function buildExplorerUrl(transactionHash) {
  return `${ETHEREUM_EXPLORER_TX_BASE_URL}${transactionHash}`;
}

function resolveDirection(wallet, fromAddress, toAddress) {
  const walletAddress = wallet.address.toLowerCase();

  if (fromAddress === walletAddress) {
    return 'outgoing';
  }

  if (toAddress === walletAddress) {
    return 'incoming';
  }

  return null;
}

async function callOptional(execute) {
  try {
    return await execute();
  } catch {
    return null;
  }
}

export class EthereumContractMetadataCache {
  constructor(provider, rpcCall = null) {
    this.provider = provider;
    this.rpcCall = rpcCall;
    this.cache = new Map();
  }

  async get(contractAddress) {
    const key = contractAddress.toLowerCase();

    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    const metadata = await this.load(contractAddress);
    this.cache.set(key, metadata);
    return metadata;
  }

  async load(contractAddress) {
    const rpcCall = async (operation, transaction) => {
      if (this.rpcCall) {
        return this.rpcCall(operation, () => this.provider.call(transaction), {
          contractAddress: contractAddress.toLowerCase()
        });
      }

      return this.provider.call(transaction);
    };

    const callAndDecode = async (operation, iface, fragment, args = []) => {
      const data = iface.encodeFunctionData(fragment, args);
      const response = await rpcCall(operation, {
        to: contractAddress,
        data
      });
      const [decoded] = iface.decodeFunctionResult(fragment, response);
      return decoded;
    };

    const [isErc721, isErc1155, symbol, name, decimals] = await Promise.all([
      callOptional(() => callAndDecode('supportsInterface', erc165Interface, 'supportsInterface', [ERC721_INTERFACE_ID])),
      callOptional(() => callAndDecode('supportsInterface', erc165Interface, 'supportsInterface', [ERC1155_INTERFACE_ID])),
      callOptional(() => callAndDecode('symbol', erc20MetadataInterface, 'symbol')),
      callOptional(() => callAndDecode('name', erc20MetadataInterface, 'name')),
      callOptional(() => callAndDecode('decimals', erc20MetadataInterface, 'decimals'))
    ]);

    return {
      isErc721: Boolean(isErc721),
      isErc1155: Boolean(isErc1155),
      symbol: typeof symbol === 'string' ? symbol : null,
      name: typeof name === 'string' ? name : null,
      decimals: typeof decimals === 'number' ? decimals : decimals != null ? Number(decimals) : 18
    };
  }
}

function buildBaseRawPayload(log, parsedLog, block, fromAddress, toAddress) {
  return {
    blockNumber: Number(log.blockNumber),
    transactionHash: log.transactionHash,
    logIndex: Number(log.index),
    contractAddress: log.address,
    topic0: log.topics[0],
    fromAddress,
    toAddress,
    parsedArgs: Object.fromEntries(
      Object.entries(parsedLog.args)
        .filter(([key]) => Number.isNaN(Number(key)))
        .map(([key, value]) => [key, serializeValue(value)])
    ),
    blockTimestamp: Number(block.timestamp)
  };
}

function buildLifecycleContext({
  transactionHash,
  blockNumber,
  contractAddress,
  fromAddress,
  toAddress,
  eventType,
  trackedWalletsByAddress
}) {
  const fromWallets = fromAddress ? trackedWalletsByAddress.get(fromAddress) ?? [] : [];
  const toWallets = toAddress ? trackedWalletsByAddress.get(toAddress) ?? [] : [];
  const matchedWallets = new Map();

  for (const wallet of [...fromWallets, ...toWallets]) {
    if (wallet.trackTypes.includes(eventType)) {
      matchedWallets.set(wallet.id, wallet);
    }
  }

  const fromAddressMatched = fromWallets.some((wallet) => wallet.trackTypes.includes(eventType));
  const toAddressMatched = toWallets.some((wallet) => wallet.trackTypes.includes(eventType));

  return {
    transactionHash,
    blockNumber,
    contractAddress,
    fromAddress,
    toAddress,
    eventType,
    fromAddressMatched,
    toAddressMatched,
    matchedWalletIds: [...matchedWallets.keys()],
    matchedWallets: [...matchedWallets.values()]
  };
}

function inferRejectionReason({ fromAddressMatched, toAddressMatched, trackedWalletsByAddress, fromAddress, toAddress, eventType }) {
  const fromWallets = fromAddress ? trackedWalletsByAddress.get(fromAddress) ?? [] : [];
  const toWallets = toAddress ? trackedWalletsByAddress.get(toAddress) ?? [] : [];
  const addressSeen = fromWallets.length > 0 || toWallets.length > 0;

  if (!addressSeen) {
    return 'address_mismatch';
  }

  if (!fromAddressMatched && !toAddressMatched) {
    return `track_type_filter:${eventType}`;
  }

  return 'unknown';
}

function logLifecycle(logger, payload) {
  logger.info(payload, 'Ethereum event lifecycle');
}

function shouldTraceLifecycle(lifecycle, traceConfig) {
  if (!traceConfig) {
    return false;
  }

  if (traceConfig.txHash && lifecycle.transactionHash.toLowerCase() === traceConfig.txHash) {
    return true;
  }

  if (traceConfig.fromAddress && traceConfig.toAddress) {
    return lifecycle.fromAddress === traceConfig.fromAddress && lifecycle.toAddress === traceConfig.toAddress;
  }

  return false;
}

export async function normalizeTransferLog({
  provider,
  log,
  trackedWalletsByAddress,
  metadataCache,
  blockCache,
  logger,
  traceConfig
}) {
  const blockNumber = Number(log.blockNumber);
  let block = blockCache.get(blockNumber);

  if (!block) {
    block = await provider.getBlock(blockNumber);
    blockCache.set(blockNumber, block);
  }

  if (log.topics[0] === ERC20_ERC721_TRANSFER_TOPIC) {
    const isErc721Layout = log.topics.length === 4;
    const isErc20Layout = log.topics.length === 3;

    if (!isErc721Layout && !isErc20Layout) {
      throw new Error(`Unsupported Transfer log layout with ${log.topics.length} topics`);
    }

    const parsedLog = isErc721Layout
      ? erc721TransferInterface.parseLog(log)
      : erc20TransferInterface.parseLog(log);
    const fromAddress = toLowerAddress(getAddress(parsedLog.args.from));
    const toAddress = toLowerAddress(getAddress(parsedLog.args.to));
    const contractMetadata = await metadataCache.get(log.address);
    const isNft = isErc721Layout || contractMetadata.isErc721;
    const eventType = isNft ? 'nft_transfer' : 'token_transfer';
    const lifecycle = buildLifecycleContext({
      transactionHash: log.transactionHash,
      blockNumber,
      contractAddress: log.address,
      fromAddress,
      toAddress,
      eventType,
      trackedWalletsByAddress
    });

    if (lifecycle.matchedWallets.length === 0) {
      logLifecycle(logger, {
        ...lifecycle,
        decodedPreview: isNft
          ? { tokenId: parsedLog.args.tokenId.toString(), layout: 'erc721' }
          : { value: parsedLog.args.value.toString(), layout: 'erc20' },
        matched: false,
        outcome: 'rejected',
        rejectionReason: inferRejectionReason({
          ...lifecycle,
          trackedWalletsByAddress
        }),
        insertQueryRan: false
      });

      if (shouldTraceLifecycle(lifecycle, traceConfig)) {
        logger.warn({
          ...lifecycle,
          decodedPreview: isNft
            ? { tokenId: parsedLog.args.tokenId.toString(), layout: 'erc721' }
            : { value: parsedLog.args.value.toString(), layout: 'erc20' },
          matched: false,
          outcome: 'rejected',
          rejectionReason: inferRejectionReason({
            ...lifecycle,
            trackedWalletsByAddress
          }),
          insertQueryRan: false
        }, 'Targeted Ethereum trace event');
      }
      return [];
    }

    const rawPayload = buildBaseRawPayload(log, parsedLog, block, fromAddress, toAddress);
    const impersonationCheck = !isNft
      ? detectNativeEthImpersonation({
          chainId: ETHEREUM_MAINNET_CHAIN_ID,
          eventType: 'token_transfer',
          tokenStandard: 'erc20',
          contractAddress: log.address,
          assetSymbol: contractMetadata.symbol,
          assetName: contractMetadata.name
        })
      : { shouldReject: false };

    if (!isNft && impersonationCheck.shouldReject) {
      logLifecycle(logger, {
        ...lifecycle,
        decodedPreview: {
          value: parsedLog.args.value.toString(),
          layout: 'erc20',
          assetSymbol: contractMetadata.symbol,
          assetName: contractMetadata.name,
          normalizedSymbol: impersonationCheck.normalizedSymbol,
          normalizedName: impersonationCheck.normalizedName
        },
        matched: true,
        outcome: 'rejected',
        rejectionReason: impersonationCheck.rejectionReason,
        insertQueryRan: false
      });

      if (shouldTraceLifecycle(lifecycle, traceConfig)) {
        logger.warn({
          ...lifecycle,
          decodedPreview: {
            value: parsedLog.args.value.toString(),
            layout: 'erc20',
            assetSymbol: contractMetadata.symbol,
            assetName: contractMetadata.name,
            normalizedSymbol: impersonationCheck.normalizedSymbol,
            normalizedName: impersonationCheck.normalizedName
          },
          matched: true,
          outcome: 'rejected',
          rejectionReason: impersonationCheck.rejectionReason,
          insertQueryRan: false
        }, 'Targeted Ethereum trace event');
      }

      return [];
    }

    const events = lifecycle.matchedWallets.map((wallet) => ({
      walletId: wallet.id,
      chainId: ETHEREUM_MAINNET_CHAIN_ID,
      transactionHash: log.transactionHash,
      eventType,
      assetType: isNft ? 'nft' : 'token',
      assetSymbol: contractMetadata.symbol,
      assetName: contractMetadata.name,
      amount: isNft ? '1' : formatUnits(parsedLog.args.value, contractMetadata.decimals ?? 18),
      nftContractAddress: isNft ? log.address.toLowerCase() : null,
      nftTokenId: isNft ? parsedLog.args.tokenId.toString() : null,
      marketplace: null,
      occurredAt: toIsoDate(block),
      explorerUrl: buildExplorerUrl(log.transactionHash),
      rawPayload,
      blockNumber,
      logIndex: Number(log.index),
      fromAddress,
      toAddress,
      amountWei: null,
      direction: resolveDirection(wallet, fromAddress, toAddress),
      lifecycle: {
        ...lifecycle,
        decodedPreview: isNft
          ? { tokenId: parsedLog.args.tokenId.toString(), layout: 'erc721' }
          : { value: parsedLog.args.value.toString(), layout: 'erc20' },
        matched: true
      }
    }));

    if (shouldTraceLifecycle(lifecycle, traceConfig)) {
      logger.warn({
        ...lifecycle,
        decodedPreview: isNft
          ? { tokenId: parsedLog.args.tokenId.toString(), layout: 'erc721' }
          : { value: parsedLog.args.value.toString(), layout: 'erc20' },
        matched: true,
        outcome: 'ready_for_insert',
        rejectionReason: null,
        insertQueryRan: false
      }, 'Targeted Ethereum trace event');
    }

    return events;
  }

  if (log.topics[0] === ERC1155_TRANSFER_SINGLE_TOPIC) {
    const parsedLog = erc1155TransferSingleInterface.parseLog(log);
    const fromAddress = toLowerAddress(getAddress(parsedLog.args.from));
    const toAddress = toLowerAddress(getAddress(parsedLog.args.to));
    const lifecycle = buildLifecycleContext({
      transactionHash: log.transactionHash,
      blockNumber,
      contractAddress: log.address,
      fromAddress,
      toAddress,
      eventType: 'nft_transfer',
      trackedWalletsByAddress
    });

    if (lifecycle.matchedWallets.length === 0) {
      logLifecycle(logger, {
        ...lifecycle,
        decodedPreview: {
          id: parsedLog.args.id.toString(),
          value: parsedLog.args.value.toString(),
          layout: 'erc1155_single'
        },
        matched: false,
        outcome: 'rejected',
        rejectionReason: inferRejectionReason({
          ...lifecycle,
          trackedWalletsByAddress
        }),
        insertQueryRan: false
      });

      if (shouldTraceLifecycle(lifecycle, traceConfig)) {
        logger.warn({
          ...lifecycle,
          decodedPreview: {
            id: parsedLog.args.id.toString(),
            value: parsedLog.args.value.toString(),
            layout: 'erc1155_single'
          },
          matched: false,
          outcome: 'rejected',
          rejectionReason: inferRejectionReason({
            ...lifecycle,
            trackedWalletsByAddress
          }),
          insertQueryRan: false
        }, 'Targeted Ethereum trace event');
      }
      return [];
    }

    const contractMetadata = await metadataCache.get(log.address);
    const rawPayload = buildBaseRawPayload(log, parsedLog, block, fromAddress, toAddress);

    const events = lifecycle.matchedWallets.map((wallet) => ({
      walletId: wallet.id,
      chainId: ETHEREUM_MAINNET_CHAIN_ID,
      transactionHash: log.transactionHash,
      eventType: 'nft_transfer',
      assetType: 'nft',
      assetSymbol: contractMetadata.symbol,
      assetName: contractMetadata.name,
      amount: parsedLog.args.value.toString(),
      nftContractAddress: log.address.toLowerCase(),
      nftTokenId: parsedLog.args.id.toString(),
      marketplace: null,
      occurredAt: toIsoDate(block),
      explorerUrl: buildExplorerUrl(log.transactionHash),
      rawPayload,
      blockNumber,
      logIndex: Number(log.index),
      fromAddress,
      toAddress,
      amountWei: null,
      direction: resolveDirection(wallet, fromAddress, toAddress),
      lifecycle: {
        ...lifecycle,
        decodedPreview: {
          id: parsedLog.args.id.toString(),
          value: parsedLog.args.value.toString(),
          layout: 'erc1155_single'
        },
        matched: true
      }
    }));

    if (shouldTraceLifecycle(lifecycle, traceConfig)) {
      logger.warn({
        ...lifecycle,
        decodedPreview: {
          id: parsedLog.args.id.toString(),
          value: parsedLog.args.value.toString(),
          layout: 'erc1155_single'
        },
        matched: true,
        outcome: 'ready_for_insert',
        rejectionReason: null,
        insertQueryRan: false
      }, 'Targeted Ethereum trace event');
    }

    return events;
  }

  if (log.topics[0] === ERC1155_TRANSFER_BATCH_TOPIC) {
    const parsedLog = erc1155TransferBatchInterface.parseLog(log);
    const fromAddress = toLowerAddress(getAddress(parsedLog.args.from));
    const toAddress = toLowerAddress(getAddress(parsedLog.args.to));
    const lifecycle = buildLifecycleContext({
      transactionHash: log.transactionHash,
      blockNumber,
      contractAddress: log.address,
      fromAddress,
      toAddress,
      eventType: 'nft_transfer',
      trackedWalletsByAddress
    });

    if (lifecycle.matchedWallets.length === 0) {
      logLifecycle(logger, {
        ...lifecycle,
        decodedPreview: {
          ids: parsedLog.args.ids.map((value) => value.toString()),
          values: parsedLog.args.values.map((value) => value.toString()),
          layout: 'erc1155_batch'
        },
        matched: false,
        outcome: 'rejected',
        rejectionReason: inferRejectionReason({
          ...lifecycle,
          trackedWalletsByAddress
        }),
        insertQueryRan: false
      });

      if (shouldTraceLifecycle(lifecycle, traceConfig)) {
        logger.warn({
          ...lifecycle,
          decodedPreview: {
            ids: parsedLog.args.ids.map((value) => value.toString()),
            values: parsedLog.args.values.map((value) => value.toString()),
            layout: 'erc1155_batch'
          },
          matched: false,
          outcome: 'rejected',
          rejectionReason: inferRejectionReason({
            ...lifecycle,
            trackedWalletsByAddress
          }),
          insertQueryRan: false
        }, 'Targeted Ethereum trace event');
      }
      return [];
    }

    const contractMetadata = await metadataCache.get(log.address);
    const rawPayload = buildBaseRawPayload(log, parsedLog, block, fromAddress, toAddress);

    const events = parsedLog.args.ids.flatMap((tokenId, tokenIndex) =>
      lifecycle.matchedWallets.map((wallet) => ({
        walletId: wallet.id,
        chainId: ETHEREUM_MAINNET_CHAIN_ID,
        transactionHash: log.transactionHash,
        eventType: 'nft_transfer',
        assetType: 'nft',
        assetSymbol: contractMetadata.symbol,
        assetName: contractMetadata.name,
        amount: parsedLog.args.values[tokenIndex].toString(),
        nftContractAddress: log.address.toLowerCase(),
        nftTokenId: tokenId.toString(),
        marketplace: null,
        occurredAt: toIsoDate(block),
        explorerUrl: buildExplorerUrl(log.transactionHash),
        rawPayload: {
          ...rawPayload,
          batchIndex: tokenIndex
        },
        blockNumber,
        logIndex: Number(log.index) * 1_000 + tokenIndex,
        fromAddress,
        toAddress,
        amountWei: null,
        direction: resolveDirection(wallet, fromAddress, toAddress),
        lifecycle: {
          ...lifecycle,
          decodedPreview: {
            ids: parsedLog.args.ids.map((value) => value.toString()),
            values: parsedLog.args.values.map((value) => value.toString()),
            layout: 'erc1155_batch',
            batchIndex: tokenIndex
          },
          matched: true
        }
      }))
    );

    if (shouldTraceLifecycle(lifecycle, traceConfig)) {
      logger.warn({
        ...lifecycle,
        decodedPreview: {
          ids: parsedLog.args.ids.map((value) => value.toString()),
          values: parsedLog.args.values.map((value) => value.toString()),
          layout: 'erc1155_batch'
        },
        matched: true,
        outcome: 'ready_for_insert',
        rejectionReason: null,
        insertQueryRan: false
      }, 'Targeted Ethereum trace event');
    }

    return events;
  }

  return [];
}

export function toTopicAddress(address) {
  return zeroPadValue(getAddress(address), 32).toLowerCase();
}

export function isZeroAddress(address) {
  return address === ZeroAddress.toLowerCase();
}

export function normalizeNativeTransfer({ block, transaction, trackedWalletsByAddress, logger, traceConfig }) {
  if (!transaction.to || transaction.value <= 0n) {
    return [];
  }

  const fromAddress = transaction.from.toLowerCase();
  const toAddress = transaction.to.toLowerCase();
  const lifecycle = buildLifecycleContext({
    transactionHash: transaction.hash,
    blockNumber: Number(block.number),
    contractAddress: null,
    fromAddress,
    toAddress,
    eventType: 'native_transfer',
    trackedWalletsByAddress
  });

  if (lifecycle.matchedWallets.length === 0) {
    logLifecycle(logger, {
      ...lifecycle,
      decodedPreview: {
        amountWei: transaction.value.toString(),
        amountEth: formatEther(transaction.value),
        layout: 'native_transfer'
      },
      matched: false,
      outcome: 'rejected',
      rejectionReason: inferRejectionReason({
        ...lifecycle,
        trackedWalletsByAddress
      }),
      insertQueryRan: false
    });

    if (shouldTraceLifecycle(lifecycle, traceConfig)) {
      logger.warn({
        ...lifecycle,
        decodedPreview: {
          amountWei: transaction.value.toString(),
          amountEth: formatEther(transaction.value),
          layout: 'native_transfer'
        },
        matched: false,
        outcome: 'rejected',
        rejectionReason: inferRejectionReason({
          ...lifecycle,
          trackedWalletsByAddress
        }),
        insertQueryRan: false
      }, 'Targeted Ethereum trace event');
    }
    return [];
  }

  const amountWei = transaction.value.toString();
  const amountEth = formatEther(transaction.value);
  const occurredAt = toIsoDate(block);

  const events = lifecycle.matchedWallets.map((wallet) => {
    const direction = resolveDirection(wallet, fromAddress, toAddress);

    return {
      walletId: wallet.id,
      chainId: ETHEREUM_MAINNET_CHAIN_ID,
      transactionHash: transaction.hash,
      eventType: 'native_transfer',
      assetType: 'coin',
      assetSymbol: 'ETH',
      assetName: 'Ethereum',
      amount: amountEth,
      nftContractAddress: null,
      nftTokenId: null,
      marketplace: null,
      occurredAt,
      explorerUrl: buildExplorerUrl(transaction.hash),
      rawPayload: {
        blockNumber: Number(block.number),
        transactionHash: transaction.hash,
        fromAddress,
        toAddress,
        amountWei,
        amountEth,
        direction,
        blockTimestamp: Number(block.timestamp),
        transactionIndex: transaction.index ?? null,
        isContractCreation: false
      },
      blockNumber: Number(block.number),
      logIndex: null,
      fromAddress,
      toAddress,
      amountWei,
      direction,
      lifecycle: {
        ...lifecycle,
        decodedPreview: {
          amountWei,
          amountEth,
          layout: 'native_transfer'
        },
        matched: true
      }
    };
  });

  if (shouldTraceLifecycle(lifecycle, traceConfig)) {
    logger.warn({
      ...lifecycle,
      decodedPreview: {
        amountWei,
        amountEth,
        layout: 'native_transfer'
      },
      matched: true,
      outcome: 'ready_for_insert',
      rejectionReason: null,
      insertQueryRan: false
    }, 'Targeted Ethereum trace event');
  }

  return events;
}
