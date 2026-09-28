import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_auth_checks';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '1000';
process.env.AUTH_LOGIN_RATE_LIMIT_MAX = '1000';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { hashPassword } = await import('../src/utils/password.js');

const app = createApp();
const createdEmails = new Set();
const password = 'test-password-for-auth-v2';

function testEmail() {
  const email = `AuthV2${randomUUID().replaceAll('-', '')}@Example.Test`;
  createdEmails.add(email.toLowerCase());
  return email;
}

after(async () => {
  try {
    await query('DELETE FROM app_users WHERE LOWER(email) = ANY($1::text[])', [[...createdEmails]]);
  } finally {
    await pool.end();
  }
});

test('registration keeps its user and access-token response while normalizing email', async () => {
  const email = testEmail();
  const registered = await request(app).post('/api/v1/auth/register')
    .send({ email, password, name: 'Auth Test' });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.data.user.email, email.toLowerCase());
  assert.equal(registered.body.data.user.name, 'Auth Test');
  assert.equal(typeof registered.body.data.accessToken, 'string');

  const me = await request(app).get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${registered.body.data.accessToken}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.id, registered.body.data.user.id);
});

test('mixed-case duplicate registration returns the existing duplicate-account error', async () => {
  const email = testEmail();
  const first = await request(app).post('/api/v1/auth/register')
    .send({ email: email.toLowerCase(), password });
  assert.equal(first.status, 201);

  const duplicate = await request(app).post('/api/v1/auth/register')
    .send({ email: email.toUpperCase(), password });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.body.error, {
    code: 'AUTH_EMAIL_IN_USE',
    message: 'An account with that email already exists.'
  });
});

test('concurrent registration and direct inserts respect normalized database uniqueness', async () => {
  const email = testEmail();
  const responses = await Promise.all([
    request(app).post('/api/v1/auth/register').send({ email: email.toLowerCase(), password }),
    request(app).post('/api/v1/auth/register').send({ email: email.toUpperCase(), password })
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const conflict = responses.find((response) => response.status === 409);
  assert.equal(conflict.body.error.code, 'AUTH_EMAIL_IN_USE');
  assert.equal(JSON.stringify(conflict.body).includes('idx_app_users_email'), false);

  const count = await query('SELECT COUNT(*)::int AS count FROM app_users WHERE LOWER(email) = LOWER($1)', [email]);
  assert.equal(count.rows[0].count, 1);
  await assert.rejects(
    query('INSERT INTO app_users (email) VALUES ($1)', [email.toUpperCase()]),
    (error) => error.code === '23505' && error.constraint === 'idx_app_users_email_normalized_unique'
  );
});

test('legacy mixed-case account can log in with differently cased email', async () => {
  const email = testEmail();
  await query('INSERT INTO app_users (email, password_hash, email_verified_at) VALUES ($1, $2, NOW())', [email, await hashPassword(password)]);

  const loggedIn = await request(app).post('/api/v1/auth/login')
    .send({ email: email.toLowerCase(), password });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.body.data.user.email, email);
  assert.equal(typeof loggedIn.body.data.accessToken, 'string');
});
