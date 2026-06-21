import { query } from '../../db/query.js';

function toNumber(value) {
  return typeof value === 'string' ? Number(value) : value;
}

function mapSnapshot(row) {
  return {
    id: row.id,
    walletId: row.wallet_id,
    chainId: row.chain_id,
    totalUsd: toNumber(row.total_usd),
    holdingsUsd: toNumber(row.holdings_usd),
    positionsUsd: toNumber(row.positions_usd),
    capturedAt: row.captured_at,
    createdAt: row.created_at
  };
}

export async function insertWalletPortfolioSnapshot({
  walletId,
  chainId,
  totalUsd,
  holdingsUsd,
  positionsUsd,
  capturedAt
}) {
  const result = await query(
    `
      INSERT INTO wallet_portfolio_snapshots (
        wallet_id,
        chain_id,
        total_usd,
        holdings_usd,
        positions_usd,
        captured_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, wallet_id, chain_id, total_usd, holdings_usd, positions_usd, captured_at, created_at
    `,
    [walletId, chainId, totalUsd, holdingsUsd, positionsUsd, capturedAt]
  );

  return mapSnapshot(result.rows[0]);
}

export async function findLatestSnapshotAtOrBefore(walletId, cutoff) {
  const result = await query(
    `
      SELECT
        id,
        wallet_id,
        chain_id,
        total_usd,
        holdings_usd,
        positions_usd,
        captured_at,
        created_at
      FROM wallet_portfolio_snapshots
      WHERE wallet_id = $1
        AND captured_at <= $2
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `,
    [walletId, cutoff]
  );

  return result.rows[0] ? mapSnapshot(result.rows[0]) : null;
}

export async function findLatestSnapshotsAtOrBefore(walletIds, cutoff) {
  if (walletIds.length === 0) {
    return [];
  }

  const result = await query(
    `
      SELECT DISTINCT ON (wallet_id)
        id,
        wallet_id,
        chain_id,
        total_usd,
        holdings_usd,
        positions_usd,
        captured_at,
        created_at
      FROM wallet_portfolio_snapshots
      WHERE wallet_id = ANY($1::uuid[])
        AND captured_at <= $2
      ORDER BY wallet_id, captured_at DESC, id DESC
    `,
    [walletIds, cutoff]
  );

  return result.rows.map(mapSnapshot);
}
