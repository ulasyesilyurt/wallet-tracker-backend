import { pool } from '../../db/pool.js';
import { query } from '../../db/query.js';
import { isSupportedChainId } from '../chains/chains.config.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const lockKey = ({ chainId, address }) => `alchemy-address:${chainId}:${address}`;

function normalizePairs(pairs) {
  const uniquePairs = new Map();

  for (const pair of pairs) {
    const chainId = pair.chainId;
    const address = typeof pair.address === 'string' ? pair.address.trim().toLowerCase() : '';

    if (!isSupportedChainId(chainId) || !ADDRESS_PATTERN.test(address)) {
      throw new TypeError('Invalid Alchemy chain/address pair');
    }

    uniquePairs.set(`${chainId}:${address}`, { chainId, address });
  }

  return [...uniquePairs.values()].sort((a, b) =>
    a.chainId.localeCompare(b.chainId) || a.address.localeCompare(b.address)
  );
}

// Writers lock the user row first, then these sorted transaction-scoped pair keys.
export async function lockAlchemyAddressPairsForMutation(client, pairs) {
  for (const pair of normalizePairs(pairs)) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey(pair)]);
  }
}

// The worker holds a session lock across the provider call, without a SQL transaction.
export async function withAlchemyAddressPairLock(pair, operation) {
  const [normalized] = normalizePairs([pair]);
  const client = await pool.connect();
  let locked = false;
  let discard = false;

  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey(normalized)]);
    locked = true;
    return await operation(client);
  } catch (error) {
    if (!locked) discard = true;
    throw error;
  } finally {
    let unlockError = null;
    if (locked) {
      try {
        const result = await client.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [lockKey(normalized)]
        );
        if (result.rows?.[0]?.pg_advisory_unlock !== true) {
          discard = true;
          unlockError = new Error('PostgreSQL advisory lock release was not confirmed');
          unlockError.code = 'ALCHEMY_ADVISORY_UNLOCK_UNCONFIRMED';
        }
      } catch (error) {
        discard = true;
        unlockError = error;
      }
    }
    client.release(discard);
    if (unlockError) throw unlockError;
  }
}

export async function markAlchemyAddressPairsDirty(client, pairs) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A transaction client is required to mark Alchemy addresses dirty');
  }

  for (const { chainId, address } of normalizePairs(pairs)) {
    await client.query(
      `
        INSERT INTO alchemy_address_reconciliation (
          chain_id, normalized_address
        ) VALUES ($1, $2)
        ON CONFLICT (chain_id, normalized_address)
        DO UPDATE SET
          generation = alchemy_address_reconciliation.generation + 1,
          attempt_count = 0,
          next_attempt_at = NOW(),
          claim_token = NULL,
          lease_expires_at = NULL,
          last_error_code = NULL,
          updated_at = NOW()
      `,
      [chainId, address]
    );
  }
}

export async function isAlchemyAddressDesired(chainId, address, dbQuery = query) {
  const result = await dbQuery(
    `SELECT EXISTS (
      SELECT 1 FROM tracked_wallets tw
      INNER JOIN wallet_chains wc ON wc.wallet_id = tw.id
      WHERE tw.status = 'active'
        AND wc.enabled = TRUE
        AND wc.chain_id = $1
        AND LOWER(tw.address) = $2
    ) AS desired`,
    [chainId, address.toLowerCase()]
  );
  return result.rows[0].desired;
}

export async function claimAlchemyAddressReconciliationRows({ limit, leaseMs, chainId = null, address = null }) {
  const result = await query(
    `WITH candidates AS (
       SELECT chain_id, normalized_address, lease_expires_at IS NOT NULL AS stale
       FROM alchemy_address_reconciliation
       WHERE next_attempt_at <= NOW()
         AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
         AND ($3::text IS NULL OR chain_id = $3)
         AND ($4::text IS NULL OR normalized_address = $4)
       ORDER BY next_attempt_at, created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE alchemy_address_reconciliation ar
     SET claim_token = gen_random_uuid(),
         lease_expires_at = NOW() + ($2::int * INTERVAL '1 millisecond'),
         updated_at = NOW()
     FROM candidates c
     WHERE ar.chain_id = c.chain_id AND ar.normalized_address = c.normalized_address
     RETURNING ar.chain_id, ar.normalized_address, ar.generation, ar.attempt_count,
               ar.claim_token, c.stale`,
    [limit, leaseMs, chainId, address]
  );
  return result.rows.map((row) => ({
    chainId: row.chain_id,
    address: row.normalized_address,
    generation: row.generation,
    attemptCount: row.attempt_count,
    claimToken: row.claim_token,
    stale: row.stale
  }));
}

export async function isAlchemyAddressClaimCurrent(claim, dbQuery = query) {
  const result = await dbQuery(
    `SELECT 1 FROM alchemy_address_reconciliation
     WHERE chain_id = $1 AND normalized_address = $2
       AND generation = $3 AND claim_token = $4
       AND lease_expires_at > NOW()`,
    [claim.chainId, claim.address, claim.generation, claim.claimToken]
  );
  return result.rowCount === 1;
}

export async function completeAlchemyAddressClaim(claim, observed, dbQuery = query) {
  const result = await dbQuery(
    `DELETE FROM alchemy_address_reconciliation ar
     WHERE ar.chain_id = $1 AND ar.normalized_address = $2
       AND ar.generation = $3 AND ar.claim_token = $4
       AND ar.lease_expires_at > NOW()
       AND $5::boolean = EXISTS (
         SELECT 1 FROM tracked_wallets tw
         INNER JOIN wallet_chains wc ON wc.wallet_id = tw.id
         WHERE tw.status = 'active' AND wc.enabled = TRUE
           AND wc.chain_id = ar.chain_id
           AND LOWER(tw.address) = ar.normalized_address
       )`,
    [claim.chainId, claim.address, claim.generation, claim.claimToken, observed]
  );
  return result.rowCount === 1;
}

export async function releaseAlchemyAddressClaim(claim, dbQuery = query) {
  const result = await dbQuery(
    `UPDATE alchemy_address_reconciliation
     SET claim_token = NULL, lease_expires_at = NULL, next_attempt_at = NOW(), updated_at = NOW()
     WHERE chain_id = $1 AND normalized_address = $2
       AND generation = $3 AND claim_token = $4`,
    [claim.chainId, claim.address, claim.generation, claim.claimToken]
  );
  return result.rowCount === 1;
}

export async function retryAlchemyAddressClaim(claim, { delayMs, errorCode }) {
  const result = await query(
    `UPDATE alchemy_address_reconciliation
     SET attempt_count = attempt_count + 1,
         next_attempt_at = NOW() + ($5::int * INTERVAL '1 millisecond'),
         claim_token = NULL, lease_expires_at = NULL,
         last_error_code = $6, updated_at = NOW()
     WHERE chain_id = $1 AND normalized_address = $2
       AND generation = $3 AND claim_token = $4`,
    [claim.chainId, claim.address, claim.generation, claim.claimToken, delayMs, errorCode]
  );
  return result.rowCount === 1;
}

export async function getAlchemyReconciliationBacklog() {
  const result = await query(
    `SELECT COUNT(*)::int AS count,
            EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int AS oldest_age_seconds
     FROM alchemy_address_reconciliation`
  );
  return {
    count: result.rows[0].count,
    oldestAgeSeconds: result.rows[0].oldest_age_seconds ?? null
  };
}
