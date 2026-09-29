import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_auth_identities';

const { pool } = await import('../src/db/pool.js');
const {
  createIdentity, findIdentityByProviderSubject, identityUniqueConflict,
  listIdentitiesForUser
} = await import('../src/modules/auth/identity.repository.js');

const migration = await readFile(new URL('../src/db/migrations/024_auth_identities.sql', import.meta.url), 'utf8');

async function expectConflict(client, action, kind) {
  await client.query('SAVEPOINT identity_conflict');
  try {
    await assert.rejects(action, (error) => identityUniqueConflict(error) === kind);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT identity_conflict');
    await client.query('RELEASE SAVEPOINT identity_conflict');
  }
}

test('migration and repository enforce identity uniqueness and cascade deletion', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schema = `auth_identity_test_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(migration);

    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    await client.query('INSERT INTO app_users (id, email) VALUES ($1, $2), ($3, $4)', [
      firstUserId, `identity-${firstUserId}@example.test`,
      secondUserId, `identity-${secondUserId}@example.test`
    ]);

    const google = await createIdentity({ userId: firstUserId, provider: 'google', subject: 'google-123' }, client);
    assert.equal(google.userId, firstUserId);
    assert.equal(google.provider, 'google');
    assert.equal(google.subject, 'google-123');
    assert.ok(google.createdAt instanceof Date);
    assert.equal((await findIdentityByProviderSubject('google', 'google-123', client)).id, google.id);
    assert.equal(await findIdentityByProviderSubject('apple', 'google-123', client), null);

    const apple = await createIdentity({ userId: firstUserId, provider: 'apple', subject: 'apple-456' }, client);
    assert.deepEqual((await listIdentitiesForUser(firstUserId, client)).map((identity) => identity.id), [apple.id, google.id]);

    await expectConflict(client, () => createIdentity({
      userId: secondUserId, provider: 'google', subject: 'google-123'
    }, client), 'subject_taken');
    await expectConflict(client, () => createIdentity({
      userId: firstUserId, provider: 'google', subject: 'other-google-subject'
    }, client), 'provider_already_linked');
    assert.equal(identityUniqueConflict({ code: '23505', constraint: 'other_table_key' }), null);

    await client.query('DELETE FROM app_users WHERE id = $1', [firstUserId]);
    assert.deepEqual(await listIdentitiesForUser(firstUserId, client), []);
    assert.equal(await findIdentityByProviderSubject('apple', 'apple-456', client), null);
    assert.equal((await client.query('SELECT id FROM app_users WHERE id = $1', [secondUserId])).rowCount, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
