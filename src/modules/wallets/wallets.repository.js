import { pool } from '../../db/pool.js';
import { query } from '../../db/query.js';

function normalizeTrackTypes(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    return value
      .slice(1, -1)
      .split(',')
      .filter(Boolean);
  }

  return [];
}

function normalizeEnabledChains(value, fallbackChainId = null) {
  if (Array.isArray(value)) {
    const normalized = value.filter(Boolean);

    if (normalized.length > 0) {
      return normalized;
    }
  }

  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    const normalized = value
      .slice(1, -1)
      .split(',')
      .filter(Boolean);

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return fallbackChainId ? [fallbackChainId] : [];
}

function mapWallet(row, enabledChainsOverride = null) {
  const chainId = row.chain_id;

  return {
    id: row.id,
    userId: row.user_id,
    chainId,
    address: row.address,
    label: row.label,
    status: row.status,
    trackTypes: normalizeTrackTypes(row.track_types),
    enabledChains: enabledChainsOverride ?? normalizeEnabledChains(row.enabled_chains, chainId),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapWalletAlertSettings(row) {
  if (!row) {
    return null;
  }

  return {
    walletId: row.wallet_id,
    minimumAlertUsd: row.minimum_alert_usd != null ? Number(row.minimum_alert_usd) : null,
    notificationsEnabled: row.notifications_enabled,
    notifyNftTransfers: row.notify_nft_transfers,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listWalletChains(walletId) {
  const result = await query(
    `
      SELECT wc.chain_id
      FROM wallet_chains wc
      WHERE wc.wallet_id = $1
        AND wc.enabled = TRUE
      ORDER BY wc.created_at ASC, wc.chain_id ASC
    `,
    [walletId]
  );

  return result.rows.map((row) => row.chain_id).filter(Boolean);
}

export async function findWalletAlertSettingsByWalletId(walletId) {
  const result = await query(
    `
      SELECT
        wallet_id,
        minimum_alert_usd,
        notifications_enabled,
        notify_nft_transfers,
        created_at,
        updated_at
      FROM wallet_alert_settings
      WHERE wallet_id = $1
      LIMIT 1
    `,
    [walletId]
  );

  return mapWalletAlertSettings(result.rows[0]);
}

export async function upsertWalletAlertSettings(walletId, {
  minimumAlertUsd,
  notificationsEnabled,
  notifyNftTransfers
}) {
  const result = await query(
    `
      INSERT INTO wallet_alert_settings (
        wallet_id,
        minimum_alert_usd,
        notifications_enabled,
        notify_nft_transfers,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (wallet_id)
      DO UPDATE SET
        minimum_alert_usd = EXCLUDED.minimum_alert_usd,
        notifications_enabled = EXCLUDED.notifications_enabled,
        notify_nft_transfers = EXCLUDED.notify_nft_transfers,
        updated_at = NOW()
      RETURNING
        wallet_id,
        minimum_alert_usd,
        notifications_enabled,
        notify_nft_transfers,
        created_at,
        updated_at
    `,
    [walletId, minimumAlertUsd, notificationsEnabled, notifyNftTransfers]
  );

  return mapWalletAlertSettings(result.rows[0]);
}

export async function listWalletChainsForWalletIds(walletIds) {
  if (walletIds.length === 0) {
    return new Map();
  }

  const result = await query(
    `
      SELECT wc.wallet_id, wc.chain_id
      FROM wallet_chains wc
      WHERE wc.wallet_id = ANY($1::uuid[])
        AND wc.enabled = TRUE
      ORDER BY wc.created_at ASC, wc.chain_id ASC
    `,
    [walletIds]
  );

  const chainsByWalletId = new Map();

  for (const row of result.rows) {
    const existingChains = chainsByWalletId.get(row.wallet_id) ?? [];
    existingChains.push(row.chain_id);
    chainsByWalletId.set(row.wallet_id, existingChains);
  }

  return chainsByWalletId;
}

async function enrichWalletsWithEnabledChains(wallets) {
  if (wallets.length === 0) {
    return wallets;
  }

  const chainsByWalletId = await listWalletChainsForWalletIds(wallets.map((wallet) => wallet.id));

  return wallets.map((wallet) => ({
    ...wallet,
    enabledChains: chainsByWalletId.get(wallet.id) ?? (wallet.chainId ? [wallet.chainId] : [])
  }));
}

export async function createWalletWithPreferences({
  userId,
  chainId,
  address,
  label,
  trackTypes,
  enabledChains = []
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const insertWalletResult = await client.query(
      `
        INSERT INTO tracked_wallets (user_id, chain_id, address, label)
        VALUES ($1, $2, LOWER($3), $4)
        RETURNING id, user_id, chain_id, address, label, status, created_at, updated_at
      `,
      [userId, chainId, address, label ?? null]
    );

    const wallet = insertWalletResult.rows[0];
    const normalizedEnabledChains = [...new Set(
      enabledChains.length > 0 ? enabledChains : (chainId ? [chainId] : [])
    )];

    await upsertWalletChains(client, wallet.id, normalizedEnabledChains);

    for (const trackType of trackTypes) {
      await client.query(
        `
          INSERT INTO wallet_track_preferences (wallet_id, track_type)
          VALUES ($1, $2)
        `,
        [wallet.id, trackType]
      );
    }

    await client.query('COMMIT');

    return findWalletById(wallet.id, userId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function findWalletByUserIdAndAddress(userId, address) {
  const result = await query(
    `
      SELECT
        tw.id,
        tw.user_id,
        tw.chain_id,
        tw.address,
        tw.label,
        tw.status,
        tw.created_at,
        tw.updated_at,
        COALESCE(
          ARRAY_AGG(wtp.track_type::text ORDER BY wtp.track_type::text)
          FILTER (WHERE wtp.track_type IS NOT NULL),
          ARRAY[]::text[]
        ) AS track_types
      FROM tracked_wallets tw
      LEFT JOIN wallet_track_preferences wtp ON wtp.wallet_id = tw.id
      WHERE tw.user_id = $1
        AND LOWER(tw.address) = LOWER($2)
      GROUP BY tw.id
      ORDER BY
        CASE WHEN tw.status = 'active' THEN 0 ELSE 1 END,
        tw.created_at ASC
      LIMIT 1
    `,
    [userId, address]
  );

  if (!result.rows[0]) {
    return null;
  }

  const wallet = mapWallet(result.rows[0]);
  const enabledChains = await listWalletChains(wallet.id);

  return {
    ...wallet,
    enabledChains: enabledChains.length > 0 ? enabledChains : (wallet.chainId ? [wallet.chainId] : [])
  };
}

async function upsertWalletChains(client, walletId, enabledChains) {
  const normalizedEnabledChains = [...new Set(enabledChains)];

  for (const chainId of normalizedEnabledChains) {
    await client.query(
      `
        INSERT INTO wallet_chains (wallet_id, chain_id, enabled, updated_at)
        VALUES ($1, $2, TRUE, NOW())
        ON CONFLICT (wallet_id, chain_id)
        DO UPDATE SET
          enabled = TRUE,
          updated_at = NOW()
      `,
      [walletId, chainId]
    );
  }
}

export async function updateWalletById(walletId, userId, { address, label, trackTypes, enabledChains }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingWalletResult = await client.query(
      `
        SELECT id
        FROM tracked_wallets
        WHERE id = $1 AND user_id = $2
        FOR UPDATE
      `,
      [walletId, userId]
    );

    if (existingWalletResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    if (address !== undefined) {
      await client.query(
        `
          UPDATE tracked_wallets
          SET address = LOWER($3),
              updated_at = NOW()
          WHERE id = $1 AND user_id = $2
        `,
        [walletId, userId, address]
      );
    }

    if (label !== undefined) {
      await client.query(
        `
          UPDATE tracked_wallets
          SET label = $3,
              updated_at = NOW()
          WHERE id = $1 AND user_id = $2
        `,
        [walletId, userId, label]
      );
    }

    if (trackTypes !== undefined) {
      await client.query(
        `
          DELETE FROM wallet_track_preferences
          WHERE wallet_id = $1
            AND track_type IN ('native_transfer', 'token_transfer', 'nft_transfer')
        `,
        [walletId]
      );

      for (const trackType of trackTypes) {
        await client.query(
          `
            INSERT INTO wallet_track_preferences (wallet_id, track_type)
            VALUES ($1, $2)
          `,
          [walletId, trackType]
        );
      }

      await client.query(
        `
          UPDATE tracked_wallets
          SET updated_at = NOW()
          WHERE id = $1 AND user_id = $2
        `,
        [walletId, userId]
      );
    }

    if (enabledChains !== undefined) {
      await client.query(
        `
          UPDATE wallet_chains
          SET enabled = FALSE,
              updated_at = NOW()
          WHERE wallet_id = $1
            AND chain_id <> ALL($2::text[])
        `,
        [walletId, enabledChains]
      );

      await upsertWalletChains(client, walletId, enabledChains);
    }

    await client.query('COMMIT');

    return findWalletById(walletId, userId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function findWalletById(walletId, userId) {
  const result = await query(
    `
      SELECT
        tw.id,
        tw.user_id,
        tw.chain_id,
        tw.address,
        tw.label,
        tw.status,
        tw.created_at,
        tw.updated_at,
        COALESCE(
          ARRAY_AGG(wtp.track_type::text ORDER BY wtp.track_type::text)
          FILTER (WHERE wtp.track_type IS NOT NULL),
          ARRAY[]::text[]
        ) AS track_types
      FROM tracked_wallets tw
      LEFT JOIN wallet_track_preferences wtp ON wtp.wallet_id = tw.id
      WHERE tw.id = $1 AND tw.user_id = $2
      GROUP BY tw.id
    `,
    [walletId, userId]
  );

  if (!result.rows[0]) {
    return null;
  }

  const wallet = mapWallet(result.rows[0]);
  const enabledChains = await listWalletChains(wallet.id);

  return {
    ...wallet,
    enabledChains: enabledChains.length > 0 ? enabledChains : (wallet.chainId ? [wallet.chainId] : [])
  };
}

export async function findWalletByIdOnly(walletId) {
  const result = await query(
    `
      SELECT
        tw.id,
        tw.user_id,
        tw.chain_id,
        tw.address,
        tw.label,
        tw.status,
        tw.created_at,
        tw.updated_at,
        COALESCE(
          ARRAY_AGG(wtp.track_type::text ORDER BY wtp.track_type::text)
          FILTER (WHERE wtp.track_type IS NOT NULL),
          ARRAY[]::text[]
        ) AS track_types
      FROM tracked_wallets tw
      LEFT JOIN wallet_track_preferences wtp ON wtp.wallet_id = tw.id
      WHERE tw.id = $1
      GROUP BY tw.id
    `,
    [walletId]
  );

  if (!result.rows[0]) {
    return null;
  }

  const wallet = mapWallet(result.rows[0]);
  const enabledChains = await listWalletChains(wallet.id);

  return {
    ...wallet,
    enabledChains: enabledChains.length > 0 ? enabledChains : (wallet.chainId ? [wallet.chainId] : [])
  };
}

export async function listWalletsByUserId(userId) {
  const result = await query(
    `
      SELECT
        tw.id,
        tw.user_id,
        tw.chain_id,
        tw.address,
        tw.label,
        tw.status,
        tw.created_at,
        tw.updated_at,
        COALESCE(
          ARRAY_AGG(wtp.track_type::text ORDER BY wtp.track_type::text)
          FILTER (WHERE wtp.track_type IS NOT NULL),
          ARRAY[]::text[]
        ) AS track_types
      FROM tracked_wallets tw
      LEFT JOIN wallet_track_preferences wtp ON wtp.wallet_id = tw.id
      WHERE tw.user_id = $1
      GROUP BY tw.id
      ORDER BY tw.created_at DESC
    `,
    [userId]
  );

  return enrichWalletsWithEnabledChains(result.rows.map((row) => mapWallet(row)));
}

export async function listWalletsForSnapshotJob() {
  const result = await query(
    `
      SELECT
        tw.id,
        tw.user_id,
        tw.chain_id,
        tw.address,
        tw.label,
        tw.status,
        tw.created_at,
        tw.updated_at,
        COALESCE(
          ARRAY_AGG(wtp.track_type::text ORDER BY wtp.track_type::text)
          FILTER (WHERE wtp.track_type IS NOT NULL),
          ARRAY[]::text[]
        ) AS track_types
      FROM tracked_wallets tw
      LEFT JOIN wallet_track_preferences wtp ON wtp.wallet_id = tw.id
      WHERE tw.status = 'active'
      GROUP BY tw.id
      ORDER BY tw.created_at ASC
    `
  );

  return enrichWalletsWithEnabledChains(result.rows.map((row) => mapWallet(row)));
}

export async function findTrackedWalletsByAddresses(chainId, addresses) {
  if (addresses.length === 0) {
    return [];
  }

  const result = await query(
    `
      SELECT
        tw.id,
        tw.user_id,
        tw.chain_id,
        tw.address,
        tw.label,
        tw.status,
        tw.created_at,
        tw.updated_at,
        COALESCE(
          ARRAY_AGG(wtp.track_type::text ORDER BY wtp.track_type::text)
          FILTER (WHERE wtp.track_type IS NOT NULL),
          ARRAY[]::text[]
        ) AS track_types
      FROM tracked_wallets tw
      LEFT JOIN wallet_track_preferences wtp ON wtp.wallet_id = tw.id
      INNER JOIN wallet_chains wc
        ON wc.wallet_id = tw.id
       AND wc.chain_id = $1
       AND wc.enabled = TRUE
      WHERE tw.status = 'active'
        AND LOWER(tw.address) = ANY($2::text[])
      GROUP BY tw.id
      ORDER BY tw.created_at ASC
    `,
    [chainId, addresses.map((address) => address.toLowerCase())]
  );

  return enrichWalletsWithEnabledChains(result.rows.map((row) => mapWallet(row)));
}

export async function countActiveWalletsByChainIdAndAddress(chainId, address) {
  const result = await query(
    `
      SELECT COUNT(*)::int AS active_wallet_count
      FROM tracked_wallets tw
      INNER JOIN wallet_chains wc
        ON wc.wallet_id = tw.id
       AND wc.chain_id = $1
       AND wc.enabled = TRUE
      WHERE tw.status = 'active'
        AND LOWER(tw.address) = LOWER($2)
    `,
    [chainId, address]
  );

  return result.rows[0]?.active_wallet_count ?? 0;
}

export async function listActiveTrackedAddressesByChainId(chainId) {
  const result = await query(
    `
      SELECT DISTINCT LOWER(tw.address) AS address
      FROM tracked_wallets tw
      INNER JOIN wallet_chains wc
        ON wc.wallet_id = tw.id
       AND wc.chain_id = $1
       AND wc.enabled = TRUE
      WHERE tw.status = 'active'
      ORDER BY LOWER(tw.address) ASC
    `,
    [chainId]
  );

  return result.rows.map((row) => row.address);
}

export async function deleteWalletById(walletId, userId) {
  const enabledChains = await listWalletChains(walletId);
  const result = await query(
    `
      DELETE FROM tracked_wallets
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id, chain_id, address, label, status, created_at, updated_at
    `,
    [walletId, userId]
  );

  return result.rows[0]
    ? mapWallet(
        { ...result.rows[0], track_types: [] },
        enabledChains.length > 0 ? enabledChains : (result.rows[0].chain_id ? [result.rows[0].chain_id] : [])
      )
    : null;
}
