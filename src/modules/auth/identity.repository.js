import { query } from '../../db/query.js';

export const IDENTITY_PROVIDERS = Object.freeze(['google', 'apple']);

function assertProvider(provider) {
  if (!IDENTITY_PROVIDERS.includes(provider)) {
    throw new TypeError('Unsupported identity provider.');
  }
}

function assertSubject(subject) {
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new TypeError('Identity subject is required.');
  }
}

function mapIdentity(row) {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    subject: row.provider_subject,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function findIdentityByProviderSubject(provider, subject, db = { query }) {
  assertProvider(provider);
  assertSubject(subject);
  const result = await db.query(`
    SELECT id, user_id, provider, provider_subject, created_at, updated_at
    FROM auth_identities WHERE provider = $1 AND provider_subject = $2
  `, [provider, subject]);
  return result.rows[0] ? mapIdentity(result.rows[0]) : null;
}

export async function listIdentitiesForUser(userId, db = { query }) {
  const result = await db.query(`
    SELECT id, user_id, provider, provider_subject, created_at, updated_at
    FROM auth_identities WHERE user_id = $1 ORDER BY provider
  `, [userId]);
  return result.rows.map(mapIdentity);
}

export async function createIdentity({ userId, provider, subject }, db = { query }) {
  assertProvider(provider);
  assertSubject(subject);
  const result = await db.query(`
    INSERT INTO auth_identities (user_id, provider, provider_subject)
    VALUES ($1, $2, $3)
    RETURNING id, user_id, provider, provider_subject, created_at, updated_at
  `, [userId, provider, subject]);
  return mapIdentity(result.rows[0]);
}

export function identityUniqueConflict(error) {
  if (error?.code !== '23505') return null;
  if (error.constraint === 'auth_identities_provider_subject_key') return 'subject_taken';
  if (error.constraint === 'auth_identities_user_provider_key') return 'provider_already_linked';
  return null;
}
