import { pool } from '../../db/pool.js';
import { HttpError } from '../../utils/httpError.js';
import { SUPPORTED_CHAIN_IDS } from '../chains/chains.config.js';
import {
  lockAlchemyAddressPairsForMutation,
  markAlchemyAddressPairsDirty
} from '../webhooks/alchemyAddressReconciliation.repository.js';
import { consumeAccountDeletionAuthorization } from './accountDeletionReauth.repository.js';

function invalidToken() {
  return new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
}

export async function deleteAccountWithAuthorization({ userId, sessionId, authorization }) {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');

    // Match auth and wallet mutation ordering: user, session, then sorted pairs.
    const user = await client.query('SELECT id FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user.rows[0]) throw invalidToken();
    const session = await client.query(`
      SELECT id FROM auth_sessions
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE
    `, [sessionId, userId]);
    if (!session.rows[0]) throw invalidToken();

    await consumeAccountDeletionAuthorization(client, { authorization, userId, sessionId });

    const result = await client.query(`
      SELECT DISTINCT wc.chain_id, LOWER(tw.address) AS normalized_address
      FROM tracked_wallets tw
      JOIN wallet_chains wc ON wc.wallet_id = tw.id AND wc.enabled = TRUE
      WHERE tw.user_id = $1 AND tw.status = 'active'
        AND wc.chain_id = ANY($2::text[])
      ORDER BY wc.chain_id, normalized_address
    `, [userId, SUPPORTED_CHAIN_IDS]);
    const pairs = result.rows.map((row) => ({
      chainId: row.chain_id,
      address: row.normalized_address
    }));

    await lockAlchemyAddressPairsForMutation(client, pairs);
    await markAlchemyAddressPairsDirty(client, pairs);

    const deleted = await client.query('DELETE FROM app_users WHERE id = $1', [userId]);
    if (deleted.rowCount !== 1) throw invalidToken();
    await client.query('COMMIT');
    committed = true;
    return { affectedAlchemyPairCount: pairs.length };
  } catch (error) {
    if (!committed) await client.query('ROLLBACK');
    throw error;
  } finally {
    try {
      client.release();
    } catch (error) {
      if (!committed) throw error;
      // A connection-release error cannot undo a committed account deletion.
    }
  }
}
