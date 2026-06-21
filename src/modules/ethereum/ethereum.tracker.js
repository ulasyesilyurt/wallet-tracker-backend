import { JsonRpcProvider, getAddress } from 'ethers';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  ERC1155_TRANSFER_BATCH_TOPIC,
  ERC1155_TRANSFER_SINGLE_TOPIC,
  ERC20_ERC721_TRANSFER_TOPIC,
  ETHEREUM_MAINNET_CHAIN_ID
} from './ethereum.constants.js';
import {
  deleteChainSyncState,
  getChainSyncState,
  listActiveEthereumWallets,
  upsertChainSyncState
} from './ethereum.repository.js';
import { insertWalletEvents } from '../events/events.repository.js';
import {
  EthereumContractMetadataCache,
  normalizeNativeTransfer,
  normalizeTransferLog,
  toTopicAddress
} from './ethereum.normalizers.js';

const SYNC_KEY = 'wallet-activity-tracker';
const SUPPORTED_TRANSFER_TOPICS = new Set([
  ERC20_ERC721_TRANSFER_TOPIC,
  ERC1155_TRANSFER_SINGLE_TOPIC,
  ERC1155_TRANSFER_BATCH_TOPIC
]);

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

function describeTransferTopic(topic) {
  if (topic === ERC20_ERC721_TRANSFER_TOPIC) {
    return 'Transfer(address,address,uint256)';
  }

  if (topic === ERC1155_TRANSFER_SINGLE_TOPIC) {
    return 'TransferSingle(address,address,address,uint256,uint256)';
  }

  if (topic === ERC1155_TRANSFER_BATCH_TOPIC) {
    return 'TransferBatch(address,address,address,uint256[],uint256[])';
  }

  return 'unknown';
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRateLimitError(error) {
  const message = `${error?.message ?? ''} ${error?.shortMessage ?? ''}`.toLowerCase();
  const status = error?.status ?? error?.code ?? error?.info?.status;

  return status === 429 || message.includes('429') || message.includes('rate limit');
}

export class EthereumWalletActivityTracker {
  constructor(options = {}) {
    if (!env.ETHEREUM_RPC_URL) {
      throw new Error('ETHEREUM_RPC_URL is required when ENABLE_ETHEREUM_TRACKER=true');
    }

    this.provider = options.provider ?? new JsonRpcProvider(env.ETHEREUM_RPC_URL);
    this.logger = options.logger ?? logger.child({ module: 'ethereum-tracker' });
    this.running = false;
    this.timeout = null;
    this.metadataCache = new EthereumContractMetadataCache(
      this.provider,
      (operation, execute, context) => this.rpcCall(operation, execute, context)
    );
    this.nextRpcAllowedAt = 0;
    this.traceConfig = this.buildTraceConfig();
    this.traceBlockNumber = null;
  }

  buildTraceConfig() {
    const normalizeAddress = (value) => {
      if (!value) {
        return null;
      }

      try {
        return getAddress(value).toLowerCase();
      } catch {
        return value.toLowerCase();
      }
    };

    const txHash = env.ETHEREUM_TRACE_TX_HASH?.trim().toLowerCase() || null;
    const fromAddress = normalizeAddress(env.ETHEREUM_TRACE_FROM_ADDRESS?.trim());
    const toAddress = normalizeAddress(env.ETHEREUM_TRACE_TO_ADDRESS?.trim());

    if (!txHash && !fromAddress && !toAddress) {
      return null;
    }

    return {
      txHash,
      fromAddress,
      toAddress
    };
  }

  shouldTraceTx(transactionHash) {
    if (!this.traceConfig?.txHash || !transactionHash) {
      return false;
    }

    return transactionHash.toLowerCase() === this.traceConfig.txHash;
  }

  shouldUseReceiptFallbackForTransaction(transaction, trackedAddressSet) {
    if (!transaction) {
      return false;
    }

    if (this.shouldTraceTx(transaction.hash)) {
      return true;
    }

    const fromAddress = normalizeAddress(transaction.from);
    const toAddress = normalizeAddress(transaction.to);

    return trackedAddressSet.has(fromAddress) || trackedAddressSet.has(toAddress);
  }

  async start() {
    this.running = true;
    this.logger.info({
      requestDelayMs: env.ETHEREUM_RPC_REQUEST_DELAY_MS,
      maxRetries: env.ETHEREUM_RPC_MAX_RETRIES,
      backoffBaseMs: env.ETHEREUM_RPC_BACKOFF_BASE_MS,
      resetSyncCursor: env.ETHEREUM_RESET_SYNC_CURSOR,
      traceConfig: this.traceConfig
    }, 'Ethereum wallet activity tracker started');

    if (env.ETHEREUM_RESET_SYNC_CURSOR) {
      await deleteChainSyncState(ETHEREUM_MAINNET_CHAIN_ID, SYNC_KEY);
    }

    if (this.traceConfig?.txHash) {
      const receipt = await this.rpcCall(
        'getTransactionReceipt',
        () => this.provider.getTransactionReceipt(this.traceConfig.txHash),
        { transactionHash: this.traceConfig.txHash }
      );

      if (receipt?.blockNumber != null) {
        this.traceBlockNumber = Number(receipt.blockNumber);
        this.logger.warn({
          transactionHash: this.traceConfig.txHash,
          blockNumber: this.traceBlockNumber,
          recommendedEthereumStartBlock: Math.max(0, this.traceBlockNumber - 1)
        }, 'Resolved trace transaction block number');
      }
    }

    try {
      await this.pollOnce();
    } catch (error) {
      this.logger.error({ err: error }, 'Initial Ethereum wallet activity poll failed');
    }

    this.scheduleNextPoll();
  }

  async stop() {
    this.running = false;

    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    this.logger.info('Ethereum wallet activity tracker stopped');
  }

  scheduleNextPoll() {
    if (!this.running) {
      return;
    }

    this.timeout = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.error({ err: error }, 'Ethereum wallet activity poll failed');
      } finally {
        this.scheduleNextPoll();
      }
    }, env.ETHEREUM_POLL_INTERVAL_MS);
  }

  async waitForRpcSlot() {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextRpcAllowedAt - now);

    if (waitMs > 0) {
      this.logger.debug({ waitMs }, 'Waiting for next Ethereum RPC slot');
      await sleep(waitMs);
    }

    this.nextRpcAllowedAt = Date.now() + env.ETHEREUM_RPC_REQUEST_DELAY_MS;
  }

  async rpcCall(operation, execute, context = {}) {
    for (let attempt = 0; attempt <= env.ETHEREUM_RPC_MAX_RETRIES; attempt += 1) {
      try {
        await this.waitForRpcSlot();
        return await execute();
      } catch (error) {
        const retryable = isRateLimitError(error);
        const isLastAttempt = attempt === env.ETHEREUM_RPC_MAX_RETRIES;

        if (!retryable || isLastAttempt) {
          throw error;
        }

        const backoffMs = env.ETHEREUM_RPC_BACKOFF_BASE_MS * 2 ** attempt;
        this.nextRpcAllowedAt = Math.max(this.nextRpcAllowedAt, Date.now() + backoffMs);
        this.logger.warn({
          operation,
          attempt: attempt + 1,
          backoffMs,
          ...context
        }, 'Ethereum RPC rate limit hit, backing off before retry');
        await sleep(backoffMs);
      }
    }

    throw new Error(`RPC call failed unexpectedly for ${operation}`);
  }

  async getStartingBlock() {
    if (env.ETHEREUM_START_BLOCK > 0) {
      this.logger.warn({
        startupBlockSource: 'env',
        ethereumStartBlock: env.ETHEREUM_START_BLOCK
      }, 'Ethereum tracker startup block selected');
      return env.ETHEREUM_START_BLOCK;
    }

    const state = await getChainSyncState(ETHEREUM_MAINNET_CHAIN_ID, SYNC_KEY);

    if (state) {
      this.logger.warn({
        startupBlockSource: 'persisted_state',
        persistedLastSyncedBlock: Number(state.last_synced_block)
      }, 'Ethereum tracker startup block selected');
      return Number(state.last_synced_block);
    }

    const latestBlock = await this.rpcCall('getBlockNumber', () => this.provider.getBlockNumber());
    const fallbackBlock = Math.max(0, latestBlock - env.ETHEREUM_CONFIRMATIONS);

    this.logger.warn({
      startupBlockSource: 'latest_block_fallback',
      latestBlock,
      confirmations: env.ETHEREUM_CONFIRMATIONS,
      startupBlock: fallbackBlock
    }, 'Ethereum tracker startup block selected');

    return fallbackBlock;
  }

  async fetchTransferLogs(fromBlock, toBlock, trackedAddressTopics) {
    const filters = [
      { fromBlock, toBlock, topics: [ERC20_ERC721_TRANSFER_TOPIC] },
      { fromBlock, toBlock, topics: [ERC1155_TRANSFER_SINGLE_TOPIC] },
      { fromBlock, toBlock, topics: [ERC1155_TRANSFER_BATCH_TOPIC] }
    ];

    const logGroups = [];

    for (const [filterIndex, filter] of filters.entries()) {
      this.logger.info({
        fromBlock,
        toBlock,
        filterIndex,
        requestedTopics: filter.topics,
        trackedAddressTopics
      }, 'Fetching Ethereum logs with topics');

      const logs = await this.rpcCall(
        'getLogs',
        () => this.provider.getLogs(filter),
        { fromBlock, toBlock, filterIndex }
      );

      logGroups.push(logs);
    }

    const dedupedLogs = new Map();

    for (const logGroup of logGroups) {
      for (const log of logGroup) {
        dedupedLogs.set(`${log.transactionHash}:${log.index}`, log);
      }
    }

    const logs = [...dedupedLogs.values()].sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) {
        return Number(left.blockNumber) - Number(right.blockNumber);
      }

      return Number(left.index) - Number(right.index);
    });

    const rawLogsPerBlock = new Map();

    for (const log of logs) {
      const blockNumber = Number(log.blockNumber);
      rawLogsPerBlock.set(blockNumber, (rawLogsPerBlock.get(blockNumber) ?? 0) + 1);
    }

    this.logger.info({
      fromBlock,
      toBlock,
      rawLogsCount: logs.length,
      rawLogsPerBlock: Object.fromEntries([...rawLogsPerBlock.entries()].sort((left, right) => left[0] - right[0]))
    }, 'Fetched raw Ethereum transfer logs before wallet filtering');

    return logs;
  }

  async getBlockTransactions(block) {
    if (Array.isArray(block.prefetchedTransactions) && block.prefetchedTransactions.length > 0) {
      return block.prefetchedTransactions;
    }

    if (Array.isArray(block.transactions) && block.transactions.length > 0) {
      if (typeof block.transactions[0] === 'object') {
        return block.transactions;
      }

      const transactions = [];

      for (const transactionHash of block.transactions) {
        const transaction = await this.rpcCall(
          'getTransaction',
          () => this.provider.getTransaction(transactionHash),
          { blockNumber: Number(block.number), transactionHash }
        );

        if (transaction) {
          transactions.push(transaction);
        }
      }

      return transactions;
    }

    return [];
  }

  async fetchNativeTransfersForBlockRange(fromBlock, toBlock, trackedWalletsByAddress, blockCache) {
    const normalizedEvents = [];

    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
      let block = blockCache.get(blockNumber);

      if (!block) {
        block = await this.rpcCall(
          'getBlockWithTransactions',
          () => this.provider.getBlock(blockNumber, true),
          { blockNumber }
        );
        blockCache.set(blockNumber, block);
      }

      const transactions = await this.getBlockTransactions(block);

      for (const transaction of transactions) {
        const events = normalizeNativeTransfer({
          block,
          transaction,
          trackedWalletsByAddress,
          logger: this.logger,
          traceConfig: this.traceConfig
        });

        normalizedEvents.push(...events);
      }
    }

    return normalizedEvents;
  }

  async fetchReceiptBackfillLogsForBlockRange(fromBlock, toBlock, trackedAddressSet, blockCache, knownLogKeys) {
    const recoveredLogs = [];

    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
      let block = blockCache.get(blockNumber);

      if (!block) {
        block = await this.rpcCall(
          'getBlockWithTransactions',
          () => this.provider.getBlock(blockNumber, true),
          { blockNumber }
        );
        blockCache.set(blockNumber, block);
      }

      const transactions = await this.getBlockTransactions(block);
      const candidateTransactions = transactions.filter((transaction) =>
        this.shouldUseReceiptFallbackForTransaction(transaction, trackedAddressSet)
      );

      if (candidateTransactions.length === 0) {
        continue;
      }

      this.logger.info({
        blockNumber,
        candidateTransactionCount: candidateTransactions.length,
        candidateTransactionHashes: candidateTransactions.map((transaction) => transaction.hash)
      }, 'Scanning transaction receipts for transfer-log fallback');

      for (const transaction of candidateTransactions) {
        const receipt = await this.rpcCall(
          'getTransactionReceipt',
          () => this.provider.getTransactionReceipt(transaction.hash),
          { blockNumber, transactionHash: transaction.hash }
        );

        if (!receipt) {
          continue;
        }

        if (this.shouldTraceTx(transaction.hash)) {
          this.logger.warn({
            transactionHash: transaction.hash,
            blockNumber,
            receiptLogs: receipt.logs.map((log) => ({
              address: log.address,
              topics: log.topics,
              data: log.data,
              logIndex: Number(log.index),
              eventSignature: log.topics?.[0] ?? null,
              eventSignatureName: describeTransferTopic(log.topics?.[0] ?? null)
            }))
          }, 'Fetched full transaction receipt logs for traced transaction');
        }

        for (const receiptLog of receipt.logs) {
          const topic0 = receiptLog.topics?.[0];

          if (!SUPPORTED_TRANSFER_TOPICS.has(topic0)) {
            continue;
          }

          const logKey = `${receiptLog.transactionHash}:${Number(receiptLog.index)}`;

          if (knownLogKeys.has(logKey)) {
            if (this.shouldTraceTx(transaction.hash)) {
              this.logger.warn({
                transactionHash: transaction.hash,
                blockNumber,
                logIndex: Number(receiptLog.index),
                contractAddress: receiptLog.address,
                eventSignature: topic0,
                eventSignatureName: describeTransferTopic(topic0)
              }, 'Receipt fallback confirmed transfer log already existed in getLogs result');
            }
            continue;
          }

          knownLogKeys.add(logKey);
          recoveredLogs.push(receiptLog);

          this.logger.warn({
            transactionHash: transaction.hash,
            blockNumber,
            logIndex: Number(receiptLog.index),
            contractAddress: receiptLog.address,
            eventSignature: topic0,
            eventSignatureName: describeTransferTopic(topic0),
            topics: receiptLog.topics,
            data: receiptLog.data
          }, 'Recovered missing transfer log from transaction receipt fallback');
        }
      }
    }

    return recoveredLogs;
  }

  async pollOnce() {
    const trackedWallets = await listActiveEthereumWallets();

    if (trackedWallets.length === 0) {
      this.logger.debug('No active Ethereum wallets to track');
      return;
    }

    const latestBlock = await this.rpcCall('getBlockNumber', () => this.provider.getBlockNumber());
    const safeBlock = latestBlock - env.ETHEREUM_CONFIRMATIONS;
    const startBlock = await this.getStartingBlock();

    if (safeBlock <= startBlock) {
      this.logger.debug({ latestBlock, safeBlock, startBlock }, 'No confirmed Ethereum blocks to process yet');
      return;
    }

    const addresses = [...new Set(trackedWallets.map((wallet) => wallet.address.toLowerCase()))];
    const trackedAddressSet = new Set(addresses);
    const trackedAddressTopics = addresses.map(toTopicAddress);
    const trackedWalletsByAddress = new Map();

    this.logger.info({
      trackedWalletAddresses: addresses,
      trackedAddressTopics
    }, 'Tracker wallet address set for current poll');

    for (const wallet of trackedWallets) {
      const key = wallet.address.toLowerCase();
      const group = trackedWalletsByAddress.get(key) ?? [];
      group.push(wallet);
      trackedWalletsByAddress.set(key, group);
    }

    const blockCache = new Map();
    const scanRange = {
      startBlockExclusive: startBlock,
      firstScannedBlock: startBlock + 1,
      lastScannedBlock: safeBlock
    };

    this.logger.warn(scanRange, 'Ethereum tracker scan range for current poll');

    if (this.traceBlockNumber != null) {
      const inRange = this.traceBlockNumber >= startBlock + 1 && this.traceBlockNumber <= safeBlock;

      this.logger.warn({
        traceTransactionHash: this.traceConfig?.txHash ?? null,
        traceBlockNumber: this.traceBlockNumber,
        inCurrentScanRange: inRange,
        currentScanRange: scanRange,
        recommendedEthereumStartBlock: Math.max(0, this.traceBlockNumber - 1)
      }, 'Trace transaction scan range check');
    }

    for (let fromBlock = startBlock + 1; fromBlock <= safeBlock; fromBlock += env.ETHEREUM_BATCH_SIZE) {
      const toBlock = Math.min(fromBlock + env.ETHEREUM_BATCH_SIZE - 1, safeBlock);

      try {
        const logs = await this.fetchTransferLogs(fromBlock, toBlock, trackedAddressTopics);
        const knownLogKeys = new Set(logs.map((log) => `${log.transactionHash}:${Number(log.index)}`));
        const receiptBackfillLogs = await this.fetchReceiptBackfillLogsForBlockRange(
          fromBlock,
          toBlock,
          trackedAddressSet,
          blockCache,
          knownLogKeys
        );
        const allTransferLogs = [...logs, ...receiptBackfillLogs].sort((left, right) => {
          if (Number(left.blockNumber) !== Number(right.blockNumber)) {
            return Number(left.blockNumber) - Number(right.blockNumber);
          }

          return Number(left.index) - Number(right.index);
        });
        const normalizedEvents = [];
        const nativeTransferEvents = await this.fetchNativeTransfersForBlockRange(
          fromBlock,
          toBlock,
          trackedWalletsByAddress,
          blockCache
        );

        for (const log of allTransferLogs) {
          try {
            const events = await normalizeTransferLog({
              provider: {
                getBlock: async (blockNumber) =>
                  this.rpcCall('getBlock', () => this.provider.getBlock(blockNumber), { blockNumber })
              },
            log,
            trackedWalletsByAddress,
            metadataCache: this.metadataCache,
            blockCache,
            logger: this.logger,
              traceConfig: this.traceConfig
          });

          if (this.shouldTraceTx(log.transactionHash)) {
            this.logger.warn({
              transactionHash: log.transactionHash,
              blockNumber: Number(log.blockNumber),
              returnedEventsCount: events.length,
              returnedEvents: events.map((event) => ({
                walletId: event.walletId,
                eventType: event.eventType,
                fromAddress: event.fromAddress,
                toAddress: event.toAddress,
                logIndex: event.logIndex
              }))
            }, 'Trace transaction returned events from normalizeTransferLog');
          }

          normalizedEvents.push(...events);

          if (this.shouldTraceTx(log.transactionHash)) {
            this.logger.warn({
              transactionHash: log.transactionHash,
              blockNumber: Number(log.blockNumber),
              normalizedEventsCountAfterPush: normalizedEvents.length,
              presentInNormalizedEvents: normalizedEvents.some(
                (event) => event.transactionHash.toLowerCase() === log.transactionHash.toLowerCase()
              )
            }, 'Trace transaction push into normalizedEvents completed');
          }
          } catch (error) {
            this.logger.error({
              err: error,
              eventSignature: log.topics?.[0] ?? null,
              topics: log.topics,
              topicsCount: log.topics?.length ?? 0,
              dataLength: typeof log.data === 'string' ? log.data.length : 0,
              contractAddress: log.address,
              transactionHash: log.transactionHash,
              blockNumber: Number(log.blockNumber),
              logAddress: log.address,
              logData: log.data,
              txHash: log.transactionHash
            }, 'Failed to decode Ethereum transfer log; continuing with remaining logs');
          }
        }

        normalizedEvents.push(...nativeTransferEvents);

        if (this.traceConfig?.txHash) {
          const tracedEvents = normalizedEvents.filter(
            (event) => event.transactionHash.toLowerCase() === this.traceConfig.txHash
          );

          this.logger.warn({
            traceTransactionHash: this.traceConfig.txHash,
            tracedEventsCountBeforeInsert: tracedEvents.length,
            tracedEventsBeforeInsert: tracedEvents.map((event) => ({
              walletId: event.walletId,
              eventType: event.eventType,
              fromAddress: event.fromAddress,
              toAddress: event.toAddress,
              logIndex: event.logIndex,
              blockNumber: event.blockNumber
            }))
          }, 'Trace transaction final normalizedEvents payload before repository insert');

          if (tracedEvents.length === 0) {
            this.logger.warn({
              traceTransactionHash: this.traceConfig.txHash,
              logsScannedInBatch: logs.length,
              nativeTransferEventsCount: nativeTransferEvents.length,
              rejectionReason: 'event_not_present_in_final_insert_array'
            }, 'Trace transaction missing before repository insert');
          }
        }

        const insertedEvents = await insertWalletEvents(normalizedEvents, this.logger);
        await upsertChainSyncState(ETHEREUM_MAINNET_CHAIN_ID, SYNC_KEY, toBlock);

        this.logger.info({
          fromBlock,
          toBlock,
          logsScanned: allTransferLogs.length,
          getLogsCount: logs.length,
          receiptBackfillLogsRecovered: receiptBackfillLogs.length,
          trackedAddressesCount: addresses.length,
          trackedAddressTopics,
          nativeTransfersDetected: nativeTransferEvents.length,
          eventsDetected: normalizedEvents.length,
          eventsInserted: insertedEvents.length
        }, 'Processed Ethereum wallet activity block range');
      } catch (error) {
        this.logger.error({
          err: error,
          fromBlock,
          toBlock
        }, 'Ethereum tracker batch failed; keeping sync cursor unchanged for retry on next poll');
        break;
      }
    }
  }
}
