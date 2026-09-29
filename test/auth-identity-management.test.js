import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_identity_management';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_IDENTITY_MANAGEMENT_RATE_LIMIT_MAX = '1000';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '1000';
process.env.AUTH_GOOGLE_RATE_LIMIT_MAX = '1000';
process.env.AUTH_APPLE_RATE_LIMIT_MAX = '1000';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const { default: request } = await import('supertest');
const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = await import('jose');
const { createApp } = await import('../src/app.js');
const { createGoogleIdTokenVerifier } = await import('../src/modules/auth/google.verifier.js');
const { createAppleIdTokenVerifier } = await import('../src/modules/auth/apple.verifier.js');
const { createIdentity } = await import('../src/modules/auth/identity.repository.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { verifyAccessToken } = await import('../src/utils/jwt.js');
const { hashPassword } = await import('../src/utils/password.js');

const googleKeys = await generateKeyPair('RS256');
const appleKeys = await generateKeyPair('RS256');
const googleJwk = { ...await exportJWK(googleKeys.publicKey), kid: 'google-link-test', alg: 'RS256', use: 'sig' };
const appleJwk = { ...await exportJWK(appleKeys.publicKey), kid: 'apple-link-test', alg: 'RS256', use: 'sig' };
const googleVerifier = createGoogleIdTokenVerifier({
  config: { GOOGLE_AUTH_ENABLED: true, GOOGLE_CLIENT_IDS: ['google-link-client'] },
  keyResolver: createLocalJWKSet({ keys: [googleJwk] })
});
const appleVerifier = createAppleIdTokenVerifier({
  config: { APPLE_AUTH_ENABLED: true, APPLE_CLIENT_IDS: ['apple-link-client'] },
  keyResolver: createLocalJWKSet({ keys: [appleJwk] })
});
const app = createApp({ authGoogleVerifier: googleVerifier, authAppleVerifier: appleVerifier });
const emails = new Set();
const password = 'identity-management-password-123';
const nonce = 'signed-link-nonce-hash';

function uniqueEmail(domain = 'example.test') {
  const value = `identity-${randomUUID()}@${domain}`;
  emails.add(value);
  return value;
}

async function googleToken({ subject = `google-${randomUUID()}`, email = uniqueEmail('gmail.com') } = {}) {
  return new SignJWT({ email, email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'google-link-test' })
    .setIssuer('https://accounts.google.com')
    .setAudience('google-link-client')
    .setSubject(subject)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(googleKeys.privateKey);
}

async function appleToken({ subject = `apple-${randomUUID()}`, email = uniqueEmail() } = {}) {
  return new SignJWT({ email, email_verified: 'true', nonce })
    .setProtectedHeader({ alg: 'RS256', kid: 'apple-link-test' })
    .setIssuer('https://appleid.apple.com')
    .setAudience('apple-link-client')
    .setSubject(subject)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(appleKeys.privateKey);
}

async function registerVerified({ email = uniqueEmail(), refresh = false } = {}) {
  let call = request(app).post('/api/v1/auth/register');
  if (refresh) call = call.set('X-Auth-Refresh', 'true');
  const response = await call.send({ email, password });
  assert.equal(response.status, 201);
  await query('UPDATE app_users SET email_verified_at = NOW() WHERE id = $1', [response.body.data.user.id]);
  return response.body.data;
}

function link(accessToken, body, target = app) {
  return request(target).post('/api/v1/auth/identities/link')
    .set('Authorization', `Bearer ${accessToken}`).send(body);
}

function unlink(accessToken, provider, currentPassword, target = app) {
  return request(target).delete(`/api/v1/auth/identities/${provider}`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send(currentPassword === undefined ? {} : { currentPassword });
}

async function identitiesFor(userId) {
  const result = await query('SELECT provider, provider_subject FROM auth_identities WHERE user_id = $1 ORDER BY provider', [userId]);
  return result.rows;
}

async function sessionState(userId) {
  const result = await query('SELECT id, refresh_token_digest, revoked_at FROM auth_sessions WHERE user_id = $1 ORDER BY id', [userId]);
  return result.rows;
}

after(async () => {
  try {
    await query('DELETE FROM app_users WHERE email = ANY($1::text[])', [[...emails]]);
  } finally {
    await pool.end();
  }
});

test('password proof links Google despite provider email mismatch without changing account or session', async () => {
  const account = await registerVerified({ refresh: true });
  const otherAccount = await registerVerified();
  const userId = account.user.id;
  const beforeUser = (await query('SELECT email, email_verified_at FROM app_users WHERE id = $1', [userId])).rows[0];
  const beforeSessions = await sessionState(userId);
  const subject = `google-${randomUUID()}`;
  const result = await link(account.accessToken, {
    provider: 'google', idToken: await googleToken({ subject, email: otherAccount.user.email }), currentPassword: password
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: { provider: 'google', linked: true } });
  assert.deepEqual(await identitiesFor(userId), [{ provider: 'google', provider_subject: subject }]);
  assert.deepEqual(await identitiesFor(otherAccount.user.id), []);
  const afterUser = (await query('SELECT email, email_verified_at FROM app_users WHERE id = $1', [userId])).rows[0];
  assert.deepEqual(afterUser, beforeUser);
  assert.deepEqual(await sessionState(userId), beforeSessions);
  assert.equal((await request(app).get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${account.accessToken}`)).status, 200);
  assert.equal((await verifyAccessToken(account.accessToken)).sid, beforeSessions[0].id);
  assert.equal((await request(app).post('/api/v1/auth/refresh')
    .send({ refreshToken: account.refreshToken })).status, 200);
});

test('password proof links Apple with exact nonce; missing or wrong proof cannot link', async () => {
  const account = await registerVerified();
  const subject = `apple-${randomUUID()}`;
  const identityToken = await appleToken({ subject });
  const base = { provider: 'apple', identityToken, expectedNonce: nonce };
  const missing = await link(account.accessToken, { ...base, identityToken: 'not-a-jwt' });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, 'AUTH_REAUTH_REQUIRED');
  const wrong = await link(account.accessToken, {
    ...base, identityToken: 'not-a-jwt', currentPassword: 'wrong-password'
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'AUTH_REAUTH_FAILED');
  assert.deepEqual(await identitiesFor(account.user.id), []);
  const badNonce = await link(account.accessToken, { ...base, expectedNonce: 'wrong-nonce', currentPassword: password });
  assert.equal(badNonce.status, 401);
  assert.equal(badNonce.body.error.code, 'AUTH_INVALID_PROVIDER_TOKEN');
  assert.deepEqual(await identitiesFor(account.user.id), []);
  const linked = await link(account.accessToken, { ...base, currentPassword: password });
  assert.equal(linked.status, 200);
  assert.deepEqual(await identitiesFor(account.user.id), [{ provider: 'apple', provider_subject: subject }]);
});

test('same identity is idempotent; different or foreign identity conflicts without merge', async () => {
  const first = await registerVerified();
  const second = await registerVerified();
  const subject = `google-${randomUUID()}`;
  const token = await googleToken({ subject });
  const body = { provider: 'google', idToken: token, currentPassword: password };
  assert.equal((await link(first.accessToken, body)).status, 200);
  assert.equal((await link(first.accessToken, body)).status, 200);
  const different = await link(first.accessToken, {
    provider: 'google', idToken: await googleToken(), currentPassword: password
  });
  assert.equal(different.status, 409);
  assert.equal(different.body.error.code, 'AUTH_IDENTITY_ALREADY_LINKED');
  const foreign = await link(second.accessToken, body);
  assert.equal(foreign.status, 409);
  assert.deepEqual(foreign.body, {
    error: { code: 'AUTH_IDENTITY_LINKED_ELSEWHERE', message: 'Provider identity is unavailable.' }
  });
  assert.deepEqual(await identitiesFor(second.user.id), []);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM app_users WHERE id = ANY($1::uuid[])',
    [[first.user.id, second.user.id]])).rows[0].count, 2);
});

test('social-only bearer cannot link another provider or remove its last identity', async () => {
  const email = uniqueEmail('gmail.com');
  const signedGoogle = await googleToken({ email });
  const signedIn = await request(app).post('/api/v1/auth/google').send({ idToken: signedGoogle });
  assert.equal(signedIn.status, 200);
  const account = signedIn.body.data;
  const beforeSessions = await sessionState(account.user.id);
  const linkAttempt = await link(account.accessToken, {
    provider: 'apple', identityToken: await appleToken(), expectedNonce: nonce
  });
  assert.equal(linkAttempt.status, 403);
  assert.equal(linkAttempt.body.error.code, 'AUTH_REAUTH_METHOD_UNAVAILABLE');
  const unlinkAttempt = await unlink(account.accessToken, 'google');
  assert.equal(unlinkAttempt.status, 409);
  assert.equal(unlinkAttempt.body.error.code, 'AUTH_LAST_LOGIN_METHOD');
  assert.deepEqual((await identitiesFor(account.user.id)).map((identity) => identity.provider), ['google']);
  assert.deepEqual(await sessionState(account.user.id), beforeSessions);
});

test('link requires authenticated verified access and valid provider proof', async () => {
  const unverified = await request(app).post('/api/v1/auth/register')
    .send({ email: uniqueEmail(), password });
  assert.equal(unverified.status, 201);
  const body = { provider: 'google', idToken: await googleToken(), currentPassword: password };
  const unauthenticated = await request(app).post('/api/v1/auth/identities/link').send(body);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.error.code, 'AUTH_MISSING_TOKEN');
  const blocked = await link(unverified.body.data.accessToken, body);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'AUTH_EMAIL_VERIFICATION_REQUIRED');

  const verified = await registerVerified();
  const invalid = await link(verified.accessToken, {
    provider: 'google', idToken: 'not-a-jwt', currentPassword: password
  });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.body.error.code, 'AUTH_INVALID_PROVIDER_TOKEN');
  assert.deepEqual(await identitiesFor(verified.user.id), []);
});

test('Apple-only last method is guarded; social-only two-provider unlink requires fresh proof', async () => {
  const email = uniqueEmail();
  const signedIn = await request(app).post('/api/v1/auth/apple')
    .send({ identityToken: await appleToken({ email }), expectedNonce: nonce });
  assert.equal(signedIn.status, 200);
  const account = signedIn.body.data;
  const last = await unlink(account.accessToken, 'apple');
  assert.equal(last.status, 409);
  assert.equal(last.body.error.code, 'AUTH_LAST_LOGIN_METHOD');

  await createIdentity({ userId: account.user.id, provider: 'google', subject: `google-${randomUUID()}` });
  const attempts = await Promise.all([
    unlink(account.accessToken, 'google'), unlink(account.accessToken, 'apple')
  ]);
  assert.deepEqual(attempts.map((response) => response.body.error.code), [
    'AUTH_REAUTH_METHOD_UNAVAILABLE', 'AUTH_REAUTH_METHOD_UNAVAILABLE'
  ]);
  assert.deepEqual((await identitiesFor(account.user.id)).map((identity) => identity.provider), ['apple', 'google']);
});

test('password-backed unlink needs proof and preserves user, session and remaining method', async () => {
  const account = await registerVerified();
  const googleSubject = `google-${randomUUID()}`;
  const appleSubject = `apple-${randomUUID()}`;
  assert.equal((await link(account.accessToken, {
    provider: 'google', idToken: await googleToken({ subject: googleSubject }), currentPassword: password
  })).status, 200);
  assert.equal((await link(account.accessToken, {
    provider: 'apple', identityToken: await appleToken({ subject: appleSubject }), expectedNonce: nonce,
    currentPassword: password
  })).status, 200);
  const beforeSessions = await sessionState(account.user.id);
  const missing = await unlink(account.accessToken, 'google');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, 'AUTH_REAUTH_REQUIRED');
  const wrong = await unlink(account.accessToken, 'google', 'wrong-password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'AUTH_REAUTH_FAILED');
  assert.equal((await identitiesFor(account.user.id)).length, 2);
  const removed = await unlink(account.accessToken, 'google', password);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { data: { provider: 'google', unlinked: true } });
  assert.deepEqual((await identitiesFor(account.user.id)).map((identity) => identity.provider), ['apple']);
  assert.deepEqual(await sessionState(account.user.id), beforeSessions);
  assert.equal((await request(app).get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${account.accessToken}`)).status, 200);
  const removedLastProvider = await unlink(account.accessToken, 'apple', password);
  assert.equal(removedLastProvider.status, 200);
  assert.deepEqual(await identitiesFor(account.user.id), []);
  assert.equal((await request(app).post('/api/v1/auth/login')
    .send({ email: account.user.email, password })).status, 200);
  assert.equal((await unlink(account.accessToken, 'apple', password)).body.error.code, 'AUTH_IDENTITY_NOT_LINKED');
});

test('password and Google account can remove its only provider while keeping its session', async () => {
  const account = await registerVerified();
  assert.equal((await link(account.accessToken, {
    provider: 'google', idToken: await googleToken(), currentPassword: password
  })).status, 200);
  const sessionsBefore = await sessionState(account.user.id);
  const removed = await unlink(account.accessToken, 'google', password);
  assert.equal(removed.status, 200);
  assert.deepEqual(await identitiesFor(account.user.id), []);
  assert.deepEqual(await sessionState(account.user.id), sessionsBefore);
  assert.equal((await request(app).get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${account.accessToken}`)).status, 200);
});

test('concurrent links respect subject and per-user provider uniqueness', async () => {
  const first = await registerVerified();
  const second = await registerVerified();
  const shared = await googleToken({ subject: `google-${randomUUID()}` });
  const sameSubject = await Promise.all([
    link(first.accessToken, { provider: 'google', idToken: shared, currentPassword: password }),
    link(second.accessToken, { provider: 'google', idToken: shared, currentPassword: password })
  ]);
  assert.deepEqual(sameSubject.map((response) => response.status).sort(), [200, 409]);
  assert.equal(sameSubject.find((response) => response.status === 409).body.error.code,
    'AUTH_IDENTITY_LINKED_ELSEWHERE');
  const subjects = await query('SELECT user_id FROM auth_identities WHERE provider = $1 AND provider_subject = $2',
    ['google', (await googleVerifier(shared)).subject]);
  assert.equal(subjects.rowCount, 1);

  const third = await registerVerified();
  const different = await Promise.all([
    link(third.accessToken, { provider: 'google', idToken: await googleToken(), currentPassword: password }),
    link(third.accessToken, { provider: 'google', idToken: await googleToken(), currentPassword: password })
  ]);
  assert.deepEqual(different.map((response) => response.status).sort(), [200, 409]);
  assert.equal(different.find((response) => response.status === 409).body.error.code,
    'AUTH_IDENTITY_ALREADY_LINKED');
  assert.equal((await identitiesFor(third.user.id)).length, 1);
});

test('concurrent password-backed unlinks cannot remove the password login method', async () => {
  const account = await registerVerified();
  assert.equal((await link(account.accessToken, {
    provider: 'google', idToken: await googleToken(), currentPassword: password
  })).status, 200);
  assert.equal((await link(account.accessToken, {
    provider: 'apple', identityToken: await appleToken(), expectedNonce: nonce, currentPassword: password
  })).status, 200);
  const results = await Promise.all([
    unlink(account.accessToken, 'google', password), unlink(account.accessToken, 'apple', password)
  ]);
  assert.deepEqual(results.map((response) => response.status), [200, 200]);
  assert.deepEqual(await identitiesFor(account.user.id), []);
  assert.equal((await query('SELECT password_hash FROM app_users WHERE id = $1', [account.user.id])).rows[0].password_hash !== null, true);
  assert.equal((await request(app).post('/api/v1/auth/login')
    .send({ email: account.user.email, password })).status, 200);
});

test('password change during provider verification invalidates stale fresh proof', async () => {
  const account = await registerVerified();
  let releaseVerification;
  let enteredVerification;
  const entered = new Promise((resolve) => { enteredVerification = resolve; });
  const hold = new Promise((resolve) => { releaseVerification = resolve; });
  const pausedApp = createApp({
    authGoogleVerifier: async (token) => {
      enteredVerification();
      await hold;
      return googleVerifier(token);
    },
    authAppleVerifier: appleVerifier
  });
  const requestPromise = link(account.accessToken, {
    provider: 'google', idToken: await googleToken(), currentPassword: password
  }, pausedApp);
  const responsePromise = Promise.resolve(requestPromise);
  await entered;
  const nextHash = await hashPassword('new-password-456');
  await query('UPDATE app_users SET password_hash = $2 WHERE id = $1', [account.user.id, nextHash]);
  releaseVerification();
  const response = await responsePromise;
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'AUTH_REAUTH_FAILED');
  assert.deepEqual(await identitiesFor(account.user.id), []);
});

test('logout during provider verification prevents linking through the revoked session', async () => {
  const account = await registerVerified();
  let releaseVerification;
  let enteredVerification;
  const entered = new Promise((resolve) => { enteredVerification = resolve; });
  const hold = new Promise((resolve) => { releaseVerification = resolve; });
  const pausedApp = createApp({
    authGoogleVerifier: async (token) => {
      enteredVerification();
      await hold;
      return googleVerifier(token);
    },
    authAppleVerifier: appleVerifier
  });
  const responsePromise = Promise.resolve(link(account.accessToken, {
    provider: 'google', idToken: await googleToken(), currentPassword: password
  }, pausedApp));
  await entered;
  const logout = await request(app).post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(logout.status, 200);
  releaseVerification();
  const response = await responsePromise;
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'AUTH_INVALID_TOKEN');
  assert.deepEqual(await identitiesFor(account.user.id), []);
});
