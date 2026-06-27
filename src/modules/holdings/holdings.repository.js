import { query } from '../../db/query.js';

function parsePayload(payload) {
  if (!payload) {
    return null;
  }

  if (typeof payload === 'string') {
    return JSON.parse(payload);
  }

  return payload;
}

function mapHoldingsCacheRow(row) {
  return {
    id: row.id,
    walletId: row.wallet_id,
    walletAddress: row.wallet_address,
    chainId: row.chain_id,
    payload: parsePayload(row.payload),
    holdingsCount: Number(row.holdings_count ?? 0),
    totalBalanceUsd: row.total_balance_usd == null ? null : Number(row.total_balance_usd),
    tokenBalancesAvailable: row.token_balances_available === true,
    isPartial: row.is_partial === true,
    capturedAt: row.captured_at,
    updatedAt: row.updated_at
  };
}

export async function upsertWalletChainHoldingsCache({
  walletId,
  walletAddress,
  chainId,
  payload,
  holdingsCount,
  totalBalanceUsd,
  tokenBalancesAvailable,
  isPartial,
  capturedAt
}) {
  const normalizedWalletAddress = walletAddress.toLowerCase();
  const payloadJson = JSON.stringify(payload);

  const result = await query(
    `
      INSERT INTO wallet_chain_holdings_cache (
        wallet_id,
        wallet_address,
        chain_id,
        payload,
        holdings_count,
        total_balance_usd,
        token_balances_available,
        is_partial,
        captured_at,
        updated_at
      )
      VALUES ($1, LOWER($2), $3, $4::jsonb, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (wallet_id, chain_id)
      DO UPDATE SET
        wallet_address = EXCLUDED.wallet_address,
        payload = EXCLUDED.payload,
        holdings_count = EXCLUDED.holdings_count,
        total_balance_usd = EXCLUDED.total_balance_usd,
        token_balances_available = EXCLUDED.token_balances_available,
        is_partial = EXCLUDED.is_partial,
        captured_at = EXCLUDED.captured_at,
        updated_at = NOW()
      RETURNING
        id,
        wallet_id,
        wallet_address,
        chain_id,
        payload,
        holdings_count,
        total_balance_usd,
        token_balances_available,
        is_partial,
        captured_at,
        updated_at
    `,
    [
      walletId,
      normalizedWalletAddress,
      chainId,
      payloadJson,
      holdingsCount,
      totalBalanceUsd,
      tokenBalancesAvailable,
      isPartial,
      capturedAt
    ]
  );

  return mapHoldingsCacheRow(result.rows[0]);
}

export async function findWalletChainHoldingsCaches({
  walletId,
  walletAddress,
  chainIds,
  maxAgeMs
}) {
  if (!Array.isArray(chainIds) || chainIds.length === 0) {
    return [];
  }

  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = await query(
    `
      SELECT
        id,
        wallet_id,
        wallet_address,
        chain_id,
        payload,
        holdings_count,
        total_balance_usd,
        token_balances_available,
        is_partial,
        captured_at,
        updated_at
      FROM wallet_chain_holdings_cache
      WHERE wallet_id = $1
        AND wallet_address = LOWER($2)
        AND chain_id = ANY($3::text[])
        AND captured_at >= $4
      ORDER BY captured_at DESC, updated_at DESC
    `,
    [walletId, walletAddress, chainIds, cutoff]
  );

  return result.rows.map(mapHoldingsCacheRow);
}
