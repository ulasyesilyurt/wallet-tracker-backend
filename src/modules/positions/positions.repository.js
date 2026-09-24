import { query } from '../../db/query.js';

export async function upsertWalletChainPositionsCache({ walletId, walletAddress, chainId, positions, capturedAt }) {
  await query(
    `
      INSERT INTO wallet_chain_positions_cache (
        wallet_id, wallet_address, chain_id, positions, captured_at, updated_at
      )
      VALUES ($1, LOWER($2), $3, $4::jsonb, $5, NOW())
      ON CONFLICT (wallet_id, chain_id)
      DO UPDATE SET
        wallet_address = EXCLUDED.wallet_address,
        positions = EXCLUDED.positions,
        captured_at = EXCLUDED.captured_at,
        updated_at = NOW()
      WHERE wallet_chain_positions_cache.captured_at <= EXCLUDED.captured_at
    `,
    [walletId, walletAddress, chainId, JSON.stringify(positions), capturedAt]
  );
}

export async function findWalletChainPositionsCaches({ walletId, walletAddress, chainIds, maxAgeMs }) {
  if (chainIds.length === 0) {
    return [];
  }

  const cutoff = new Date(Date.now() - maxAgeMs);
  const result = await query(
    `
      SELECT chain_id, positions, captured_at
      FROM wallet_chain_positions_cache
      WHERE wallet_id = $1
        AND wallet_address = LOWER($2)
        AND chain_id = ANY($3::text[])
        AND captured_at >= $4
    `,
    [walletId, walletAddress, chainIds, cutoff]
  );

  return result.rows.map((row) => ({
    chainId: row.chain_id,
    positions: typeof row.positions === 'string' ? JSON.parse(row.positions) : row.positions,
    capturedAt: row.captured_at
  }));
}
