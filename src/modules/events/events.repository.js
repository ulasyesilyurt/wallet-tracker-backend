import { query } from '../../db/query.js';
import { notifyWalletEvent } from '../notifications/notifications.service.js';

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
    assetSymbol: row.asset_symbol,
    amount: row.amount != null ? row.amount.toString() : null,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    createdAt: row.created_at,
    occurredAt: row.occurred_at
  };
}

export async function insertWalletEvents(events, logger = null) {
  if (events.length === 0) {
    logger?.info('No wallet events to insert into database');
    return [];
  }

  const insertedEvents = [];

  for (const event of events) {
    logger?.info({
      walletId: event.walletId,
      chainId: event.chainId,
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber,
      contractAddress: event.rawPayload?.contractAddress ?? null,
      eventType: event.eventType,
      fromAddress: event.fromAddress,
      toAddress: event.toAddress,
      amount: event.amount,
      amountWei: event.amountWei,
      logIndex: event.logIndex
    }, 'About to insert wallet event into database');

    const result = await query(
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
          direction
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, $20, $21
        )
        ON CONFLICT DO NOTHING
        RETURNING id, wallet_id, transaction_hash, event_type, asset_type, occurred_at
      `,
      [
        event.walletId,
        event.chainId,
        event.transactionHash,
        event.eventType,
        event.assetType,
        event.assetSymbol,
        event.assetName,
        event.amount,
        event.tokenContractAddress,
        event.nftContractAddress,
        event.nftTokenId,
        event.marketplace,
        event.occurredAt,
        event.explorerUrl,
        JSON.stringify(event.rawPayload),
        event.blockNumber,
        event.logIndex,
        event.fromAddress,
        event.toAddress,
        event.amountWei,
        event.direction
      ]
    );

    logger?.info({
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber,
      contractAddress: event.rawPayload?.contractAddress ?? null,
      eventType: event.eventType,
      rowCount: result.rowCount
    }, 'Wallet event insert query executed');

    logger?.info({
      transactionHash: event.lifecycle?.transactionHash ?? event.transactionHash,
      blockNumber: event.lifecycle?.blockNumber ?? event.blockNumber,
      contractAddress: event.lifecycle?.contractAddress ?? event.rawPayload?.contractAddress ?? null,
      fromAddress: event.lifecycle?.fromAddress ?? event.fromAddress,
      toAddress: event.lifecycle?.toAddress ?? event.toAddress,
      eventType: event.lifecycle?.eventType ?? event.eventType,
      fromAddressMatched: event.lifecycle?.fromAddressMatched ?? false,
      toAddressMatched: event.lifecycle?.toAddressMatched ?? false,
      matchedWalletIds: event.lifecycle?.matchedWalletIds ?? [event.walletId],
      matched: event.lifecycle?.matched ?? true,
      outcome: result.rows[0] ? 'inserted' : 'rejected',
      rejectionReason: result.rows[0] ? null : 'insert_conflict',
      insertQueryRan: true
    }, 'Wallet event lifecycle');

    if (result.rows[0]) {
      const insertedEvent = {
        id: result.rows[0].id,
        walletId: event.walletId,
        chainId: event.chainId,
        transactionHash: event.transactionHash,
        eventType: event.eventType,
        assetType: event.assetType,
        assetSymbol: event.assetSymbol,
        assetName: event.assetName,
        amount: event.amount,
        tokenContractAddress: event.tokenContractAddress,
        nftContractAddress: event.nftContractAddress,
        nftTokenId: event.nftTokenId,
        marketplace: event.marketplace,
        occurredAt: event.occurredAt,
        explorerUrl: event.explorerUrl,
        rawPayload: event.rawPayload,
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        fromAddress: event.fromAddress,
        toAddress: event.toAddress,
        amountWei: event.amountWei,
        direction: event.direction
      };

      insertedEvents.push(insertedEvent);
      logger?.info({
        insertedEvent: result.rows[0],
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        contractAddress: event.rawPayload?.contractAddress ?? null,
        eventType: event.eventType,
        insertOutcome: 'inserted'
      }, 'Wallet event inserted successfully');

      try {
        logger?.info({
          walletEventId: insertedEvent.id,
          walletId: insertedEvent.walletId,
          transactionHash: insertedEvent.transactionHash,
          eventType: insertedEvent.eventType
        }, 'Starting wallet event notification dispatch after insert');

        await notifyWalletEvent(insertedEvent);

        logger?.info({
          walletEventId: insertedEvent.id,
          walletId: insertedEvent.walletId,
          transactionHash: insertedEvent.transactionHash,
          eventType: insertedEvent.eventType
        }, 'Wallet event notification dispatch completed');
      } catch (error) {
        logger?.error({ err: error, walletEventId: insertedEvent.id }, 'Wallet event notification pipeline failed');
      }
    } else {
      logger?.info({
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        contractAddress: event.rawPayload?.contractAddress ?? null,
        eventType: event.eventType,
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
        we.asset_symbol,
        we.amount,
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
