import { createHash } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { query } from '../../db/query.js';
import { HttpError } from '../../utils/httpError.js';

const OPERATION = 'account_delete';
const TTL_SECONDS = 5 * 60;
const MAX_CHALLENGES_PER_HOUR = 10;

function invalidToken() {
  return new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
}

function methodUnavailable() {
  return new HttpError(403, 'AUTH_REAUTH_METHOD_UNAVAILABLE', 'Fresh account proof is unavailable for this account.');
}

function invalidChallenge() {
  return new HttpError(400, 'AUTH_REAUTH_INVALID', 'Invalid account reauthentication challenge.');
}

function expiredChallenge() {
  return new HttpError(400, 'AUTH_REAUTH_EXPIRED', 'Account reauthentication challenge expired.');
}

async function withLockedAccount(userId, sessionId, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Match password reset and identity-management lock order.
    const user = await client.query('SELECT password_hash FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user.rows[0]) throw invalidToken();
    const session = await client.query(`
      SELECT id FROM auth_sessions
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE
    `, [sessionId, userId]);
    if (!session.rows[0]) throw invalidToken();
    const result = await work(client, user.rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function requireAvailableMethod(client, user, userId, method) {
  if (method === 'password') {
    if (!user.password_hash) throw methodUnavailable();
    return;
  }
  if (method !== 'apple') throw methodUnavailable();
  const identity = await client.query(`
    SELECT provider_subject FROM auth_identities
    WHERE user_id = $1 AND provider = 'apple'
  `, [userId]);
  if (!identity.rows[0]) throw methodUnavailable();
  return identity.rows[0].provider_subject;
}

export function issueAccountDeletionChallenge({ id, userId, sessionId, method, nonceDigest }) {
  return withLockedAccount(userId, sessionId, async (client, user) => {
    await requireAvailableMethod(client, user, userId, method);
    // Keep only the recent per-account issuance history needed for throttling.
    await client.query(`
      DELETE FROM account_deletion_reauth_challenges
      WHERE user_id = $1 AND created_at < clock_timestamp() - INTERVAL '1 hour'
    `, [userId]);
    await client.query(`
      DELETE FROM account_deletion_authorizations
      WHERE user_id = $1 AND expires_at < clock_timestamp()
    `, [userId]);
    const recent = await client.query(`
      SELECT COUNT(*)::int AS count FROM account_deletion_reauth_challenges
      WHERE user_id = $1 AND created_at > clock_timestamp() - INTERVAL '1 hour'
    `, [userId]);
    if (recent.rows[0].count >= MAX_CHALLENGES_PER_HOUR) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many account reauthentication attempts. Please try again later.');
    }
    await client.query(`
      UPDATE account_deletion_reauth_challenges SET consumed_at = clock_timestamp()
      WHERE session_id = $1 AND operation = $2 AND consumed_at IS NULL
    `, [sessionId, OPERATION]);
    await client.query(`
      UPDATE account_deletion_authorizations SET consumed_at = clock_timestamp()
      WHERE session_id = $1 AND operation = $2 AND consumed_at IS NULL
    `, [sessionId, OPERATION]);
    const result = await client.query(`
      INSERT INTO account_deletion_reauth_challenges
        (id, user_id, session_id, operation, method, nonce_digest, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6,
        clock_timestamp() + ($7::int * INTERVAL '1 second'))
      RETURNING expires_at
    `, [id, userId, sessionId, OPERATION, method, nonceDigest, TTL_SECONDS]);
    return result.rows[0];
  });
}

export async function readAccountDeletionChallenge({ id, userId, sessionId }) {
  const result = await query(`
    SELECT c.id, c.method, c.nonce_digest, c.created_at, c.expires_at,
      c.expires_at <= clock_timestamp() AS expired,
      c.consumed_at, c.attempts, u.password_hash, s.revoked_at
    FROM account_deletion_reauth_challenges c
    JOIN app_users u ON u.id = c.user_id
    JOIN auth_sessions s ON s.id = c.session_id AND s.user_id = c.user_id
    WHERE c.id = $1 AND c.user_id = $2 AND c.session_id = $3
      AND c.operation = $4
  `, [id, userId, sessionId, OPERATION]);
  return result.rows[0] ?? null;
}

export async function recordFailedAccountDeletionProof({ id, userId, sessionId }) {
  await query(`
    UPDATE account_deletion_reauth_challenges SET attempts = attempts + 1
    WHERE id = $1 AND user_id = $2 AND session_id = $3
      AND operation = $4 AND consumed_at IS NULL
      AND expires_at > clock_timestamp() AND attempts < 5
  `, [id, userId, sessionId, OPERATION]);
}

export function completeAccountDeletionReauth({
  id, userId, sessionId, method, expectedPasswordHash,
  expectedNonceDigest, providerSubject, authorizationDigest
}) {
  return withLockedAccount(userId, sessionId, async (client, user) => {
    const result = await client.query(`
      SELECT method, nonce_digest, expires_at <= clock_timestamp() AS expired,
        consumed_at, attempts
      FROM account_deletion_reauth_challenges
      WHERE id = $1 AND user_id = $2 AND session_id = $3 AND operation = $4
      FOR UPDATE
    `, [id, userId, sessionId, OPERATION]);
    const challenge = result.rows[0];
    if (!challenge || challenge.consumed_at || challenge.attempts >= 5 || challenge.method !== method) {
      throw invalidChallenge();
    }
    if (challenge.expired) throw expiredChallenge();

    const linkedSubject = await requireAvailableMethod(client, user, userId, method);
    if (method === 'password' && user.password_hash !== expectedPasswordHash) {
      throw new HttpError(401, 'AUTH_REAUTH_FAILED', 'Current account proof is invalid.');
    }
    if (method === 'apple' && (
      linkedSubject !== providerSubject ||
      !challenge.nonce_digest?.equals(expectedNonceDigest)
    )) {
      throw new HttpError(401, 'AUTH_REAUTH_FAILED', 'Current account proof is invalid.');
    }

    await client.query(`
      UPDATE account_deletion_reauth_challenges SET consumed_at = clock_timestamp()
      WHERE id = $1
    `, [id]);
    await client.query(`
      UPDATE account_deletion_authorizations SET consumed_at = clock_timestamp()
      WHERE session_id = $1 AND operation = $2 AND consumed_at IS NULL
    `, [sessionId, OPERATION]);
    const grant = await client.query(`
      INSERT INTO account_deletion_authorizations
        (authorization_digest, user_id, session_id, operation,
          verified_method, verified_provider_subject, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6,
        clock_timestamp() + ($7::int * INTERVAL '1 second'))
      RETURNING expires_at
    `, [authorizationDigest, userId, sessionId, OPERATION,
      method, method === 'apple' ? providerSubject : null, TTL_SECONDS]);
    return grant.rows[0];
  });
}

// Call inside the future account-deletion transaction, after locking the user
// and session in that order. Rollback also rolls back this one-time consumption.
export async function consumeAccountDeletionAuthorization(client, {
  authorization, userId, sessionId
}) {
  if (typeof authorization !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(authorization)) {
    throw new HttpError(400, 'AUTH_REAUTH_INVALID', 'Invalid account deletion authorization.');
  }
  const authorizationDigest = createHash('sha256').update(authorization).digest();
  const result = await client.query(`
    SELECT a.verified_method, a.verified_provider_subject,
      a.expires_at <= clock_timestamp() AS expired,
      a.consumed_at, s.revoked_at
    FROM account_deletion_authorizations a
    JOIN auth_sessions s ON s.id = a.session_id AND s.user_id = a.user_id
    WHERE a.authorization_digest = $1 AND a.user_id = $2
      AND a.session_id = $3 AND a.operation = $4
    FOR UPDATE OF s, a
  `, [authorizationDigest, userId, sessionId, OPERATION]);
  const grant = result.rows[0];
  if (!grant || grant.consumed_at) {
    throw new HttpError(400, 'AUTH_REAUTH_INVALID', 'Invalid account deletion authorization.');
  }
  if (grant.revoked_at) throw invalidToken();
  if (grant.expired) {
    throw new HttpError(400, 'AUTH_REAUTH_EXPIRED', 'Account deletion authorization expired.');
  }
  if (grant.verified_method === 'password') {
    const user = await client.query('SELECT password_hash FROM app_users WHERE id = $1', [userId]);
    if (!user.rows[0]?.password_hash) throw methodUnavailable();
  } else {
    const identity = await client.query(`
      SELECT 1 FROM auth_identities
      WHERE user_id = $1 AND provider = $2 AND provider_subject = $3
    `, [userId, grant.verified_method, grant.verified_provider_subject]);
    if (!identity.rows[0]) throw methodUnavailable();
  }
  await client.query(`
    UPDATE account_deletion_authorizations SET consumed_at = clock_timestamp()
    WHERE authorization_digest = $1
  `, [authorizationDigest]);
  return {
    verifiedMethod: grant.verified_method,
    verifiedProviderSubject: grant.verified_provider_subject
  };
}
