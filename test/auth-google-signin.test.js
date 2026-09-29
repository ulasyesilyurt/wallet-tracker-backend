import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_google_signin';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_GOOGLE_RATE_LIMIT_MAX = '1000';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '1000';
process.env.AUTH_LOGIN_RATE_LIMIT_MAX = '1000';
process.env.AUTH_REFRESH_RATE_LIMIT_MAX = '1000';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const { default: request } = await import('supertest');
const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = await import('jose');
const { createApp } = await import('../src/app.js');
const { createGoogleIdTokenVerifier } = await import('../src/modules/auth/google.verifier.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { verifyAccessToken } = await import('../src/utils/jwt.js');

const trusted = await generateKeyPair('RS256');
const untrusted = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(trusted.publicKey), kid: 'google-offline', alg: 'RS256', use: 'sig' };
const keyResolver = createLocalJWKSet({ keys: [publicJwk] });
const googleConfig = { GOOGLE_AUTH_ENABLED: true, GOOGLE_CLIENT_IDS: ['test-google-client'] };
const verifyGoogle = createGoogleIdTokenVerifier({ config: googleConfig, keyResolver });
const sent = [];
const app = createApp({
  authGoogleVerifier: verifyGoogle,
  authEmailService: {
    async sendVerificationCode(to, code) { sent.push({ to, code }); },
    async sendPasswordResetCode() {}
  }
});
const disabledApp = createApp({
  authGoogleVerifier: createGoogleIdTokenVerifier({
    config: { GOOGLE_AUTH_ENABLED: false, GOOGLE_CLIENT_IDS: ['test-google-client'] }, keyResolver
  })
});
const misconfiguredApp = createApp({
  authGoogleVerifier: createGoogleIdTokenVerifier({
    config: { GOOGLE_AUTH_ENABLED: true, GOOGLE_CLIENT_IDS: [] }, keyResolver
  })
});
const emails = new Set();

function uniqueEmail(domain = 'gmail.com') {
  const email = `social-${randomUUID()}@${domain}`;
  emails.add(email);
  return email;
}

async function googleToken({ subject = `google-${randomUUID()}`, email, emailVerified = true,
  hostedDomain, name = 'Untrusted profile', privateKey = trusted.privateKey } = {}) {
  const claims = { email_verified: emailVerified, name };
  if (email !== undefined) claims.email = email;
  if (hostedDomain !== undefined) claims.hd = hostedDomain;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'google-offline' })
    .setIssuer('https://accounts.google.com')
    .setAudience('test-google-client')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

function signIn(token, { refresh = false, target = app } = {}) {
  let call = request(target).post('/api/v1/auth/google');
  if (refresh) call = call.set('X-Auth-Refresh', 'true');
  return call.send({ idToken: token });
}

async function rowsForEmail(email) {
  const users = await query('SELECT id, email, password_hash, name, email_verified_at FROM app_users WHERE LOWER(email) = LOWER($1)', [email]);
  const userIds = users.rows.map((user) => user.id);
  const identities = await query('SELECT provider, provider_subject, user_id FROM auth_identities WHERE user_id = ANY($1::uuid[])', [userIds]);
  const sessions = await query('SELECT id, user_id, refresh_token_digest FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
  return { users: users.rows, identities: identities.rows, sessions: sessions.rows };
}

after(async () => {
  try {
    await query('DELETE FROM app_users WHERE email = ANY($1::text[])', [[...emails]]);
  } finally {
    await pool.end();
  }
});

test('new Gmail identity creates a passwordless verified user, identity and refresh session', async () => {
  const email = uniqueEmail();
  const subject = `google-${randomUUID()}`;
  const result = await signIn(await googleToken({ subject, email }), { refresh: true });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body.data).sort(), ['accessToken', 'refreshToken', 'user']);
  assert.deepEqual(Object.keys(result.body.data.user).sort(), ['createdAt', 'email', 'emailVerified', 'id', 'name', 'updatedAt']);
  assert.equal(result.body.data.user.email, email);
  assert.equal(result.body.data.user.emailVerified, true);
  assert.equal(result.body.data.user.name, null);

  const stored = await rowsForEmail(email);
  assert.equal(stored.users.length, 1);
  assert.equal(stored.users[0].password_hash, null);
  assert.equal(stored.identities.length, 1);
  assert.deepEqual(stored.identities[0], { provider: 'google', provider_subject: subject, user_id: stored.users[0].id });
  assert.equal(stored.sessions.length, 1);
  assert.ok(stored.sessions[0].refresh_token_digest);
  const jwt = await verifyAccessToken(result.body.data.accessToken);
  assert.equal(jwt.sid, stored.sessions[0].id);
  assert.equal(jwt.sub, stored.users[0].id);

  const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: result.body.data.refreshToken });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.data.user.id, stored.users[0].id);
  assert.notEqual(refreshed.body.data.refreshToken, result.body.data.refreshToken);
  const logout = await request(app).post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`);
  assert.equal(logout.status, 200);
  assert.equal((await request(app).post('/api/v1/auth/refresh')
    .send({ refreshToken: refreshed.body.data.refreshToken })).status, 401);
});

test('known subject signs in with changed or omitted provider email without changing account email', async () => {
  const email = uniqueEmail();
  const subject = `google-${randomUUID()}`;
  const first = await signIn(await googleToken({ subject, email }));
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body.data).sort(), ['accessToken', 'user']);

  const changed = await signIn(await googleToken({ subject, email: uniqueEmail('example.test'), emailVerified: false }));
  const otherEmail = uniqueEmail('example.test');
  assert.equal((await request(app).post('/api/v1/auth/register')
    .send({ email: otherEmail, password: 'other-password-123' })).status, 201);
  const matchingOtherAccount = await signIn(await googleToken({ subject, email: otherEmail }));
  const omitted = await signIn(await googleToken({ subject }));
  const refreshEnabled = await signIn(await googleToken({ subject }), { refresh: true });
  assert.equal(changed.status, 200);
  assert.equal(matchingOtherAccount.status, 200);
  assert.equal(omitted.status, 200);
  assert.equal(refreshEnabled.status, 200);
  assert.equal(typeof refreshEnabled.body.data.refreshToken, 'string');
  assert.equal(refreshEnabled.body.data.user.id, first.body.data.user.id);
  assert.equal(changed.body.data.user.id, first.body.data.user.id);
  assert.equal(matchingOtherAccount.body.data.user.id, first.body.data.user.id);
  assert.equal(omitted.body.data.user.id, first.body.data.user.id);
  assert.equal(omitted.body.data.user.email, email);
  assert.equal(omitted.body.data.user.emailVerified, true);
  assert.notEqual((await verifyAccessToken(first.body.data.accessToken)).sid,
    (await verifyAccessToken(omitted.body.data.accessToken)).sid);
  assert.equal((await rowsForEmail(email)).users.length, 1);
});

test('verified Workspace domain is trusted; third-party and mismatched domains remain unverified', async () => {
  const workspaceEmail = uniqueEmail('workspace.test');
  const workspace = await signIn(await googleToken({
    email: workspaceEmail, hostedDomain: 'workspace.test', emailVerified: true
  }));
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.data.user.emailVerified, true);

  const thirdPartyEmail = uniqueEmail('outside.test');
  const thirdParty = await signIn(await googleToken({ email: thirdPartyEmail, emailVerified: true }));
  assert.equal(thirdParty.status, 200);
  assert.equal(thirdParty.body.data.user.emailVerified, false);
  const mismatchedEmail = uniqueEmail('alias.test');
  const mismatched = await signIn(await googleToken({
    email: mismatchedEmail, hostedDomain: 'workspace.test', emailVerified: true
  }));
  assert.equal(mismatched.status, 200);
  assert.equal(mismatched.body.data.user.emailVerified, false);
  const unverifiedGmail = await signIn(await googleToken({ email: uniqueEmail(), emailVerified: false }));
  assert.equal(unverifiedGmail.body.data.user.emailVerified, false);
});

test('existing normalized email requires explicit linking and creates no identity or session', async () => {
  const email = uniqueEmail('example.test');
  const registered = await request(app).post('/api/v1/auth/register')
    .send({ email, password: 'existing-password-123' });
  assert.equal(registered.status, 201);
  const before = await rowsForEmail(email);
  const response = await signIn(await googleToken({ email: email.toUpperCase() }));
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {
    error: { code: 'AUTH_LINK_REQUIRED', message: 'Sign in to your existing account to link Google.' }
  });
  const afterRows = await rowsForEmail(email);
  assert.equal(afterRows.users.length, 1);
  assert.deepEqual(afterRows.identities, []);
  assert.equal(afterRows.sessions.length, before.sessions.length);
  assert.equal((await request(app).post('/api/v1/auth/login')
    .send({ email, password: 'existing-password-123' })).status, 200);
});

test('missing email blocks unknown subjects while known subjects still sign in', async () => {
  const unknownSubject = `google-${randomUUID()}`;
  const missing = await signIn(await googleToken({ subject: unknownSubject }));
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.code, 'AUTH_EMAIL_REQUIRED');
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM auth_identities WHERE provider = $1 AND provider_subject = $2',
    ['google', unknownSubject])).rows[0].count, 0);

  const email = uniqueEmail();
  const subject = `google-${randomUUID()}`;
  const created = await signIn(await googleToken({ subject, email }));
  const repeated = await signIn(await googleToken({ subject }));
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.data.user.id, created.body.data.user.id);
});

test('invalid or disabled Google credentials fail before account writes', async () => {
  const email = uniqueEmail();
  const invalid = await signIn(await googleToken({ email, privateKey: untrusted.privateKey }));
  assert.equal(invalid.status, 401);
  assert.equal(invalid.body.error.code, 'AUTH_INVALID_PROVIDER_TOKEN');
  assert.equal((await rowsForEmail(email)).users.length, 0);

  const disabled = await signIn(await googleToken({ email }), { target: disabledApp });
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.error.code, 'AUTH_PROVIDER_UNAVAILABLE');
  const misconfigured = await signIn(await googleToken({ email }), { target: misconfiguredApp });
  assert.equal(misconfigured.status, 503);
  assert.equal(misconfigured.body.error.code, 'AUTH_PROVIDER_UNAVAILABLE');
  assert.equal((await rowsForEmail(email)).users.length, 0);
  const clientFields = await request(app).post('/api/v1/auth/google').send({
    idToken: await googleToken({ email }), email, emailVerified: true, name: 'Fake name'
  });
  assert.equal(clientFields.status, 400);
  assert.equal((await rowsForEmail(email)).users.length, 0);
});

test('concurrent same-sub requests converge on one user; same-email different subjects never link', async () => {
  const sameEmail = uniqueEmail();
  const sameSubject = `google-${randomUUID()}`;
  const token = await googleToken({ subject: sameSubject, email: sameEmail });
  const sameResults = await Promise.all([signIn(token), signIn(token)]);
  assert.deepEqual(sameResults.map((result) => result.status), [200, 200]);
  assert.equal(sameResults[0].body.data.user.id, sameResults[1].body.data.user.id);
  const sameRows = await rowsForEmail(sameEmail);
  assert.equal(sameRows.users.length, 1);
  assert.equal(sameRows.identities.length, 1);
  assert.equal(sameRows.sessions.length, 2);

  const differentEmails = [uniqueEmail(), uniqueEmail()];
  const sharedSubject = `google-${randomUUID()}`;
  const sameSubjectDifferentEmails = await Promise.all(differentEmails.map(async (email) =>
    signIn(await googleToken({ subject: sharedSubject, email }))));
  assert.deepEqual(sameSubjectDifferentEmails.map((result) => result.status), [200, 200]);
  assert.equal(sameSubjectDifferentEmails[0].body.data.user.id,
    sameSubjectDifferentEmails[1].body.data.user.id);
  const sharedIdentity = await query(`
    SELECT i.user_id FROM auth_identities i
    WHERE i.provider = 'google' AND i.provider_subject = $1
  `, [sharedSubject]);
  assert.equal(sharedIdentity.rowCount, 1);
  const matchedUsers = await query('SELECT id FROM app_users WHERE email = ANY($1::text[])', [differentEmails]);
  assert.equal(matchedUsers.rowCount, 1);

  const collisionEmail = uniqueEmail();
  const differentResults = await Promise.all([
    signIn(await googleToken({ subject: `google-${randomUUID()}`, email: collisionEmail })),
    signIn(await googleToken({ subject: `google-${randomUUID()}`, email: collisionEmail }))
  ]);
  assert.deepEqual(differentResults.map((result) => result.status).sort(), [200, 409]);
  assert.equal(differentResults.find((result) => result.status === 409).body.error.code, 'AUTH_LINK_REQUIRED');
  const collisionRows = await rowsForEmail(collisionEmail);
  assert.equal(collisionRows.users.length, 1);
  assert.equal(collisionRows.identities.length, 1);
  assert.equal(collisionRows.sessions.length, 1);
});

test('unverified social account keeps email verification gate and password-reset behavior', async () => {
  const email = uniqueEmail('outside.test');
  const created = await signIn(await googleToken({ email }), { refresh: true });
  assert.equal(created.status, 200);
  const access = created.body.data.accessToken;
  const authorization = `Bearer ${access}`;
  assert.equal((await request(app).get('/api/v1/auth/me').set('Authorization', authorization)).status, 200);
  const blocked = await request(app).get(`/api/v1/users/${created.body.data.user.id}/wallets`)
    .set('Authorization', authorization);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'AUTH_EMAIL_VERIFICATION_REQUIRED');
  const refreshed = await request(app).post('/api/v1/auth/refresh')
    .send({ refreshToken: created.body.data.refreshToken });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.data.user.emailVerified, false);
  const forgot = await request(app).post('/api/v1/auth/forgot-password').send({ email });
  assert.equal(forgot.status, 202);
  assert.equal((await request(app).post('/api/v1/auth/reset-password')
    .send({ email, code: '123456', newPassword: 'new-password-123' })).body.error.code, 'AUTH_INVALID_CODE');

  const requested = await request(app).post('/api/v1/auth/email-verification/request')
    .set('Authorization', authorization);
  assert.equal(requested.status, 202);
  assert.equal(sent.at(-1).to, email);
  const verified = await request(app).post('/api/v1/auth/email-verification/verify')
    .set('Authorization', authorization).send({ code: sent.at(-1).code });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.emailVerified, true);
  assert.equal((await request(app).get(`/api/v1/users/${created.body.data.user.id}/wallets`)
    .set('Authorization', authorization)).status, 200);
  assert.equal((await request(app).post('/api/v1/auth/logout').set('Authorization', authorization)).status, 200);
});
