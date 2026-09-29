import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_apple_signin';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_APPLE_RATE_LIMIT_MAX = '1000';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '1000';
process.env.AUTH_REFRESH_RATE_LIMIT_MAX = '1000';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const { default: request } = await import('supertest');
const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = await import('jose');
const { createApp } = await import('../src/app.js');
const { createAppleIdTokenVerifier } = await import('../src/modules/auth/apple.verifier.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { verifyAccessToken } = await import('../src/utils/jwt.js');

const trusted = await generateKeyPair('RS256');
const untrusted = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(trusted.publicKey), kid: 'apple-offline', alg: 'RS256', use: 'sig' };
const keyResolver = createLocalJWKSet({ keys: [publicJwk] });
const appleConfig = { APPLE_AUTH_ENABLED: true, APPLE_CLIENT_IDS: ['test-apple-client'] };
const verifyApple = createAppleIdTokenVerifier({ config: appleConfig, keyResolver });
const sent = [];
const app = createApp({
  authAppleVerifier: verifyApple,
  authEmailService: {
    async sendVerificationCode(to, code) { sent.push({ to, code }); },
    async sendPasswordResetCode() {}
  }
});
const disabledApp = createApp({ authAppleVerifier: createAppleIdTokenVerifier({
  config: { APPLE_AUTH_ENABLED: false, APPLE_CLIENT_IDS: ['test-apple-client'] }, keyResolver
}) });
const misconfiguredApp = createApp({ authAppleVerifier: createAppleIdTokenVerifier({
  config: { APPLE_AUTH_ENABLED: true, APPLE_CLIENT_IDS: [] }, keyResolver
}) });
const emails = new Set();
const expectedNonce = 'signed-apple-nonce-hash';

function uniqueEmail(domain = 'example.test') {
  const email = `apple-${randomUUID()}@${domain}`;
  emails.add(email);
  return email;
}

async function appleToken({ subject = `apple-${randomUUID()}`, email, emailVerified = 'true',
  isPrivateEmail = 'false', nonce = expectedNonce, privateKey = trusted.privateKey } = {}) {
  const claims = { nonce, email_verified: emailVerified, is_private_email: isPrivateEmail };
  if (email !== undefined) claims.email = email;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'apple-offline' })
    .setIssuer('https://appleid.apple.com')
    .setAudience('test-apple-client')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

function signIn(identityToken, { refresh = false, nonce = expectedNonce, target = app } = {}) {
  let call = request(target).post('/api/v1/auth/apple');
  if (refresh) call = call.set('X-Auth-Refresh', 'true');
  return call.send({ identityToken, expectedNonce: nonce });
}

async function rowsForEmail(email) {
  const users = await query('SELECT id, email, password_hash, name, email_verified_at FROM app_users WHERE LOWER(email) = LOWER($1)', [email]);
  const ids = users.rows.map((user) => user.id);
  const identities = await query('SELECT provider, provider_subject, user_id FROM auth_identities WHERE user_id = ANY($1::uuid[])', [ids]);
  const sessions = await query('SELECT id, user_id, refresh_token_digest FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [ids]);
  return { users: users.rows, identities: identities.rows, sessions: sessions.rows };
}

after(async () => {
  try {
    await query('DELETE FROM app_users WHERE email = ANY($1::text[])', [[...emails]]);
  } finally {
    await pool.end();
  }
});

test('verified Apple email creates a passwordless user, identity and refresh session', async () => {
  const email = uniqueEmail();
  const subject = `apple-${randomUUID()}`;
  const response = await signIn(await appleToken({ subject, email }), { refresh: true });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.data).sort(), ['accessToken', 'refreshToken', 'user']);
  assert.deepEqual(Object.keys(response.body.data.user).sort(), ['createdAt', 'email', 'emailVerified', 'id', 'name', 'updatedAt']);
  assert.equal(response.body.data.user.email, email);
  assert.equal(response.body.data.user.emailVerified, true);
  assert.equal(response.body.data.user.name, null);

  const stored = await rowsForEmail(email);
  assert.equal(stored.users.length, 1);
  assert.equal(stored.users[0].password_hash, null);
  assert.deepEqual(stored.identities, [{ provider: 'apple', provider_subject: subject, user_id: stored.users[0].id }]);
  assert.equal(stored.sessions.length, 1);
  assert.ok(stored.sessions[0].refresh_token_digest);
  assert.equal((await verifyAccessToken(response.body.data.accessToken)).sid, stored.sessions[0].id);
  assert.equal((await verifyAccessToken(response.body.data.accessToken)).sub, stored.users[0].id);

  const refreshed = await request(app).post('/api/v1/auth/refresh')
    .send({ refreshToken: response.body.data.refreshToken });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.data.refreshToken, response.body.data.refreshToken);
  assert.equal((await request(app).post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`)).status, 200);
  assert.equal((await request(app).post('/api/v1/auth/refresh')
    .send({ refreshToken: refreshed.body.data.refreshToken })).status, 401);
});

test('private relay email is accepted and provider-verified; false claim stays unverified', async () => {
  const relay = uniqueEmail('privaterelay.appleid.com');
  const verified = await signIn(await appleToken({ email: relay, isPrivateEmail: 'true' }));
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.email, relay);
  assert.equal(verified.body.data.user.emailVerified, true);
  const unverified = await signIn(await appleToken({
    email: uniqueEmail('privaterelay.appleid.com'), isPrivateEmail: 'true', emailVerified: 'false'
  }));
  assert.equal(unverified.status, 200);
  assert.equal(unverified.body.data.user.emailVerified, false);
});

test('known Apple subject ignores changed or omitted email and preserves verification state', async () => {
  const email = uniqueEmail();
  const subject = `apple-${randomUUID()}`;
  const first = await signIn(await appleToken({ subject, email, emailVerified: 'false' }));
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body.data).sort(), ['accessToken', 'user']);
  assert.equal(first.body.data.user.emailVerified, false);
  const otherEmail = uniqueEmail();
  assert.equal((await request(app).post('/api/v1/auth/register')
    .send({ email: otherEmail, password: 'another-password-123' })).status, 201);
  const changed = await signIn(await appleToken({ subject, email: otherEmail }));
  const omitted = await signIn(await appleToken({ subject }), { refresh: true });
  assert.equal(changed.status, 200);
  assert.equal(omitted.status, 200);
  assert.equal(changed.body.data.user.id, first.body.data.user.id);
  assert.equal(omitted.body.data.user.id, first.body.data.user.id);
  assert.equal(omitted.body.data.user.email, email);
  assert.equal(omitted.body.data.user.emailVerified, false);
  assert.equal(typeof omitted.body.data.refreshToken, 'string');
  assert.notEqual((await verifyAccessToken(first.body.data.accessToken)).sid,
    (await verifyAccessToken(omitted.body.data.accessToken)).sid);
  assert.equal((await rowsForEmail(email)).users.length, 1);
});

test('existing normalized email requires linking without creating identity or session', async () => {
  const email = uniqueEmail();
  assert.equal((await request(app).post('/api/v1/auth/register')
    .send({ email, password: 'existing-password-123' })).status, 201);
  const before = await rowsForEmail(email);
  const result = await signIn(await appleToken({ email: email.toUpperCase() }));
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, {
    error: { code: 'AUTH_LINK_REQUIRED', message: 'Sign in to your existing account to link Apple.' }
  });
  const afterRows = await rowsForEmail(email);
  assert.equal(afterRows.users.length, 1);
  assert.deepEqual(afterRows.identities, []);
  assert.equal(afterRows.sessions.length, before.sessions.length);
});

test('unknown Apple subject without email is rejected; known subject can omit email', async () => {
  const missingSubject = `apple-${randomUUID()}`;
  const sessionsBefore = (await query('SELECT COUNT(*)::int AS count FROM auth_sessions')).rows[0].count;
  const missing = await signIn(await appleToken({ subject: missingSubject }));
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.code, 'AUTH_EMAIL_REQUIRED');
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM auth_identities WHERE provider = $1 AND provider_subject = $2',
    ['apple', missingSubject])).rows[0].count, 0);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM auth_sessions')).rows[0].count, sessionsBefore);
  const email = uniqueEmail();
  const subject = `apple-${randomUUID()}`;
  const created = await signIn(await appleToken({ subject, email }));
  const repeated = await signIn(await appleToken({ subject }));
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.data.user.id, created.body.data.user.id);
});

test('invalid token, nonce mismatch and disabled provider fail before database writes', async () => {
  const email = uniqueEmail();
  const sessionsBefore = (await query('SELECT COUNT(*)::int AS count FROM auth_sessions')).rows[0].count;
  const badSignature = await signIn(await appleToken({ email, privateKey: untrusted.privateKey }));
  assert.equal(badSignature.status, 401);
  assert.equal(badSignature.body.error.code, 'AUTH_INVALID_PROVIDER_TOKEN');
  const token = await appleToken({ email });
  const wrongNonce = await signIn(token, { nonce: 'wrong-nonce' });
  assert.equal(wrongNonce.status, 401);
  assert.equal(wrongNonce.body.error.code, 'AUTH_INVALID_PROVIDER_TOKEN');
  const missingNonce = await request(app).post('/api/v1/auth/apple').send({ identityToken: token });
  assert.equal(missingNonce.status, 400);
  assert.equal(missingNonce.body.error.code, 'VALIDATION_ERROR');
  for (const target of [disabledApp, misconfiguredApp]) {
    const unavailable = await signIn(token, { target });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error.code, 'AUTH_PROVIDER_UNAVAILABLE');
  }
  const clientFields = await request(app).post('/api/v1/auth/apple').send({
    identityToken: token, expectedNonce, userId: randomUUID(), email, emailVerified: true, name: 'Fake'
  });
  assert.equal(clientFields.status, 400);
  assert.equal((await rowsForEmail(email)).users.length, 0);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM auth_sessions')).rows[0].count, sessionsBefore);
});

test('concurrent first sign-ins converge only by Apple subject', async () => {
  const email = uniqueEmail();
  const subject = `apple-${randomUUID()}`;
  const token = await appleToken({ subject, email });
  const same = await Promise.all([signIn(token), signIn(token)]);
  assert.deepEqual(same.map((result) => result.status), [200, 200]);
  assert.equal(same[0].body.data.user.id, same[1].body.data.user.id);
  const sameRows = await rowsForEmail(email);
  assert.equal(sameRows.users.length, 1);
  assert.equal(sameRows.identities.length, 1);
  assert.equal(sameRows.sessions.length, 2);

  const differentEmails = [uniqueEmail(), uniqueEmail()];
  const sharedSubject = `apple-${randomUUID()}`;
  const shared = await Promise.all(differentEmails.map(async (candidate) =>
    signIn(await appleToken({ subject: sharedSubject, email: candidate }))));
  assert.deepEqual(shared.map((result) => result.status), [200, 200]);
  assert.equal(shared[0].body.data.user.id, shared[1].body.data.user.id);
  assert.equal((await query('SELECT id FROM app_users WHERE email = ANY($1::text[])', [differentEmails])).rowCount, 1);

  const collisionEmail = uniqueEmail();
  const collision = await Promise.all([
    signIn(await appleToken({ subject: `apple-${randomUUID()}`, email: collisionEmail })),
    signIn(await appleToken({ subject: `apple-${randomUUID()}`, email: collisionEmail }))
  ]);
  assert.deepEqual(collision.map((result) => result.status).sort(), [200, 409]);
  assert.equal(collision.find((result) => result.status === 409).body.error.code, 'AUTH_LINK_REQUIRED');
  const collisionRows = await rowsForEmail(collisionEmail);
  assert.equal(collisionRows.users.length, 1);
  assert.equal(collisionRows.identities.length, 1);
  assert.equal(collisionRows.sessions.length, 1);
});

test('unverified Apple account retains verification gate and neutral password recovery', async () => {
  const email = uniqueEmail();
  const created = await signIn(await appleToken({ email, emailVerified: 'false' }), { refresh: true });
  assert.equal(created.status, 200);
  const authorization = `Bearer ${created.body.data.accessToken}`;
  assert.equal((await request(app).get('/api/v1/auth/me').set('Authorization', authorization)).status, 200);
  const blocked = await request(app).get(`/api/v1/users/${created.body.data.user.id}/wallets`)
    .set('Authorization', authorization);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'AUTH_EMAIL_VERIFICATION_REQUIRED');
  const refreshed = await request(app).post('/api/v1/auth/refresh')
    .send({ refreshToken: created.body.data.refreshToken });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.data.user.emailVerified, false);
  assert.equal((await request(app).post('/api/v1/auth/forgot-password').send({ email })).status, 202);
  assert.equal((await request(app).post('/api/v1/auth/reset-password')
    .send({ email, code: '123456', newPassword: 'new-password-123' })).body.error.code, 'AUTH_INVALID_CODE');
  assert.equal((await request(app).post('/api/v1/auth/email-verification/request')
    .set('Authorization', authorization)).status, 202);
  assert.equal(sent.at(-1).to, email);
  const verified = await request(app).post('/api/v1/auth/email-verification/verify')
    .set('Authorization', authorization).send({ code: sent.at(-1).code });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.emailVerified, true);
  assert.equal((await request(app).get(`/api/v1/users/${created.body.data.user.id}/wallets`)
    .set('Authorization', authorization)).status, 200);
});
