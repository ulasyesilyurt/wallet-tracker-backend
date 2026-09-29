import { pool } from '../../db/pool.js';
import { createIdentity } from './identity.repository.js';
import { insertSession } from './session.repository.js';

function mapUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function createSessionForAppleSubject(subject, refreshCredential) {
  return inTransaction(async (client) => {
    // Serialize session creation with password-reset revocation for this user.
    const result = await client.query(`
      SELECT u.id, u.email, u.name, u.email_verified_at, u.created_at, u.updated_at
      FROM auth_identities i
      JOIN app_users u ON u.id = i.user_id
      WHERE i.provider = 'apple' AND i.provider_subject = $1
      FOR UPDATE OF u
    `, [subject]);
    if (!result.rows[0]) return null;
    const user = mapUser(result.rows[0]);
    const sessionId = await insertSession(client, user.id, refreshCredential);
    return { user, sessionId };
  });
}

export function createAppleAccountWithSession({ email, subject, emailVerified, refreshCredential }) {
  return inTransaction(async (client) => {
    const result = await client.query(`
      INSERT INTO app_users (email, password_hash, name, email_verified_at)
      VALUES (LOWER($1), NULL, NULL, CASE WHEN $2::boolean THEN NOW() ELSE NULL END)
      RETURNING id, email, name, email_verified_at, created_at, updated_at
    `, [email, emailVerified]);
    const user = mapUser(result.rows[0]);
    await createIdentity({ userId: user.id, provider: 'apple', subject }, client);
    const sessionId = await insertSession(client, user.id, refreshCredential);
    return { user, sessionId };
  });
}
