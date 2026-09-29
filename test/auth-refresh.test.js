import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_auth_refresh';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '1000';
process.env.AUTH_LOGIN_RATE_LIMIT_MAX = '1000';
process.env.AUTH_REFRESH_RATE_LIMIT_MAX = '1000';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { verifyAccessToken } = await import('../src/utils/jwt.js');

const sent = [];
const app = createApp({
  authEmailService: {
    async sendVerificationCode() {},
    async sendPasswordResetCode(to, code) { sent.push({ to, code }); }
  }
});
const emails = new Set();
const password = 'refresh-password-123';

async function register(withRefresh = false) {
  const email = `refresh-${randomUUID()}@example.test`;
  emails.add(email);
  let call = request(app).post('/api/v1/auth/register');
  if (withRefresh) call = call.set('X-Auth-Refresh', 'true');
  const response = await call.send({ email, password });
  assert.equal(response.status, 201);
  return response.body.data;
}

async function login(email, withRefresh = false) {
  let call = request(app).post('/api/v1/auth/login');
  if (withRefresh) call = call.set('X-Auth-Refresh', 'true');
  return call.send({ email, password });
}

async function refresh(refreshToken) {
  return request(app).post('/api/v1/auth/refresh').send({ refreshToken });
}

async function sessionFor(accessToken) {
  const { sid } = await verifyAccessToken(accessToken);
  const result = await query(`
    SELECT id, revoked_at, refresh_token_digest, refresh_expires_at, last_used_at
    FROM auth_sessions WHERE id = $1
  `, [sid]);
  return result.rows[0];
}

after(async () => {
  try {
    await query('DELETE FROM app_users WHERE email = ANY($1::text[])', [[...emails]]);
  } finally {
    await pool.end();
  }
});

test('refresh issuance is opt-in and stores only a digest with a 30-day expiry', async () => {
  const basic = await register();
  assert.deepEqual(Object.keys(basic).sort(), ['accessToken', 'user']);
  const basicSession = await sessionFor(basic.accessToken);
  assert.equal(basicSession.refresh_token_digest, null);
  assert.equal(basicSession.refresh_expires_at, null);
  assert.equal((await request(app).get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${basic.accessToken}`)).status, 200);

  const enabled = await register(true);
  assert.deepEqual(Object.keys(enabled).sort(), ['accessToken', 'refreshToken', 'user']);
  assert.match(enabled.refreshToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await verifyAccessToken(enabled.accessToken)).exp -
    (await verifyAccessToken(enabled.accessToken)).iat, 604800);
  const session = await sessionFor(enabled.accessToken);
  const digest = createHash('sha256').update(enabled.refreshToken).digest();
  assert.equal(session.refresh_token_digest.length, 32);
  assert.deepEqual(session.refresh_token_digest, digest);
  assert.notEqual(session.refresh_token_digest.toString('utf8'), enabled.refreshToken);
  const remainingSeconds = (session.refresh_expires_at.getTime() - Date.now()) / 1000;
  assert.ok(remainingSeconds > 29 * 24 * 60 * 60);
  assert.ok(remainingSeconds <= 30 * 24 * 60 * 60);
  assert.equal(session.last_used_at, null);

  const basicLogin = await login(basic.user.email);
  assert.equal(basicLogin.status, 200);
  assert.deepEqual(Object.keys(basicLogin.body.data).sort(), ['accessToken', 'user']);
  const enabledLogin = await login(basic.user.email, true);
  assert.equal(enabledLogin.status, 200);
  assert.deepEqual(Object.keys(enabledLogin.body.data).sort(), ['accessToken', 'refreshToken', 'user']);
  assert.deepEqual((await sessionFor(enabledLogin.body.data.accessToken)).refresh_token_digest,
    createHash('sha256').update(enabledLogin.body.data.refreshToken).digest());
});

test('refresh rotates its opaque token and issues a distinct access JWT with the same sid', async () => {
  const issued = await register(true);
  const sid = (await verifyAccessToken(issued.accessToken)).sid;
  const first = await refresh(issued.refreshToken);
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body.data).sort(), ['accessToken', 'refreshToken', 'user']);
  assert.deepEqual(Object.keys(first.body.data.user).sort(),
    ['createdAt', 'email', 'emailVerified', 'id', 'name', 'updatedAt']);
  assert.equal(first.body.data.user.id, issued.user.id);
  assert.equal(first.body.data.user.emailVerified, false);
  assert.notEqual(first.body.data.accessToken, issued.accessToken);
  assert.notEqual(first.body.data.refreshToken, issued.refreshToken);
  assert.equal((await verifyAccessToken(first.body.data.accessToken)).sid, sid);
  assert.equal((await verifyAccessToken(first.body.data.accessToken)).exp -
    (await verifyAccessToken(first.body.data.accessToken)).iat, 604800);
  const stored = await sessionFor(first.body.data.accessToken);
  assert.ok(stored.last_used_at);
  assert.deepEqual(stored.refresh_token_digest,
    createHash('sha256').update(first.body.data.refreshToken).digest());
  assert.equal(JSON.stringify(first.body).includes(stored.refresh_token_digest.toString('hex')), false);
  assert.equal(JSON.stringify(first.body).includes('passwordHash'), false);

  const replay = await refresh(issued.refreshToken);
  assert.equal(replay.status, 401);
  assert.deepEqual(replay.body, {
    error: { code: 'AUTH_INVALID_REFRESH_TOKEN', message: 'Invalid refresh token.' }
  });
  assert.equal(JSON.stringify(replay.body).includes(issued.refreshToken), false);
  const second = await refresh(first.body.data.refreshToken);
  assert.equal(second.status, 200);
  assert.equal((await verifyAccessToken(second.body.data.accessToken)).sid, sid);

  const protectedRoute = await request(app).get(`/api/v1/users/${issued.user.id}/wallets`)
    .set('Authorization', `Bearer ${second.body.data.accessToken}`);
  assert.equal(protectedRoute.status, 403);
  assert.equal(protectedRoute.body.error.code, 'AUTH_EMAIL_VERIFICATION_REQUIRED');
});

test('concurrent uses of one refresh token allow only one rotation', async () => {
  const issued = await register(true);
  const responses = await Promise.all([refresh(issued.refreshToken), refresh(issued.refreshToken)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
  const rotated = responses.find((response) => response.status === 200).body.data;
  assert.equal((await refresh(issued.refreshToken)).status, 401);
  assert.equal((await refresh(rotated.refreshToken)).status, 200);
});

test('logout and password reset make refresh credentials unusable', async () => {
  const first = await register(true);
  const secondLogin = await login(first.user.email, true);
  assert.equal(secondLogin.status, 200);
  const second = secondLogin.body.data;

  const logout = await request(app).post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${first.accessToken}`);
  assert.equal(logout.status, 200);
  assert.equal((await refresh(first.refreshToken)).status, 401);
  const surviving = await refresh(second.refreshToken);
  assert.equal(surviving.status, 200);
  assert.equal((await refresh(second.refreshToken)).status, 401);

  const thirdLogin = await login(first.user.email, true);
  assert.equal(thirdLogin.status, 200);
  await request(app).post('/api/v1/auth/forgot-password').send({ email: first.user.email });
  const reset = await request(app).post('/api/v1/auth/reset-password')
    .send({ email: first.user.email, code: sent.at(-1).code, newPassword: 'new-password-456' });
  assert.equal(reset.status, 200);
  assert.equal((await refresh(thirdLogin.body.data.refreshToken)).status, 401);
  assert.equal((await refresh(surviving.body.data.refreshToken)).status, 401);
});

test('expired, malformed, unknown, and credential-free sessions fail with one safe error', async () => {
  const issued = await register(true);
  const session = await sessionFor(issued.accessToken);
  await query("UPDATE auth_sessions SET refresh_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
    [session.id]);
  const expired = await refresh(issued.refreshToken);
  assert.equal(expired.status, 401);

  const revoked = await register(true);
  const revokedSession = await sessionFor(revoked.accessToken);
  await query('UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1', [revokedSession.id]);
  assert.deepEqual((await refresh(revoked.refreshToken)).body, expired.body);

  const noRefresh = await register();
  assert.equal((await sessionFor(noRefresh.accessToken)).refresh_token_digest, null);
  const candidates = [undefined, 42, 'not-a-token', randomBytes(32).toString('base64url')];
  for (const candidate of candidates) {
    const response = await refresh(candidate);
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, expired.body);
  }
  assert.equal(JSON.stringify(expired.body).includes(issued.refreshToken), false);
  assert.equal((await request(app).get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${noRefresh.accessToken}`)).status, 200);
});
