import { randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { query } from '../../db/query.js';
import { env } from '../../config/env.js';
import { createAccessToken } from '../../utils/jwt.js';
import { HttpError } from '../../utils/httpError.js';
import { createRefreshCredential, digestRefreshToken, matchesRefreshDigest } from './refreshToken.js';

function invalidRefreshToken() {
  return new HttpError(401, 'AUTH_INVALID_REFRESH_TOKEN', 'Invalid refresh token.');
}

export async function insertSession(client, userId, refreshCredential) {
  const id = randomUUID();
  await client.query(`
    INSERT INTO auth_sessions (id, user_id, refresh_token_digest, refresh_expires_at)
    VALUES ($1, $2, $3, CASE WHEN $3::bytea IS NULL THEN NULL
      ELSE clock_timestamp() + ($4::bigint * INTERVAL '1 second') END)
  `, [id, userId, refreshCredential?.digest ?? null, env.JWT_REFRESH_TOKEN_TTL_SECONDS]);
  return id;
}

export async function createSessionForPassword(userId, expectedPasswordHash, refreshCredential) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Reset takes the same row lock before changing the hash and revoking sessions.
    const result = await client.query('SELECT password_hash FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
    if (result.rows[0]?.password_hash !== expectedPasswordHash) {
      await client.query('ROLLBACK');
      return null;
    }
    const sessionId = await insertSession(client, userId, refreshCredential);
    await client.query('COMMIT');
    return sessionId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function rotateRefreshToken(token) {
  const candidateDigest = digestRefreshToken(token);
  if (!candidateDigest) throw invalidRefreshToken();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT s.id AS session_id, s.user_id, s.revoked_at,
        s.refresh_token_digest, s.refresh_expires_at,
        s.refresh_expires_at > clock_timestamp() AS refresh_valid,
        u.email, u.name, u.email_verified_at,
        u.created_at AS user_created_at, u.updated_at AS user_updated_at
      FROM auth_sessions s
      JOIN app_users u ON u.id = s.user_id
      WHERE s.refresh_token_digest = $1
      FOR UPDATE OF s
    `, [candidateDigest]);
    const row = result.rows[0];
    if (!row || row.revoked_at || !row.refresh_expires_at || !row.refresh_valid ||
        !matchesRefreshDigest(row.refresh_token_digest, candidateDigest)) {
      throw invalidRefreshToken();
    }

    const nextCredential = createRefreshCredential();
    await client.query(`
      UPDATE auth_sessions
      SET refresh_token_digest = $2,
        refresh_expires_at = clock_timestamp() + ($3::bigint * INTERVAL '1 second'),
        last_used_at = clock_timestamp()
      WHERE id = $1 AND revoked_at IS NULL
    `, [row.session_id, nextCredential.digest, env.JWT_REFRESH_TOKEN_TTL_SECONDS]);

    const user = {
      id: row.user_id,
      email: row.email,
      name: row.name,
      emailVerifiedAt: row.email_verified_at,
      createdAt: row.user_created_at,
      updatedAt: row.user_updated_at
    };
    // Sign before commit so a signing failure leaves the old refresh credential usable.
    const accessToken = await createAccessToken(user, row.session_id, { tokenId: randomUUID() });
    await client.query('COMMIT');
    return { user, accessToken, refreshToken: nextCredential.token };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function findSessionById(sessionId) {
  const result = await query(
    'SELECT id, user_id, revoked_at FROM auth_sessions WHERE id = $1',
    [sessionId]
  );
  return result.rows[0] ?? null;
}

export async function revokeSession(sessionId, userId) {
  await query(
    'UPDATE auth_sessions SET revoked_at = clock_timestamp() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [sessionId, userId]
  );
}

export async function revokeLegacyAccess(userId, tokenIssuedAt) {
  await query(`
    UPDATE app_users SET legacy_access_revoked_at = clock_timestamp()
    WHERE id = $1 AND (
      legacy_access_revoked_at IS NULL OR
      FLOOR(EXTRACT(EPOCH FROM legacy_access_revoked_at)) < $2
    )
  `, [userId, tokenIssuedAt]);
}
