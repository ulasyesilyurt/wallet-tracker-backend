import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_deletion_reauth';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_IDENTITY_MANAGEMENT_RATE_LIMIT_MAX = '1000';
process.env.AUTH_REGISTER_RATE_LIMIT_MAX = '1000';
process.env.AUTH_APPLE_RATE_LIMIT_MAX = '1000';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const { default: request } = await import('supertest');
const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = await import('jose');
const { createApp } = await import('../src/app.js');
const { createAppleIdTokenVerifier } = await import('../src/modules/auth/apple.verifier.js');
const { createAccountDeletionReauth } = await import('../src/modules/auth/accountDeletionReauth.service.js');
const { consumeAccountDeletionAuthorization } = await import('../src/modules/auth/accountDeletionReauth.repository.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { verifyAccessToken } = await import('../src/utils/jwt.js');
const { hashPassword, verifyPassword } = await import('../src/utils/password.js');

const trusted = await generateKeyPair('RS256');
const untrusted = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(trusted.publicKey), kid: 'deletion-apple', alg: 'RS256', use: 'sig' };
const appleVerifier = createAppleIdTokenVerifier({
  config: { APPLE_AUTH_ENABLED: true, APPLE_CLIENT_IDS: ['deletion-apple-client'] },
  keyResolver: createLocalJWKSet({ keys: [publicJwk] })
});
const app = createApp({ authAppleVerifier: appleVerifier });
const emails = new Set();
const password = 'deletion-password-123';

function email() {
  const value = `deletion-${randomUUID()}@example.test`;
  emails.add(value);
  return value;
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

async function appleToken({
  subject = `apple-${randomUUID()}`, nonce = 'normal-signin-nonce',
  tokenEmail = email(), issuer = 'https://appleid.apple.com',
  audience = 'deletion-apple-client', privateKey = trusted.privateKey,
  issuedAt = Math.floor(Date.now() / 1000)
} = {}) {
  let token = new SignJWT({ nonce, email: tokenEmail, email_verified: 'true' })
    .setProtectedHeader({ alg: 'RS256', kid: 'deletion-apple' })
    .setIssuer(issuer).setAudience(audience).setSubject(subject)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600);
  if (issuedAt !== null) token = token.setIssuedAt(issuedAt);
  return token.sign(privateKey);
}

async function register({ verified = false } = {}) {
  const created = await request(app).post('/api/v1/auth/register').send({ email: email(), password });
  assert.equal(created.status, 201);
  const account = created.body.data;
  if (verified) await query('UPDATE app_users SET email_verified_at = NOW() WHERE id = $1', [account.user.id]);
  return account;
}

async function appleAccount({ verified = true } = {}) {
  const subject = `apple-${randomUUID()}`;
  const created = await request(app).post('/api/v1/auth/apple').send({
    identityToken: await appleToken({ subject, tokenEmail: email() }),
    expectedNonce: 'normal-signin-nonce'
  });
  assert.equal(created.status, 200);
  if (!verified) await query('UPDATE app_users SET email_verified_at = NULL WHERE id = $1',
    [created.body.data.user.id]);
  return { ...created.body.data, subject };
}

function challenge(accessToken, method, target = app) {
  return request(target).post('/api/v1/auth/account/reauth/challenge')
    .set('Authorization', `Bearer ${accessToken}`).send({ method });
}

function verify(accessToken, body, target = app) {
  return request(target).post('/api/v1/auth/account/reauth/verify')
    .set('Authorization', `Bearer ${accessToken}`).send(body);
}

async function linkApple(account) {
  const subject = `apple-${randomUUID()}`;
  const linked = await request(app).post('/api/v1/auth/identities/link')
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ provider: 'apple', identityToken: await appleToken({ subject }),
      expectedNonce: 'normal-signin-nonce', currentPassword: password });
  assert.equal(linked.status, 200);
  return subject;
}

async function grantRow(authorization) {
  const result = await query(`
    SELECT user_id, session_id, operation, verified_method, verified_provider_subject,
      expires_at, consumed_at, created_at
    FROM account_deletion_authorizations WHERE authorization_digest = $1
  `, [digest(authorization)]);
  return result.rows[0] ?? null;
}

async function consumeGrant(authorization, userId, sessionId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
    await client.query('SELECT id FROM auth_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    const result = await consumeAccountDeletionAuthorization(client, { authorization, userId, sessionId });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

after(async () => {
  try {
    await query('DELETE FROM app_users WHERE email = ANY($1::text[])', [[...emails]]);
  } finally {
    await pool.end();
  }
});

test('requires an active session-backed token; unverified users can reauthenticate only on deletion routes', async () => {
  const account = await register();
  const missing = await request(app).post('/api/v1/auth/account/reauth/challenge').send({ method: 'password' });
  assert.equal(missing.status, 401);
  const legacy = await new SignJWT({ type: 'access', email: account.user.email })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(account.user.id)
    .setIssuedAt().setExpirationTime('5m')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  assert.equal((await challenge(legacy, 'password')).body.error.code, 'AUTH_INVALID_TOKEN');
  assert.equal((await verify(legacy, {
    challengeId: randomUUID(), method: 'password', currentPassword: password
  })).body.error.code, 'AUTH_INVALID_TOKEN');
  const created = await challenge(account.accessToken, 'password');
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body.data).sort(), ['challengeId', 'expiresAt', 'method']);
  const blocked = await request(app).get(`/api/v1/users/${account.user.id}/wallets`)
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(blocked.body.error.code, 'AUTH_EMAIL_VERIFICATION_REQUIRED');
  const logout = await request(app).post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(logout.status, 200);
  assert.equal((await challenge(account.accessToken, 'password')).body.error.code, 'AUTH_INVALID_TOKEN');
  assert.equal((await verify(account.accessToken, {
    challengeId: created.body.data.challengeId, method: 'password', currentPassword: password
  })).body.error.code, 'AUTH_INVALID_TOKEN');
});

test('password challenges and grants are scoped to account, session, operation and five minutes', async () => {
  const owner = await register();
  const other = await register();
  const secondLogin = await request(app).post('/api/v1/auth/login')
    .send({ email: owner.user.email, password });
  assert.equal(secondLogin.status, 200);
  const issued = await challenge(owner.accessToken, 'password');
  assert.equal(issued.status, 201);
  const id = issued.body.data.challengeId;
  const rows = await query(`
    SELECT user_id, session_id, operation, method, nonce_digest, expires_at, created_at
    FROM account_deletion_reauth_challenges WHERE id = $1
  `, [id]);
  assert.equal(rows.rows[0].user_id, owner.user.id);
  assert.equal(rows.rows[0].session_id, (await verifyAccessToken(owner.accessToken)).sid);
  assert.equal(rows.rows[0].operation, 'account_delete');
  assert.equal(rows.rows[0].method, 'password');
  assert.equal(rows.rows[0].nonce_digest, null);
  assert.ok(Math.abs((rows.rows[0].expires_at - rows.rows[0].created_at) / 1000 - 300) < 2);
  const proof = { challengeId: id, method: 'password', currentPassword: password };
  assert.equal((await verify(other.accessToken, proof)).body.error.code, 'AUTH_REAUTH_INVALID');
  assert.equal((await verify(secondLogin.body.data.accessToken, proof)).body.error.code, 'AUTH_REAUTH_INVALID');
  assert.equal((await verify(owner.accessToken, {
    challengeId: id, method: 'apple', identityToken: 'x'
  }))
    .body.error.code, 'AUTH_REAUTH_INVALID');
  const success = await verify(owner.accessToken, proof);
  assert.equal(success.status, 200);
  const authorization = success.body.data.deletionAuthorization;
  assert.match(authorization, /^[A-Za-z0-9_-]{43}$/);
  const stored = await grantRow(authorization);
  assert.equal(stored.user_id, owner.user.id);
  assert.equal(stored.session_id, rows.rows[0].session_id);
  assert.equal(stored.operation, 'account_delete');
  assert.equal(stored.verified_method, 'password');
  assert.equal(stored.verified_provider_subject, null);
  assert.ok(Math.abs((stored.expires_at - stored.created_at) / 1000 - 300) < 2);
  assert.ok(Math.abs((stored.expires_at - new Date(success.body.data.expiresAt)) / 1000) < 1);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM account_deletion_authorizations WHERE authorization_digest = $1',
    [Buffer.from(authorization)])).rows[0].count, 0);
  assert.equal((await verify(owner.accessToken, proof)).body.error.code, 'AUTH_REAUTH_INVALID');

  await assert.rejects(consumeGrant(authorization, other.user.id,
    (await verifyAccessToken(other.accessToken)).sid), (error) => error.code === 'AUTH_REAUTH_INVALID');
  await assert.rejects(consumeGrant(authorization, owner.user.id,
    (await verifyAccessToken(secondLogin.body.data.accessToken)).sid),
  (error) => error.code === 'AUTH_REAUTH_INVALID');

  const replacement = await challenge(owner.accessToken, 'password');
  assert.equal(replacement.status, 201);
  assert.ok((await grantRow(authorization)).consumed_at);
  assert.equal((await verify(owner.accessToken, proof)).body.error.code, 'AUTH_REAUTH_INVALID');
  await query("UPDATE account_deletion_reauth_challenges SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
    [replacement.body.data.challengeId]);
  assert.equal((await verify(owner.accessToken, { ...proof, challengeId: replacement.body.data.challengeId }))
    .body.error.code, 'AUTH_REAUTH_EXPIRED');
  await assert.rejects(consumeGrant(authorization, owner.user.id, rows.rows[0].session_id),
    (error) => error.code === 'AUTH_REAUTH_INVALID');
});

test('method availability and Google fail closed without creating challenges', async () => {
  const account = await register();
  const social = await appleAccount();
  await query(`
    INSERT INTO auth_identities (user_id, provider, provider_subject)
    VALUES ($1, 'google', $2)
  `, [account.user.id, `google-${randomUUID()}`]);
  const before = (await query('SELECT COUNT(*)::int AS count FROM account_deletion_reauth_challenges')).rows[0].count;
  assert.equal((await challenge(account.accessToken, 'apple')).body.error.code, 'AUTH_REAUTH_METHOD_UNAVAILABLE');
  assert.equal((await challenge(social.accessToken, 'password')).body.error.code, 'AUTH_REAUTH_METHOD_UNAVAILABLE');
  assert.equal((await challenge(account.accessToken, 'google')).body.error.code, 'AUTH_REAUTH_METHOD_UNAVAILABLE');
  assert.equal((await verify(account.accessToken, {
    challengeId: randomUUID(), method: 'google'
  })).body.error.code, 'AUTH_REAUTH_METHOD_UNAVAILABLE');
  const afterCount = (await query('SELECT COUNT(*)::int AS count FROM account_deletion_reauth_challenges')).rows[0].count;
  assert.equal(afterCount, before);
  assert.equal((await request(app).delete('/api/v1/auth/account')
    .set('Authorization', `Bearer ${account.accessToken}`)).status, 404);
});

test('password proof fails safely on wrong, removed, or changed password', async () => {
  const account = await register();
  const created = await challenge(account.accessToken, 'password');
  const proof = { challengeId: created.body.data.challengeId, method: 'password', currentPassword: password };
  const wrong = await verify(account.accessToken, { ...proof, currentPassword: 'incorrect-password' });
  assert.equal(wrong.body.error.code, 'AUTH_REAUTH_FAILED');
  assert.equal((await query('SELECT attempts FROM account_deletion_reauth_challenges WHERE id = $1',
    [proof.challengeId])).rows[0].attempts, 1);
  await query('UPDATE app_users SET password_hash = $2 WHERE id = $1',
    [account.user.id, await hashPassword('changed-password-123')]);
  assert.equal((await verify(account.accessToken, proof)).body.error.code, 'AUTH_REAUTH_FAILED');
  await query('UPDATE app_users SET password_hash = NULL WHERE id = $1', [account.user.id]);
  assert.equal((await verify(account.accessToken, proof)).body.error.code, 'AUTH_REAUTH_METHOD_UNAVAILABLE');
  assert.equal((await challenge(account.accessToken, 'password')).body.error.code, 'AUTH_REAUTH_METHOD_UNAVAILABLE');
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM account_deletion_authorizations WHERE user_id = $1',
    [account.user.id])).rows[0].count, 0);
});

test('five failed password proofs exhaust a challenge without issuing a grant', async () => {
  const account = await register();
  const issued = await challenge(account.accessToken, 'password');
  const challengeId = issued.body.data.challengeId;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await verify(account.accessToken, {
      challengeId, method: 'password', currentPassword: 'bad-password'
    })).body.error.code, 'AUTH_REAUTH_FAILED');
  }
  assert.equal((await verify(account.accessToken, {
    challengeId, method: 'password', currentPassword: password
  })).body.error.code, 'AUTH_REAUTH_INVALID');
  assert.equal((await query('SELECT attempts FROM account_deletion_reauth_challenges WHERE id = $1',
    [challengeId])).rows[0].attempts, 5);
});

test('a new challenge invalidates an earlier live challenge and creation is throttled per account', async () => {
  const account = await register();
  const first = await challenge(account.accessToken, 'password');
  const second = await challenge(account.accessToken, 'password');
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal((await verify(account.accessToken, {
    challengeId: first.body.data.challengeId, method: 'password', currentPassword: password
  })).body.error.code, 'AUTH_REAUTH_INVALID');
  for (let count = 2; count < 10; count += 1) {
    assert.equal((await challenge(account.accessToken, 'password')).status, 201);
  }
  assert.equal((await challenge(account.accessToken, 'password')).body.error.code, 'RATE_LIMITED');
});

test('simultaneous password verification issues at most one grant', async () => {
  const account = await register();
  const issued = await challenge(account.accessToken, 'password');
  const body = { challengeId: issued.body.data.challengeId, method: 'password', currentPassword: password };
  const responses = await Promise.all([verify(account.accessToken, body), verify(account.accessToken, body)]);
  assert.deepEqual(responses.map((result) => result.status).sort(), [200, 400]);
  assert.equal((await query(`
    SELECT COUNT(*)::int AS count FROM account_deletion_authorizations
    WHERE user_id = $1 AND consumed_at IS NULL
  `, [account.user.id])).rows[0].count, 1);
});

test('Apple uses only the server nonce and exact linked subject; bad proof never authorizes', async () => {
  const account = await appleAccount({ verified: false });
  const issued = await challenge(account.accessToken, 'apple');
  assert.equal(issued.status, 201);
  const { challengeId, nonce } = issued.body.data;
  assert.match(nonce, /^[0-9a-f]{64}$/);
  const challengeRow = (await query(`
    SELECT nonce_digest, created_at, expires_at FROM account_deletion_reauth_challenges WHERE id = $1
  `, [challengeId])).rows[0];
  assert.ok(challengeRow.nonce_digest.equals(digest(nonce)));
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM account_deletion_reauth_challenges WHERE nonce_digest = $1',
    [Buffer.from(nonce)])).rows[0].count, 0);
  const proof = (identityToken) => ({ challengeId, method: 'apple', identityToken });
  assert.equal((await verify(account.accessToken, {
    ...proof(await appleToken({ subject: account.subject, nonce: digest(nonce).toString('hex') })),
    expectedNonce: digest(nonce).toString('hex')
  })).body.error.code, 'VALIDATION_ERROR');
  const invalidTokens = [
    await appleToken({ subject: account.subject, nonce: 'wrong-nonce' }),
    await appleToken({ subject: account.subject, nonce: digest(nonce).toString('hex'), privateKey: untrusted.privateKey }),
    await appleToken({ subject: account.subject, nonce: digest(nonce).toString('hex'), issuer: 'https://attacker.test' }),
    await appleToken({ subject: account.subject, nonce: digest(nonce).toString('hex'), audience: 'wrong-client' }),
    await appleToken({ subject: account.subject, nonce: digest(nonce).toString('hex'), issuedAt: Math.floor(challengeRow.created_at.getTime() / 1000) - 120 })
  ];
  for (const token of invalidTokens) {
    assert.equal((await verify(account.accessToken, proof(token))).body.error.code, 'AUTH_REAUTH_FAILED');
  }
  assert.equal((await verify(account.accessToken, proof(await appleToken({
    subject: account.subject, nonce: digest(nonce).toString('hex')
  })))).body.error.code, 'AUTH_REAUTH_INVALID');

  const next = await challenge(account.accessToken, 'apple');
  const expectedNonce = digest(next.body.data.nonce).toString('hex');
  const wrongSubject = await verify(account.accessToken, {
    challengeId: next.body.data.challengeId, method: 'apple',
    identityToken: await appleToken({ subject: `apple-${randomUUID()}`, nonce: expectedNonce,
      tokenEmail: account.user.email })
  });
  assert.equal(wrongSubject.body.error.code, 'AUTH_REAUTH_FAILED');
  const success = await verify(account.accessToken, {
    challengeId: next.body.data.challengeId, method: 'apple',
    identityToken: await appleToken({ subject: account.subject, nonce: expectedNonce })
  });
  assert.equal(success.status, 200);
  const grant = await grantRow(success.body.data.deletionAuthorization);
  assert.equal(grant.verified_method, 'apple');
  assert.equal(grant.verified_provider_subject, account.subject);
  assert.equal((await verify(account.accessToken, {
    challengeId: next.body.data.challengeId, method: 'apple',
    identityToken: await appleToken({ subject: account.subject, nonce: expectedNonce })
  })).body.error.code, 'AUTH_REAUTH_INVALID');

  const sessionId = (await verifyAccessToken(account.accessToken)).sid;
  assert.deepEqual(await consumeGrant(success.body.data.deletionAuthorization, account.user.id, sessionId), {
    verifiedMethod: 'apple', verifiedProviderSubject: account.subject
  });
  await assert.rejects(consumeGrant(success.body.data.deletionAuthorization, account.user.id, sessionId),
    (error) => error.code === 'AUTH_REAUTH_INVALID');

  const expired = await challenge(account.accessToken, 'apple');
  await query(`
    UPDATE account_deletion_reauth_challenges
    SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1
  `, [expired.body.data.challengeId]);
  assert.equal((await verify(account.accessToken, {
    challengeId: expired.body.data.challengeId, method: 'apple',
    identityToken: await appleToken({
      subject: account.subject, nonce: digest(expired.body.data.nonce).toString('hex')
    })
  })).body.error.code, 'AUTH_REAUTH_EXPIRED');
});

test('grant validation rejects expiry, revoked session, and a removed linked identity', async () => {
  const expiredAccount = await register();
  const expiredChallenge = await challenge(expiredAccount.accessToken, 'password');
  const expiredGrant = await verify(expiredAccount.accessToken, {
    challengeId: expiredChallenge.body.data.challengeId, method: 'password', currentPassword: password
  });
  const expiredSession = (await verifyAccessToken(expiredAccount.accessToken)).sid;
  await query(`
    UPDATE account_deletion_authorizations
    SET expires_at = clock_timestamp() - INTERVAL '1 second'
    WHERE authorization_digest = $1
  `, [digest(expiredGrant.body.data.deletionAuthorization)]);
  await assert.rejects(consumeGrant(expiredGrant.body.data.deletionAuthorization,
    expiredAccount.user.id, expiredSession), (error) => error.code === 'AUTH_REAUTH_EXPIRED');
  await assert.rejects(query(`
    UPDATE account_deletion_authorizations SET operation = 'another_operation'
    WHERE authorization_digest = $1
  `, [digest(expiredGrant.body.data.deletionAuthorization)]),
  (error) => error.code === '23514');

  const revokedAccount = await register();
  const revokedChallenge = await challenge(revokedAccount.accessToken, 'password');
  const revokedGrant = await verify(revokedAccount.accessToken, {
    challengeId: revokedChallenge.body.data.challengeId, method: 'password', currentPassword: password
  });
  const revokedSession = (await verifyAccessToken(revokedAccount.accessToken)).sid;
  await request(app).post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${revokedAccount.accessToken}`);
  await assert.rejects(consumeGrant(revokedGrant.body.data.deletionAuthorization,
    revokedAccount.user.id, revokedSession), (error) => error.code === 'AUTH_INVALID_TOKEN');

  const linked = await register({ verified: true });
  const subject = await linkApple(linked);
  const issued = await challenge(linked.accessToken, 'apple');
  const socialGrant = await verify(linked.accessToken, {
    challengeId: issued.body.data.challengeId, method: 'apple',
    identityToken: await appleToken({ subject, nonce: digest(issued.body.data.nonce).toString('hex') })
  });
  assert.equal(socialGrant.status, 200);
  await request(app).delete('/api/v1/auth/identities/apple')
    .set('Authorization', `Bearer ${linked.accessToken}`).send({ currentPassword: password });
  await assert.rejects(consumeGrant(socialGrant.body.data.deletionAuthorization,
    linked.user.id, (await verifyAccessToken(linked.accessToken)).sid),
  (error) => error.code === 'AUTH_REAUTH_METHOD_UNAVAILABLE');
});

test('grant consumption is atomic, single-use, and rolls back with its transaction', async () => {
  const account = await register();
  const issued = await challenge(account.accessToken, 'password');
  const verified = await verify(account.accessToken, {
    challengeId: issued.body.data.challengeId, method: 'password', currentPassword: password
  });
  assert.equal(verified.status, 200);
  const authorization = verified.body.data.deletionAuthorization;
  const sessionId = (await verifyAccessToken(account.accessToken)).sid;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM app_users WHERE id = $1 FOR UPDATE', [account.user.id]);
    await client.query('SELECT id FROM auth_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    await consumeAccountDeletionAuthorization(client, {
      authorization, userId: account.user.id, sessionId
    });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  assert.equal((await grantRow(authorization)).consumed_at, null);

  const results = await Promise.allSettled([
    consumeGrant(authorization, account.user.id, sessionId),
    consumeGrant(authorization, account.user.id, sessionId)
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'AUTH_REAUTH_INVALID');
  assert.ok((await grantRow(authorization)).consumed_at);
  await assert.rejects(query(`
    INSERT INTO account_deletion_reauth_challenges
      (id, user_id, session_id, method, expires_at)
    VALUES ($1, $2, $3, 'apple', clock_timestamp() + INTERVAL '5 minutes')
  `, [randomUUID(), account.user.id, sessionId]), (error) => error.code === '23514');
  await query('DELETE FROM app_users WHERE id = $1', [account.user.id]);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM account_deletion_reauth_challenges WHERE user_id = $1',
    [account.user.id])).rows[0].count, 0);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM account_deletion_authorizations WHERE user_id = $1',
    [account.user.id])).rows[0].count, 0);
});

test('Apple unlink and session revocation during verification fail after the locked recheck', async () => {
  const account = await register({ verified: true });
  const subject = await linkApple(account);
  const issued = await challenge(account.accessToken, 'apple');
  let resume;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { resume = resolve; });
  const delayed = createAccountDeletionReauth({
    appleVerifier: async (...args) => {
      const identity = await appleVerifier(...args);
      entered();
      await hold;
      return identity;
    }
  });
  const auth = { user: { id: account.user.id }, payload: await verifyAccessToken(account.accessToken) };
  const pending = delayed.verify(auth, {
    challengeId: issued.body.data.challengeId, method: 'apple',
    identityToken: await appleToken({ subject, nonce: digest(issued.body.data.nonce).toString('hex') })
  });
  await enteredPromise;
  const unlinked = await request(app).delete('/api/v1/auth/identities/apple')
    .set('Authorization', `Bearer ${account.accessToken}`).send({ currentPassword: password });
  assert.equal(unlinked.status, 200);
  resume();
  await assert.rejects(pending, (error) => error.code === 'AUTH_REAUTH_METHOD_UNAVAILABLE');
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM account_deletion_authorizations WHERE user_id = $1',
    [account.user.id])).rows[0].count, 0);

  const passwordChallenge = await challenge(account.accessToken, 'password');
  assert.equal(passwordChallenge.status, 201);
  await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal((await verify(account.accessToken, {
    challengeId: passwordChallenge.body.data.challengeId, method: 'password', currentPassword: password
  })).body.error.code, 'AUTH_INVALID_TOKEN');
});

test('logout while Apple verifies its token cannot produce a deletion grant', async () => {
  const account = await appleAccount();
  const issued = await challenge(account.accessToken, 'apple');
  let resume;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { resume = resolve; });
  const delayed = createAccountDeletionReauth({
    appleVerifier: async (...args) => {
      const identity = await appleVerifier(...args);
      entered();
      await hold;
      return identity;
    }
  });
  const auth = { user: { id: account.user.id }, payload: await verifyAccessToken(account.accessToken) };
  const pending = delayed.verify(auth, {
    challengeId: issued.body.data.challengeId, method: 'apple',
    identityToken: await appleToken({
      subject: account.subject, nonce: digest(issued.body.data.nonce).toString('hex')
    })
  });
  await enteredPromise;
  assert.equal((await request(app).post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${account.accessToken}`)).status, 200);
  resume();
  await assert.rejects(pending, (error) => error.code === 'AUTH_INVALID_TOKEN');
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM account_deletion_authorizations WHERE user_id = $1',
    [account.user.id])).rows[0].count, 0);
});

test('password hash changing during expensive proof fails at the final locked check', async () => {
  const account = await register();
  const issued = await challenge(account.accessToken, 'password');
  let resume;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { resume = resolve; });
  const delayed = createAccountDeletionReauth({
    appleVerifier,
    passwordVerifier: async (...args) => {
      const valid = await verifyPassword(...args);
      entered();
      await hold;
      return valid;
    }
  });
  const auth = { user: { id: account.user.id }, payload: await verifyAccessToken(account.accessToken) };
  const pending = delayed.verify(auth, {
    challengeId: issued.body.data.challengeId, method: 'password', currentPassword: password
  });
  await enteredPromise;
  await query('UPDATE app_users SET password_hash = $2 WHERE id = $1',
    [account.user.id, await hashPassword('new-password-123')]);
  resume();
  await assert.rejects(pending, (error) => error.code === 'AUTH_REAUTH_FAILED');
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM account_deletion_authorizations WHERE user_id = $1',
    [account.user.id])).rows[0].count, 0);
});
