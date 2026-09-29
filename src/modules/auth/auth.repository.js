import { query } from '../../db/query.js';
import { pool } from '../../db/pool.js';
import { insertSession } from './session.repository.js';

function mapUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    legacyAccessRevokedAt: row.legacy_access_revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createUserWithSession({ email, passwordHash, name }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      INSERT INTO app_users (email, password_hash, name)
      VALUES (LOWER($1), $2, $3)
      RETURNING id, email, name, password_hash, email_verified_at,
        legacy_access_revoked_at, created_at, updated_at
    `, [email, passwordHash, name ?? null]);
    const user = mapUser(result.rows[0]);
    const sessionId = await insertSession(client, user.id);
    await client.query('COMMIT');
    return { user, sessionId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function findUserByEmail(email) {
  const result = await query(
    `
      SELECT id, email, name, password_hash, email_verified_at,
        legacy_access_revoked_at, created_at, updated_at
      FROM app_users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `,
    [email]
  );

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserById(userId) {
  const result = await query(
    `
      SELECT id, email, name, password_hash, email_verified_at,
        legacy_access_revoked_at, created_at, updated_at
      FROM app_users
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}
