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

const sent = [];
const emailService = {
  async sendVerificationCode(to, code) { sent.push({ to, code, purpose: 'verify_email' }); },
  async sendPasswordResetCode(to, code) { sent.push({ to, code, purpose: 'reset_password' }); }
};
const app = createApp({ authEmailService: emailService });
const emails = new Set();
const password = 'original-password-123';

function email() {
  const value = `challenge-${randomUUID()}@example.test`;
  emails.add(value);
  return value;
}

async function register(address = email()) {
  const result = await request(app).post('/api/v1/auth/register').send({ email: address, password });
  assert.equal(result.status, 201);
  return result.body.data;
}

async function latestChallenge(userId, purpose) {
  const result = await query(`
    SELECT id, code_digest, consumed_at, attempts FROM auth_challenges
    WHERE user_id = $1 AND purpose = $2 ORDER BY created_at DESC, id DESC LIMIT 1
  `, [userId, purpose]);
  return result.rows[0];
}

after(async () => {
  try {
    await query('DELETE FROM app_users WHERE email = ANY($1::text[])', [[...emails]]);
  } finally {
    await pool.end();
  }
});

test('new users remain signed in but unverified; verification is single-use', async () => {
  const account = await register();
  assert.equal(account.user.emailVerified, false);
  const authorization = `Bearer ${account.accessToken}`;
  const requested = await request(app).post('/api/v1/auth/email-verification/request').set('Authorization', authorization);
  assert.equal(requested.status, 202);
  const challenge = await latestChallenge(account.user.id, 'verify_email');
  assert.match(challenge.code_digest, /^[a-f0-9]{64}$/);
  assert.equal(challenge.code_digest.includes(sent.at(-1).code), false);
  assert.equal(sent.at(-1).to, account.user.email);
  assert.match(sent.at(-1).code, /^\d{6}$/);

  const invalid = await request(app).post('/api/v1/auth/email-verification/verify')
    .set('Authorization', authorization).send({ code: '999999' === sent.at(-1).code ? '000000' : '999999' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'AUTH_INVALID_CODE');
  assert.equal((await latestChallenge(account.user.id, 'verify_email')).attempts, 1);

  const verified = await request(app).post('/api/v1/auth/email-verification/verify')
    .set('Authorization', authorization).send({ code: sent.at(-1).code });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.emailVerified, true);
  const replay = await request(app).post('/api/v1/auth/email-verification/verify')
    .set('Authorization', authorization).send({ code: sent.at(-1).code });
  assert.equal(replay.status, 400);
  assert.equal((await request(app).get('/api/v1/auth/me').set('Authorization', authorization)).body.data.user.emailVerified, true);
});

test('expired verification fails; resend supersedes the earlier challenge', async () => {
  const account = await register();
  const authorization = `Bearer ${account.accessToken}`;
  await request(app).post('/api/v1/auth/email-verification/request').set('Authorization', authorization);
  const firstCode = sent.at(-1).code;
  const first = await latestChallenge(account.user.id, 'verify_email');
  await query("UPDATE auth_challenges SET created_at = NOW() - INTERVAL '2 minutes' WHERE id = $1", [first.id]);
  const resent = await request(app).post('/api/v1/auth/email-verification/request').set('Authorization', authorization);
  assert.equal(resent.status, 202);
  assert.ok((await query('SELECT consumed_at FROM auth_challenges WHERE id = $1', [first.id])).rows[0].consumed_at);
  if (firstCode !== sent.at(-1).code) {
    const old = await request(app).post('/api/v1/auth/email-verification/verify')
      .set('Authorization', authorization).send({ code: firstCode });
    assert.equal(old.status, 400);
  }
  const current = await latestChallenge(account.user.id, 'verify_email');
  await query("UPDATE auth_challenges SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [current.id]);
  const expired = await request(app).post('/api/v1/auth/email-verification/verify')
    .set('Authorization', authorization).send({ code: sent.at(-1).code });
  assert.equal(expired.status, 400);
});

test('verification request requires the account token and limits rapid resend', async () => {
  const account = await register();
  assert.equal((await request(app).post('/api/v1/auth/email-verification/request')).status, 401);
  const authorization = `Bearer ${account.accessToken}`;
  assert.equal((await request(app).post('/api/v1/auth/email-verification/request').set('Authorization', authorization)).status, 202);
  const limited = await request(app).post('/api/v1/auth/email-verification/request').set('Authorization', authorization);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'AUTH_CODE_REQUEST_LIMITED');
});

test('forgot-password response is neutral; reset changes password and is single-use', async () => {
  const account = await register();
  const unknown = await request(app).post('/api/v1/auth/forgot-password').send({ email: email() });
  const known = await request(app).post('/api/v1/auth/forgot-password').send({ email: account.user.email.toUpperCase() });
  assert.equal(unknown.status, 202);
  assert.equal(known.status, 202);
  assert.deepEqual(known.body, unknown.body);
  const invalidUnknown = await request(app).post('/api/v1/auth/reset-password')
    .send({ email: email(), code: '123456', newPassword: 'new-password-456' });
  assert.equal(invalidUnknown.status, 400);
  assert.equal(invalidUnknown.body.error.code, 'AUTH_INVALID_CODE');
  const code = sent.at(-1).code;
  assert.equal(sent.at(-1).purpose, 'reset_password');
  const wrong = await request(app).post('/api/v1/auth/reset-password')
    .send({ email: account.user.email, code: code === '000000' ? '111111' : '000000', newPassword: 'new-password-456' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'AUTH_INVALID_CODE');
  const reset = await request(app).post('/api/v1/auth/reset-password')
    .send({ email: account.user.email, code, newPassword: 'new-password-456' });
  assert.equal(reset.status, 200);
  assert.equal((await request(app).post('/api/v1/auth/reset-password')
    .send({ email: account.user.email, code, newPassword: 'another-password-789' })).status, 400);
  assert.equal((await request(app).post('/api/v1/auth/login')
    .send({ email: account.user.email, password })).status, 401);
  assert.equal((await request(app).post('/api/v1/auth/login')
    .send({ email: account.user.email, password: 'new-password-456' })).status, 200);
});

test('expired reset code fails and five invalid guesses exhaust a challenge', async () => {
  const account = await register();
  await request(app).post('/api/v1/auth/forgot-password').send({ email: account.user.email });
  let challenge = await latestChallenge(account.user.id, 'reset_password');
  await query("UPDATE auth_challenges SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [challenge.id]);
  assert.equal((await request(app).post('/api/v1/auth/reset-password')
    .send({ email: account.user.email, code: sent.at(-1).code, newPassword: 'new-password-456' })).status, 400);

  await query("UPDATE auth_challenges SET created_at = NOW() - INTERVAL '2 minutes' WHERE id = $1", [challenge.id]);
  await request(app).post('/api/v1/auth/forgot-password').send({ email: account.user.email });
  challenge = await latestChallenge(account.user.id, 'reset_password');
  const correct = sent.at(-1).code;
  const wrong = correct === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    assert.equal((await request(app).post('/api/v1/auth/reset-password')
      .send({ email: account.user.email, code: wrong, newPassword: 'new-password-456' })).status, 400);
  }
  assert.equal((await latestChallenge(account.user.id, 'reset_password')).attempts, 5);
  assert.equal((await request(app).post('/api/v1/auth/reset-password')
    .send({ email: account.user.email, code: correct, newPassword: 'new-password-456' })).status, 400);
});

test('delivery failure is not exposed by forgot-password and invalidates undelivered codes', async () => {
  const account = await register();
  const failingService = {
    async sendVerificationCode() { throw new Error('provider secret in raw error'); },
    async sendPasswordResetCode() { throw new Error('provider secret in raw error'); }
  };
  const failingApp = createApp({ authEmailService: failingService });
  const failedVerification = await request(failingApp).post('/api/v1/auth/email-verification/request')
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(failedVerification.status, 503);
  assert.equal(JSON.stringify(failedVerification.body).includes('provider secret'), false);
  assert.ok((await latestChallenge(account.user.id, 'verify_email')).consumed_at);

  const unknown = await request(failingApp).post('/api/v1/auth/forgot-password').send({ email: email() });
  const known = await request(failingApp).post('/api/v1/auth/forgot-password').send({ email: account.user.email });
  assert.equal(known.status, 202);
  assert.deepEqual(known.body, unknown.body);
  assert.ok((await latestChallenge(account.user.id, 'reset_password')).consumed_at);
});

test('migration policy keeps preexisting users verified without changing login', async () => {
  const address = email();
  const { hashPassword } = await import('../src/utils/password.js');
  await query('INSERT INTO app_users (email, password_hash, email_verified_at) VALUES ($1, $2, NOW())',
    [address, await hashPassword(password)]);
  const loggedIn = await request(app).post('/api/v1/auth/login').send({ email: address.toUpperCase(), password });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.body.data.user.emailVerified, true);
  assert.equal(typeof loggedIn.body.data.accessToken, 'string');
});
