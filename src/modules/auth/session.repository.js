import { randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { query } from '../../db/query.js';

export async function insertSession(client, userId) {
  const id = randomUUID();
  await client.query('INSERT INTO auth_sessions (id, user_id) VALUES ($1, $2)', [id, userId]);
  return id;
}

export async function createSessionForPassword(userId, expectedPasswordHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Reset takes the same row lock before changing the hash and revoking sessions.
    const result = await client.query('SELECT password_hash FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
    if (result.rows[0]?.password_hash !== expectedPasswordHash) {
      await client.query('ROLLBACK');
      return null;
    }
    const sessionId = await insertSession(client, userId);
    await client.query('COMMIT');
    return sessionId;
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
