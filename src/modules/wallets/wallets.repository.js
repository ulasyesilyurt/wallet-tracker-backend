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

function mapWallet(row) {
  return {
    id: row.id,
    userId: row.user_id,
    chainId: row.chain_id,
    address: row.address,
    label: row.label,
    status: row.status,
    trackTypes: normalizeTrackTypes(row.track_types),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createWalletWithPreferences({ userId, chainId, address, label, trackTypes }) {
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

export async function updateWalletById(walletId, userId, { address, label, trackTypes }) {
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

  return result.rows[0] ? mapWallet(result.rows[0]) : null;
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

  return result.rows[0] ? mapWallet(result.rows[0]) : null;
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

  return result.rows.map(mapWallet);
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

  return result.rows.map(mapWallet);
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
      WHERE tw.chain_id = $1
        AND tw.status = 'active'
        AND LOWER(tw.address) = ANY($2::text[])
      GROUP BY tw.id
      ORDER BY tw.created_at ASC
    `,
    [chainId, addresses.map((address) => address.toLowerCase())]
  );

  return result.rows.map(mapWallet);
}

export async function countActiveWalletsByChainIdAndAddress(chainId, address) {
  const result = await query(
    `
      SELECT COUNT(*)::int AS active_wallet_count
      FROM tracked_wallets tw
      WHERE tw.chain_id = $1
        AND tw.status = 'active'
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
      WHERE tw.chain_id = $1
        AND tw.status = 'active'
      ORDER BY LOWER(tw.address) ASC
    `,
    [chainId]
  );

  return result.rows.map((row) => row.address);
}

export async function deleteWalletById(walletId, userId) {
  const result = await query(
    `
      DELETE FROM tracked_wallets
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id, chain_id, address, label, status, created_at, updated_at
    `,
    [walletId, userId]
  );

  return result.rows[0] ? mapWallet({ ...result.rows[0], track_types: [] }) : null;
}
