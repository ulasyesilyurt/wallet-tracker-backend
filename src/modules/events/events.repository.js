import { pool } from '../../db/pool.js';
import { query } from '../../db/query.js';
import { enrichWalletEventUsdValue } from './eventValuation.service.js';
import {
  enqueueNotificationOutbox,
  getWalletAlertSettingsByWalletId
} from '../notifications/notifications.repository.js';
import { shouldEnqueueNotificationForWalletEvent } from '../notifications/notificationRules.service.js';

function mapUnifiedAssetDetails(row) {
  const isToken = row.asset_type === 'token';
  const isNft = row.asset_type === 'nft';

  return {
    assetContractAddress: isToken
      ? row.token_contract_address
      : isNft
        ? row.nft_contract_address
        : null,
    assetTokenId: isNft ? row.nft_token_id : null,
    assetImageUrl: null,
    assetDecimals: null
  };
}

function mapWalletEvent(row) {
  return {
    id: row.id,
    walletId: row.wallet_id,
    chainId: row.chain_id,
    transactionHash: row.transaction_hash,
    eventType: row.event_type,
    assetType: row.asset_type,
    assetSymbol: row.asset_symbol,
    assetName: row.asset_name,
    ...mapUnifiedAssetDetails(row),
    amount: row.amount != null ? row.amount.toString() : null,
    tokenContractAddress: row.token_contract_address,
    nftContractAddress: row.nft_contract_address,
    nftTokenId: row.nft_token_id,
    marketplace: row.marketplace,
    occurredAt: row.occurred_at,
    explorerUrl: row.explorer_url,
    rawPayload: row.raw_payload,
    blockNumber: row.block_number != null ? Number(row.block_number) : null,
    logIndex: row.log_index != null ? Number(row.log_index) : null,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    amountWei: row.amount_wei,
    direction: row.direction,
    usdValue: row.usd_value != null ? row.usd_value.toString() : null,
    usdValueStatus: row.usd_value_status,
    usdValueSource: row.usd_value_source,
    usdValueCalculatedAt: row.usd_value_calculated_at,
    createdAt: row.created_at
  };
}

function mapGlobalActivityEvent(row) {
  return {
    id: row.id,
    walletId: row.wallet_id,
    walletLabel: row.wallet_label,
    walletAddress: row.wallet_address,
    chainId: row.chain_id,
    transactionHash: row.transaction_hash,
    eventType: row.event_type,
    direction: row.direction,
    assetType: row.asset_type,
    assetSymbol: row.asset_symbol,
    assetName: row.asset_name,
    ...mapUnifiedAssetDetails(row),
    amount: row.amount != null ? row.amount.toString() : null,
    usdValue: row.usd_value != null ? row.usd_value.toString() : null,
    usdValueStatus: row.usd_value_status,
    usdValueSource: row.usd_value_source,
    usdValueCalculatedAt: row.usd_value_calculated_at,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    createdAt: row.created_at,
    occurredAt: row.occurred_at
  };
}

export async function insertWalletEvents(events, logger = null, options = {}) {
  if (events.length === 0) {
    logger?.info('No wallet events to insert into database');
    return [];
  }

  const insertedEvents = [];

  for (const event of events) {
    const enrichedEvent = await enrichWalletEventUsdValue(event, options, logger);

    logger?.info({
      walletId: enrichedEvent.walletId,
      chainId: enrichedEvent.chainId,
      transactionHash: enrichedEvent.transactionHash,
      blockNumber: enrichedEvent.blockNumber,
      contractAddress: enrichedEvent.rawPayload?.contractAddress ?? null,
      eventType: enrichedEvent.eventType,
      fromAddress: enrichedEvent.fromAddress,
      toAddress: enrichedEvent.toAddress,
      amount: enrichedEvent.amount,
      amountWei: enrichedEvent.amountWei,
      logIndex: enrichedEvent.logIndex,
      usdValue: enrichedEvent.usdValue,
      usdValueStatus: enrichedEvent.usdValueStatus,
      usdValueSource: enrichedEvent.usdValueSource
    }, 'About to insert wallet event into database');

    const client = await pool.connect();
    let result;

    try {
      await client.query('BEGIN');
      result = await client.query(
        `
          INSERT INTO wallet_events (
            wallet_id,
            chain_id,
            transaction_hash,
            event_type,
            asset_type,
            asset_symbol,
            asset_name,
            amount,
            token_contract_address,
            nft_contract_address,
            nft_token_id,
            marketplace,
            occurred_at,
            explorer_url,
            raw_payload,
            block_number,
            log_index,
            from_address,
            to_address,
            amount_wei,
            direction,
            usd_value,
            usd_value_status,
            usd_value_source,
            usd_value_calculated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
          )
          ON CONFLICT DO NOTHING
          RETURNING id, wallet_id, transaction_hash, event_type, asset_type, occurred_at
        `,
        [
          enrichedEvent.walletId,
          enrichedEvent.chainId,
          enrichedEvent.transactionHash,
          enrichedEvent.eventType,
          enrichedEvent.assetType,
          enrichedEvent.assetSymbol,
          enrichedEvent.assetName,
          enrichedEvent.amount,
          enrichedEvent.tokenContractAddress,
          enrichedEvent.nftContractAddress,
          enrichedEvent.nftTokenId,
          enrichedEvent.marketplace,
          enrichedEvent.occurredAt,
          enrichedEvent.explorerUrl,
          JSON.stringify(enrichedEvent.rawPayload),
          enrichedEvent.blockNumber,
          enrichedEvent.logIndex,
          enrichedEvent.fromAddress,
          enrichedEvent.toAddress,
          enrichedEvent.amountWei,
          enrichedEvent.direction,
          enrichedEvent.usdValue,
          enrichedEvent.usdValueStatus,
          enrichedEvent.usdValueSource,
          enrichedEvent.usdValueCalculatedAt
        ]
      );

      if (result.rows[0]) {
        const alertSettings = await getWalletAlertSettingsByWalletId(client, enrichedEvent.walletId);
        const notificationDecision = shouldEnqueueNotificationForWalletEvent({
          event: enrichedEvent,
          alertSettings
        });

        if (notificationDecision.shouldEnqueue) {
          const outboxJob = await enqueueNotificationOutbox(client, result.rows[0].id);

          logger?.info(
            {
              walletEventId: result.rows[0].id,
              walletId: enrichedEvent.walletId,
              transactionHash: enrichedEvent.transactionHash,
              outboxJobId: outboxJob?.id ?? null,
              minimumAlertUsd: notificationDecision.minimumAlertUsd,
              usdValue: enrichedEvent.usdValue
            },
            'Notification outbox job enqueued for inserted wallet event'
          );
        } else {
          logger?.info(
            {
              walletEventId: result.rows[0].id,
              walletId: enrichedEvent.walletId,
              transactionHash: enrichedEvent.transactionHash,
              usdValue: enrichedEvent.usdValue,
              usdValueStatus: enrichedEvent.usdValueStatus,
              minimumAlertUsd: notificationDecision.minimumAlertUsd,
              notificationSkipReason: notificationDecision.reason
            },
            'Notification outbox job skipped for inserted wallet event'
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    logger?.info({
      transactionHash: enrichedEvent.transactionHash,
      blockNumber: enrichedEvent.blockNumber,
      contractAddress: enrichedEvent.rawPayload?.contractAddress ?? null,
      eventType: enrichedEvent.eventType,
      rowCount: result.rowCount
    }, 'Wallet event insert query executed');

    logger?.info({
      transactionHash: enrichedEvent.lifecycle?.transactionHash ?? enrichedEvent.transactionHash,
      blockNumber: enrichedEvent.lifecycle?.blockNumber ?? enrichedEvent.blockNumber,
      contractAddress: enrichedEvent.lifecycle?.contractAddress ?? enrichedEvent.rawPayload?.contractAddress ?? null,
      fromAddress: enrichedEvent.lifecycle?.fromAddress ?? enrichedEvent.fromAddress,
      toAddress: enrichedEvent.lifecycle?.toAddress ?? enrichedEvent.toAddress,
      eventType: enrichedEvent.lifecycle?.eventType ?? enrichedEvent.eventType,
      fromAddressMatched: enrichedEvent.lifecycle?.fromAddressMatched ?? false,
      toAddressMatched: enrichedEvent.lifecycle?.toAddressMatched ?? false,
      matchedWalletIds: enrichedEvent.lifecycle?.matchedWalletIds ?? [enrichedEvent.walletId],
      matched: enrichedEvent.lifecycle?.matched ?? true,
      outcome: result.rows[0] ? 'inserted' : 'rejected',
      rejectionReason: result.rows[0] ? null : 'insert_conflict',
      insertQueryRan: true
    }, 'Wallet event lifecycle');

    if (result.rows[0]) {
      const insertedEvent = {
        id: result.rows[0].id,
        walletId: enrichedEvent.walletId,
        chainId: enrichedEvent.chainId,
        transactionHash: enrichedEvent.transactionHash,
        eventType: enrichedEvent.eventType,
        assetType: enrichedEvent.assetType,
        assetSymbol: enrichedEvent.assetSymbol,
        assetName: enrichedEvent.assetName,
        amount: enrichedEvent.amount,
        tokenContractAddress: enrichedEvent.tokenContractAddress,
        nftContractAddress: enrichedEvent.nftContractAddress,
        nftTokenId: enrichedEvent.nftTokenId,
        marketplace: enrichedEvent.marketplace,
        occurredAt: enrichedEvent.occurredAt,
        explorerUrl: enrichedEvent.explorerUrl,
        rawPayload: enrichedEvent.rawPayload,
        blockNumber: enrichedEvent.blockNumber,
        logIndex: enrichedEvent.logIndex,
        fromAddress: enrichedEvent.fromAddress,
        toAddress: enrichedEvent.toAddress,
        amountWei: enrichedEvent.amountWei,
        direction: enrichedEvent.direction,
        usdValue: enrichedEvent.usdValue,
        usdValueStatus: enrichedEvent.usdValueStatus,
        usdValueSource: enrichedEvent.usdValueSource,
        usdValueCalculatedAt: enrichedEvent.usdValueCalculatedAt
      };

      insertedEvents.push(insertedEvent);
      logger?.info({
        insertedEvent: result.rows[0],
        transactionHash: enrichedEvent.transactionHash,
        blockNumber: enrichedEvent.blockNumber,
        contractAddress: enrichedEvent.rawPayload?.contractAddress ?? null,
        eventType: enrichedEvent.eventType,
        insertOutcome: 'inserted'
      }, 'Wallet event inserted successfully');
    } else {
      logger?.info({
        transactionHash: enrichedEvent.transactionHash,
        blockNumber: enrichedEvent.blockNumber,
        contractAddress: enrichedEvent.rawPayload?.contractAddress ?? null,
        eventType: enrichedEvent.eventType,
        insertOutcome: 'rejected_conflict'
      }, 'Wallet event insert produced no row, likely due to conflict');
    }
  }

  return insertedEvents;
}

export async function listWalletEventsByWalletId(walletId) {
  const result = await query(
    `
      SELECT
        id,
        wallet_id,
        chain_id,
        transaction_hash,
        event_type,
        asset_type,
        asset_symbol,
        asset_name,
        amount,
        token_contract_address,
        nft_contract_address,
        nft_token_id,
        marketplace,
        occurred_at,
        explorer_url,
        raw_payload,
        block_number,
        log_index,
        from_address,
        to_address,
        amount_wei,
        direction,
        usd_value,
        usd_value_status,
        usd_value_source,
        usd_value_calculated_at,
        created_at
      FROM wallet_events
      WHERE wallet_id = $1
      ORDER BY occurred_at DESC, created_at DESC, id DESC
    `,
    [walletId]
  );

  return result.rows.map(mapWalletEvent);
}

export async function listGlobalActivityByUserId(userId, { limit, offset }) {
  const result = await query(
    `
      SELECT
        we.id,
        we.wallet_id,
        tw.label AS wallet_label,
        tw.address AS wallet_address,
        we.chain_id,
        we.transaction_hash,
        we.event_type,
        we.direction,
        we.asset_type,
        we.asset_symbol,
        we.asset_name,
        we.token_contract_address,
        we.nft_contract_address,
        we.nft_token_id,
        we.amount,
        we.usd_value,
        we.usd_value_status,
        we.usd_value_source,
        we.usd_value_calculated_at,
        we.from_address,
        we.to_address,
        we.created_at,
        we.occurred_at
      FROM wallet_events we
      INNER JOIN tracked_wallets tw ON tw.id = we.wallet_id
      WHERE tw.user_id = $1
      ORDER BY we.created_at DESC, we.id DESC
      LIMIT $2
      OFFSET $3
    `,
    [userId, limit, offset]
  );

  const items = result.rows.map(mapGlobalActivityEvent);

  return {
    items,
    pagination: {
      limit,
      offset,
      hasMore: result.rowCount === limit
    }
  };
}
