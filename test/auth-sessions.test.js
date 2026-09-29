import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_auth_sessions';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '1000';
process.env.AUTH_LOGIN_RATE_LIMIT_MAX = '1000';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const { default: request } = await import('supertest');
const { SignJWT } = await import('jose');
const { createApp } = await import('../src/app.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { verifyAccessToken } = await import('../src/utils/jwt.js');
const { consumeChallenge } = await import('../src/modules/auth/challenge.repository.js');

const sent = [];
const app = createApp({
  authEmailService: {
    async sendVerificationCode(to, code) { sent.push({ to, code, purpose: 'verify_email' }); },
    async sendPasswordResetCode(to, code) { sent.push({ to, code, purpose: 'reset_password' }); }
  }
});
const emails = new Set();
const oldPassword = 'session-old-password-123';
const newPassword = 'session-new-password-456';

async function register() {
  const email = `session-${randomUUID()}@example.test`;
  emails.add(email);
  const response = await request(app).post('/api/v1/auth/register').send({ email, password: oldPassword });
  assert.equal(response.status, 201);
  return response.body.data;
}

async function login(email, password = oldPassword) {
  return request(app).post('/api/v1/auth/login').send({ email, password });
}

async function legacyToken(user, { iat = Math.floor(Date.now() / 1000) - 2, includeIat = true } = {}) {
  let token = new SignJWT({ email: user.email, type: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600);
  if (includeIat) token = token.setIssuedAt(iat);
  return token.sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function me(token) {
  return request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
}

after(async () => {
  try {
    await query('DELETE FROM app_users WHERE email = ANY($1::text[])', [[...emails]]);
  } finally {
    await pool.end();
  }
});

test('register and login keep the response contract and create distinct live sessions', async () => {
  const registered = await register();
  assert.deepEqual(Object.keys(registered).sort(), ['accessToken', 'user']);
  assert.deepEqual(Object.keys(registered.user).sort(), ['createdAt', 'email', 'emailVerified', 'id', 'name', 'updatedAt']);
  const first = await verifyAccessToken(registered.accessToken);
  assert.match(first.sid, /^[0-9a-f-]{36}$/);
  assert.equal(first.sub, registered.user.id);
  assert.equal(first.type, 'access');
  assert.equal(first.exp - first.iat, 604800);
  assert.equal((await me(registered.accessToken)).status, 200);

  const loggedIn = await login(registered.user.email);
  assert.equal(loggedIn.status, 200);
  assert.deepEqual(Object.keys(loggedIn.body.data).sort(), ['accessToken', 'user']);
  const second = await verifyAccessToken(loggedIn.body.data.accessToken);
  assert.notEqual(first.sid, second.sid);
  const sessions = await query('SELECT id, revoked_at FROM auth_sessions WHERE user_id = $1', [registered.user.id]);
  assert.deepEqual(new Set(sessions.rows.map((row) => row.id)), new Set([first.sid, second.sid]));
  assert.ok(sessions.rows.every((row) => row.revoked_at === null));

  const blocked = await request(app).get(`/api/v1/users/${registered.user.id}/wallets`)
    .set('Authorization', `Bearer ${registered.accessToken}`);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'AUTH_EMAIL_VERIFICATION_REQUIRED');
});

test('logout works while unverified, revokes only its session, and can be repeated', async () => {
  const registered = await register();
  const second = await login(registered.user.email);
  const secondToken = second.body.data.accessToken;
  const firstSessionId = (await verifyAccessToken(registered.accessToken)).sid;
  const authorization = `Bearer ${registered.accessToken}`;

  const logout = await request(app).post('/api/v1/auth/logout').set('Authorization', authorization);
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.body, { data: { message: 'Logged out.' } });
  assert.equal((await request(app).post('/api/v1/auth/logout').set('Authorization', authorization)).status, 200);
  assert.equal((await me(registered.accessToken)).status, 401);
  assert.equal((await me(secondToken)).status, 200);
  assert.ok((await query('SELECT revoked_at FROM auth_sessions WHERE id = $1', [firstSessionId])).rows[0].revoked_at);
});

test('a session id cannot authenticate a different user', async () => {
  const owner = await register();
  const other = await register();
  const sid = (await verifyAccessToken(owner.accessToken)).sid;
  const token = await new SignJWT({ email: other.user.email, type: 'access', sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(other.user.id)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  assert.equal((await me(token)).status, 401);
});

test('legacy tokens remain transitional, require iat, and honor the revocation cutoff', async () => {
  const registered = await register();
  const valid = await legacyToken(registered.user);
  const missingIat = await legacyToken(registered.user, { includeIat: false });
  assert.equal((await me(valid)).status, 200);
  assert.equal((await me(missingIat)).status, 401);
  assert.equal((await request(app).post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${valid}`)).status, 200);
  assert.equal((await me(valid)).status, 401);
  assert.equal((await request(app).post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${valid}`)).status, 200);
  const cutoff = (await query('SELECT legacy_access_revoked_at FROM app_users WHERE id = $1', [registered.user.id]))
    .rows[0].legacy_access_revoked_at;
  assert.ok(cutoff);
  const sameSecond = await legacyToken(registered.user, { iat: Math.floor(cutoff.getTime() / 1000) });
  assert.equal((await me(sameSecond)).status, 401);
  assert.equal((await me(registered.accessToken)).status, 200);
});

test('a failure while revoking sessions rolls back challenge consumption and password update', async () => {
  const registered = await register();
  const challengeId = randomUUID();
  const originalHash = (await query('SELECT password_hash FROM app_users WHERE id = $1', [registered.user.id]))
    .rows[0].password_hash;
  await query(`
    INSERT INTO auth_challenges (id, user_id, purpose, code_digest, expires_at)
    VALUES ($1, $2, 'reset_password', $3, NOW() + INTERVAL '10 minutes')
  `, [challengeId, registered.user.id, '0'.repeat(64)]);

  const originalConnect = pool.connect;
  pool.connect = async function (...args) {
    const client = await originalConnect.apply(this, args);
    const originalQuery = client.query;
    const originalRelease = client.release;
    client.query = function (sql, ...params) {
      if (typeof sql === 'string' && sql.includes('UPDATE auth_sessions SET revoked_at')) {
        throw new Error('injected revocation failure');
      }
      return originalQuery.call(this, sql, ...params);
    };
    client.release = function (...releaseArgs) {
      client.query = originalQuery;
      client.release = originalRelease;
      return originalRelease.apply(this, releaseArgs);
    };
    return client;
  };
  try {
    await assert.rejects(consumeChallenge({
      userId: registered.user.id,
      purpose: 'reset_password',
      passwordHash: 'new-test-hash',
      matches: () => true
    }), /injected revocation failure/);
  } finally {
    pool.connect = originalConnect;
  }

  const user = (await query('SELECT password_hash, legacy_access_revoked_at FROM app_users WHERE id = $1',
    [registered.user.id])).rows[0];
  assert.equal(user.password_hash, originalHash);
  assert.equal(user.legacy_access_revoked_at, null);
  assert.equal((await query('SELECT consumed_at FROM auth_challenges WHERE id = $1', [challengeId]))
    .rows[0].consumed_at, null);
  assert.equal((await me(registered.accessToken)).status, 200);
});

test('reset consumes its code, changes the password, and revokes all sessions and legacy tokens', async () => {
  const registered = await register();
  const second = await login(registered.user.email);
  const legacy = await legacyToken(registered.user);
  const requested = await request(app).post('/api/v1/auth/forgot-password')
    .send({ email: registered.user.email });
  assert.equal(requested.status, 202);
  const code = sent.at(-1).code;
  const before = (await query('SELECT password_hash FROM app_users WHERE id = $1', [registered.user.id])).rows[0];

  const failed = await request(app).post('/api/v1/auth/reset-password')
    .send({ email: registered.user.email, code: code === '000000' ? '111111' : '000000', newPassword });
  assert.equal(failed.status, 400);
  const unchanged = (await query('SELECT password_hash, legacy_access_revoked_at FROM app_users WHERE id = $1', [registered.user.id])).rows[0];
  assert.equal(unchanged.password_hash, before.password_hash);
  assert.equal(unchanged.legacy_access_revoked_at, null);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [registered.user.id])).rows[0].count, 2);

  const reset = await request(app).post('/api/v1/auth/reset-password')
    .send({ email: registered.user.email, code, newPassword });
  assert.equal(reset.status, 200);
  const changed = (await query('SELECT password_hash, legacy_access_revoked_at FROM app_users WHERE id = $1', [registered.user.id])).rows[0];
  assert.notEqual(changed.password_hash, before.password_hash);
  assert.ok(changed.legacy_access_revoked_at);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [registered.user.id])).rows[0].count, 0);
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM auth_challenges
    WHERE user_id = $1 AND purpose = 'reset_password' AND consumed_at IS NOT NULL`,
  [registered.user.id])).rows[0].count, 1);
  for (const token of [registered.accessToken, second.body.data.accessToken, legacy]) {
    assert.equal((await me(token)).status, 401);
  }
  assert.equal((await login(registered.user.email)).status, 401);
  const fresh = await login(registered.user.email, newPassword);
  assert.equal(fresh.status, 200);
  assert.equal((await me(fresh.body.data.accessToken)).status, 200);
});

test('concurrent reset and old-password login cannot leave a valid old-password session', async () => {
  const registered = await register();
  await request(app).post('/api/v1/auth/forgot-password').send({ email: registered.user.email });
  const code = sent.at(-1).code;
  const [oldLogin, reset] = await Promise.all([
    login(registered.user.email),
    request(app).post('/api/v1/auth/reset-password').send({ email: registered.user.email, code, newPassword })
  ]);
  assert.equal(reset.status, 200);
  assert.ok([200, 401].includes(oldLogin.status));
  if (oldLogin.status === 200) {
    assert.equal((await me(oldLogin.body.data.accessToken)).status, 401);
  }
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [registered.user.id])).rows[0].count, 0);
  assert.equal((await login(registered.user.email, newPassword)).status, 200);
});
