import { query } from '../../db/query.js';
import { logger } from '../../config/logger.js';
import { ETHEREUM_MAINNET_CHAIN_ID } from './ethereum.constants.js';

function mapTrackedWallet(row) {
  return {
    id: row.id,
    userId: row.user_id,
    chainId: row.chain_id,
    address: row.address,
    label: row.label,
    trackTypes: row.track_types ?? []
  };
}

export async function listActiveEthereumWallets() {
  const result = await query(
    `
      SELECT
        tw.id,
        tw.user_id,
        tw.chain_id,
        tw.address,
        tw.label,
        COALESCE(
          ARRAY_AGG(wtp.track_type::text ORDER BY wtp.track_type::text)
          FILTER (WHERE wtp.track_type IS NOT NULL),
          ARRAY[]::text[]
        ) AS track_types
      FROM tracked_wallets tw
      INNER JOIN wallet_track_preferences wtp ON wtp.wallet_id = tw.id
      WHERE tw.chain_id = $1
        AND tw.status = 'active'
        AND wtp.track_type IN ('native_transfer', 'token_transfer', 'nft_transfer')
      GROUP BY tw.id
      ORDER BY tw.created_at ASC
    `,
    [ETHEREUM_MAINNET_CHAIN_ID]
  );

  const wallets = result.rows.map(mapTrackedWallet);

  logger.info({
    trackedWallets: wallets.map((wallet) => ({
      id: wallet.id,
      address: wallet.address.toLowerCase(),
      trackTypes: wallet.trackTypes
    }))
  }, 'Loaded active Ethereum tracked wallets');

  return wallets;
}

export async function getChainSyncState(chainId, syncKey) {
  const result = await query(
    `
      SELECT chain_id, sync_key, last_synced_block
      FROM chain_sync_state
      WHERE chain_id = $1 AND sync_key = $2
    `,
    [chainId, syncKey]
  );

  return result.rows[0] ?? null;
}

export async function upsertChainSyncState(chainId, syncKey, lastSyncedBlock) {
  await query(
    `
      INSERT INTO chain_sync_state (chain_id, sync_key, last_synced_block, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (chain_id, sync_key)
      DO UPDATE SET
        last_synced_block = EXCLUDED.last_synced_block,
        updated_at = NOW()
    `,
    [chainId, syncKey, lastSyncedBlock]
  );
}

export async function deleteChainSyncState(chainId, syncKey) {
  const result = await query(
    `
      DELETE FROM chain_sync_state
      WHERE chain_id = $1 AND sync_key = $2
      RETURNING chain_id, sync_key
    `,
    [chainId, syncKey]
  );

  logger.warn({
    chainId,
    syncKey,
    deleted: result.rowCount > 0
  }, 'Ethereum chain sync cursor reset requested');

  return result.rowCount > 0;
}
