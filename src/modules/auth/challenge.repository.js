import { pool } from '../../db/pool.js';

async function withLockedUser(userId, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT id FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
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

export async function issueChallenge({ id, userId, purpose, digest, expiresInSeconds }) {
  return withLockedUser(userId, async (client) => {
    const recent = await client.query(`
      SELECT COUNT(*)::int AS count,
        COALESCE(BOOL_OR(consumed_at IS NULL AND created_at > NOW() - INTERVAL '1 minute'), FALSE) AS cooling_down
      FROM auth_challenges
      WHERE user_id = $1 AND purpose = $2 AND created_at > NOW() - INTERVAL '1 hour'
    `, [userId, purpose]);
    if (recent.rows[0].count >= 5 || recent.rows[0].cooling_down) {
      return { issued: false };
    }
    await client.query(`
      UPDATE auth_challenges SET consumed_at = NOW()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
    `, [userId, purpose]);
    await client.query(`
      INSERT INTO auth_challenges (id, user_id, purpose, code_digest, expires_at)
      VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 second'))
    `, [id, userId, purpose, digest, expiresInSeconds]);
    return { issued: true };
  });
}

export async function invalidateChallenge(id) {
  await pool.query('UPDATE auth_challenges SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL', [id]);
}

export async function consumeChallenge({ userId, purpose, matches, passwordHash }) {
  return withLockedUser(userId, async (client) => {
    const result = await client.query(`
      SELECT id, code_digest
      FROM auth_challenges
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
        AND expires_at > NOW() AND attempts < 5
      ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE
    `, [userId, purpose]);
    const challenge = result.rows[0];
    if (!challenge) {
      return false;
    }
    if (!matches(challenge)) {
      await client.query('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);
      return false;
    }
    await client.query('UPDATE auth_challenges SET consumed_at = NOW() WHERE id = $1', [challenge.id]);
    if (purpose === 'verify_email') {
      await client.query('UPDATE app_users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1', [userId]);
    } else {
      await client.query('UPDATE app_users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [userId, passwordHash]);
    }
    return true;
  });
}
