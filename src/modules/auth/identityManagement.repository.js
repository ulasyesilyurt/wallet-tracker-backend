import { pool } from '../../db/pool.js';
import {
  createIdentity, findIdentityByProviderSubject, listIdentitiesForUser
} from './identity.repository.js';
import { HttpError } from '../../utils/httpError.js';

function reauthFailed() {
  return new HttpError(401, 'AUTH_REAUTH_FAILED', 'Current account proof is invalid.');
}

function reauthUnavailable() {
  return new HttpError(403, 'AUTH_REAUTH_METHOD_UNAVAILABLE', 'Fresh account proof is unavailable for this account.');
}

async function withLockedAccount(userId, sessionId, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Password reset takes this same user lock before changing the hash and
    // revoking sessions. Identity mutations for one account also serialize here.
    const user = await client.query('SELECT password_hash FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user.rows[0]) throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
    const session = await client.query(`
      SELECT revoked_at FROM auth_sessions
      WHERE id = $1 AND user_id = $2 FOR UPDATE
    `, [sessionId, userId]);
    if (!session.rows[0] || session.rows[0].revoked_at) {
      throw new HttpError(401, 'AUTH_INVALID_TOKEN', 'Invalid access token.');
    }
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

export function linkProviderIdentity({ userId, sessionId, expectedPasswordHash, provider, subject }) {
  return withLockedAccount(userId, sessionId, async (client, user) => {
    if (!user.password_hash || user.password_hash !== expectedPasswordHash) throw reauthFailed();

    const existingSubject = await findIdentityByProviderSubject(provider, subject, client);
    if (existingSubject) {
      if (existingSubject.userId !== userId) {
        throw new HttpError(409, 'AUTH_IDENTITY_LINKED_ELSEWHERE', 'Provider identity is unavailable.');
      }
      return { provider, linked: true };
    }
    const identities = await listIdentitiesForUser(userId, client);
    if (identities.some((identity) => identity.provider === provider)) {
      throw new HttpError(409, 'AUTH_IDENTITY_ALREADY_LINKED', 'This account already has that provider.');
    }
    await createIdentity({ userId, provider, subject }, client);
    return { provider, linked: true };
  });
}

export function unlinkProviderIdentity({ userId, sessionId, expectedPasswordHash, provider }) {
  return withLockedAccount(userId, sessionId, async (client, user) => {
    const identities = await listIdentitiesForUser(userId, client);
    if (!identities.some((identity) => identity.provider === provider)) {
      throw new HttpError(404, 'AUTH_IDENTITY_NOT_LINKED', 'Provider identity is not linked.');
    }
    if (!user.password_hash && identities.length === 1) {
      throw new HttpError(409, 'AUTH_LAST_LOGIN_METHOD', 'The last login method cannot be removed.');
    }
    if (!user.password_hash) throw reauthUnavailable();
    if (user.password_hash !== expectedPasswordHash) throw reauthFailed();

    await client.query('DELETE FROM auth_identities WHERE user_id = $1 AND provider = $2', [userId, provider]);
    return { provider, unlinked: true };
  });
}
