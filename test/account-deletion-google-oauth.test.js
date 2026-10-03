import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_for_google_deletion';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_IDENTITY_MANAGEMENT_RATE_LIMIT_MAX = '1000';
process.env.AUTH_GOOGLE_DELETION_CALLBACK_RATE_LIMIT_MAX = '1000';
process.env.AUTH_GOOGLE_RATE_LIMIT_MAX = '1000';
process.env.GLOBAL_API_RATE_LIMIT_MAX = '1000';

const { default: request } = await import('supertest');
const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = await import('jose');
const { createApp } = await import('../src/app.js');
const { createGoogleDeletionIdTokenVerifier, createGoogleCodeExchanger } =
  await import('../src/modules/auth/googleDeletionOAuth.js');
const { parseEnvironment } = await import('../src/config/env.js');
const { query } = await import('../src/db/query.js');
const { pool } = await import('../src/db/pool.js');
const { verifyAccessToken } = await import('../src/utils/jwt.js');
const execFileAsync = promisify(execFile);

const config = {
  GOOGLE_DELETION_OAUTH_CLIENT_ID: 'deletion-web-client',
  GOOGLE_DELETION_OAUTH_CLIENT_SECRET: 'test-only-secret',
  GOOGLE_DELETION_OAUTH_REDIRECT_URI: 'https://api.example.test/api/v1/auth/account/reauth/google/callback'
};
const trusted = await generateKeyPair('RS256');
const untrusted = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(trusted.publicKey), kid: 'google-deletion-test', alg: 'RS256', use: 'sig' };
const localVerifier = createGoogleDeletionIdTokenVerifier({
  config, keyResolver: createLocalJWKSet({ keys: [publicJwk] })
});
const codes = new Map();
const exchanges = [];
const users = new Set();
const normalGoogleVerifier = async (idToken) => ({
  provider: 'google', subject: idToken, email: `${idToken}@gmail.com`, emailVerified: true
});
const exchange = async (args) => {
  exchanges.push(args);
  const value = codes.get(args.code);
  if (value instanceof Error) throw value;
  if (typeof value === 'function') return value(args);
  return value;
};
const app = createApp({
  authGoogleVerifier: normalGoogleVerifier,
  authGoogleDeletionOAuthConfig: config,
  authGoogleDeletionCodeExchange: exchange,
  authGoogleDeletionTokenVerifier: localVerifier
});

function digest(value) { return createHash('sha256').update(value).digest(); }

async function account(subject = randomUUID()) {
  const signedIn = await request(app).post('/api/v1/auth/google').send({ idToken: subject });
  assert.equal(signedIn.status, 200);
  users.add(signedIn.body.data.user.id);
  return { ...signedIn.body.data, subject };
}

function challenge(accessToken, target = app) {
  return request(target).post('/api/v1/auth/account/reauth/challenge')
    .set('Authorization', `Bearer ${accessToken}`).send({ method: 'google' });
}

function verify(accessToken, challengeId, target = app) {
  return request(target).post('/api/v1/auth/account/reauth/verify')
    .set('Authorization', `Bearer ${accessToken}`).send({ challengeId, method: 'google' });
}

function callback(authorizationUrl, code, target = app) {
  const state = new URL(authorizationUrl).searchParams.get('state');
  return request(target).get('/api/v1/auth/account/reauth/google/callback').query({ state, code });
}

async function token({ nonce, subject, issuer = 'https://accounts.google.com',
  audience = config.GOOGLE_DELETION_OAUTH_CLIENT_ID, privateKey = trusted.privateKey,
  issuedAt = Math.floor(Date.now() / 1000), claims = {}, expiresIn = 3600 } = {}) {
  let signed = new SignJWT({ nonce, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'google-deletion-test' })
    .setIssuer(issuer).setAudience(audience)
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn);
  if (issuedAt !== null) signed = signed.setIssuedAt(issuedAt);
  if (subject !== undefined) signed = signed.setSubject(subject);
  return signed.sign(privateKey);
}

async function issueWithCode(owner, tokenOptions = {}) {
  const issued = await challenge(owner.accessToken);
  assert.equal(issued.status, 201);
  const url = new URL(issued.body.data.authorizationUrl);
  const code = randomUUID();
  codes.set(code, await token({ nonce: url.searchParams.get('nonce'), subject: owner.subject, ...tokenOptions }));
  return { issued, url, code };
}

after(async () => {
  try {
    await query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [[...users]]);
  } finally {
    await pool.end();
  }
});

test('Google deletion is unavailable without complete configuration or linked identity', async () => {
  const missingConfigApp = createApp({
    authGoogleVerifier: normalGoogleVerifier,
    authGoogleDeletionOAuthConfig: { ...config, GOOGLE_DELETION_OAUTH_CLIENT_SECRET: '' }
  });
  const owner = await account();
  assert.equal((await challenge(owner.accessToken, missingConfigApp)).body.error.code,
    'AUTH_REAUTH_METHOD_UNAVAILABLE');
  const registered = await request(app).post('/api/v1/auth/register')
    .send({ email: `${randomUUID()}@example.test`, password: 'test-password-123' });
  assert.equal(registered.status, 201);
  users.add(registered.body.data.user.id);
  assert.equal((await challenge(registered.body.data.accessToken)).body.error.code,
    'AUTH_REAUTH_METHOD_UNAVAILABLE');
  assert.equal((await verify(owner.accessToken, randomUUID(), missingConfigApp)).body.error.code,
    'AUTH_REAUTH_METHOD_UNAVAILABLE');
});

test('challenge URL, independent random values, and digest-only storage', async () => {
  const owner = await account();
  const issued = await challenge(owner.accessToken);
  assert.equal(issued.status, 201);
  assert.deepEqual(Object.keys(issued.body.data).sort(),
    ['authorizationUrl', 'challengeId', 'expiresAt', 'method']);
  const url = new URL(issued.body.data.authorizationUrl);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), config.GOOGLE_DELETION_OAUTH_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), config.GOOGLE_DELETION_OAUTH_REDIRECT_URI);
  assert.deepEqual(url.searchParams.get('scope').split(' '), ['openid', 'email']);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(url.searchParams.has('access_type'), false);
  assert.equal(url.searchParams.has('include_granted_scopes'), false);
  const state = url.searchParams.get('state');
  const nonce = url.searchParams.get('nonce');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state, nonce);
  const row = (await query(`
    SELECT user_id, session_id, operation, method, nonce_digest, google_state_digest,
      google_pkce_verifier, google_oauth_client_id, google_oauth_redirect_uri,
      google_callback_status, created_at, expires_at
    FROM account_deletion_reauth_challenges WHERE id = $1
  `, [issued.body.data.challengeId])).rows[0];
  assert.equal(row.user_id, owner.user.id);
  assert.equal(row.session_id, (await verifyAccessToken(owner.accessToken)).sid);
  assert.equal(row.operation, 'account_delete');
  assert.equal(row.method, 'google');
  assert.equal(row.google_callback_status, 'pending');
  assert.equal(row.google_oauth_client_id, config.GOOGLE_DELETION_OAUTH_CLIENT_ID);
  assert.equal(row.google_oauth_redirect_uri, config.GOOGLE_DELETION_OAUTH_REDIRECT_URI);
  assert.ok(row.google_state_digest.equals(digest(state)));
  assert.ok(row.nonce_digest.equals(digest(nonce)));
  assert.notEqual(row.google_pkce_verifier, state);
  assert.notEqual(row.google_pkce_verifier, nonce);
  assert.match(row.google_pkce_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url.searchParams.get('code_challenge'),
    digest(row.google_pkce_verifier).toString('base64url'));
  assert.ok(Math.abs((row.expires_at - row.created_at) / 1000 - 300) < 2);
});

test('public callback records proof; only authenticated same-session finalization grants deletion', async () => {
  const owner = await account();
  const { issued, code } = await issueWithCode(owner);
  const id = issued.body.data.challengeId;
  assert.equal((await verify(owner.accessToken, id)).body.error.code, 'AUTH_REAUTH_INVALID');
  const completed = await callback(issued.body.data.authorizationUrl, code);
  assert.equal(completed.status, 200);
  assert.match(completed.text, /Verification complete/);
  for (const value of [owner.subject, code, owner.accessToken, 'deletionAuthorization']) {
    assert.equal(completed.text.includes(value), false);
  }
  assert.equal(completed.headers['cache-control'], 'no-store');
  assert.equal(completed.headers['referrer-policy'], 'no-referrer');
  const row = (await query(`
    SELECT google_callback_status, google_verified_subject, google_callback_completed_at,
      google_pkce_verifier, consumed_at FROM account_deletion_reauth_challenges WHERE id = $1
  `, [id])).rows[0];
  assert.equal(row.google_callback_status, 'verified');
  assert.equal(row.google_verified_subject, owner.subject);
  assert.ok(row.google_callback_completed_at);
  assert.equal(row.google_pkce_verifier, null);
  assert.equal(row.consumed_at, null);
  assert.equal(exchanges.at(-1).clientId, config.GOOGLE_DELETION_OAUTH_CLIENT_ID);
  assert.equal(exchanges.at(-1).redirectUri, config.GOOGLE_DELETION_OAUTH_REDIRECT_URI);
  assert.equal(exchanges.at(-1).clientSecret, config.GOOGLE_DELETION_OAUTH_CLIENT_SECRET);
  assert.match(exchanges.at(-1).codeVerifier, /^[A-Za-z0-9_-]{43}$/);

  const second = await request(app).post('/api/v1/auth/google').send({ idToken: owner.subject });
  assert.equal(second.status, 200);
  assert.equal((await verify(second.body.data.accessToken, id)).body.error.code, 'AUTH_REAUTH_INVALID');
  const granted = await verify(owner.accessToken, id);
  assert.equal(granted.status, 200);
  const grant = (await query(`
    SELECT verified_method, verified_provider_subject FROM account_deletion_authorizations
    WHERE authorization_digest = $1
  `, [digest(granted.body.data.deletionAuthorization)])).rows[0];
  assert.deepEqual(grant, { verified_method: 'google', verified_provider_subject: owner.subject });
  assert.equal((await verify(owner.accessToken, id)).body.error.code, 'AUTH_REAUTH_INVALID');
  const deleted = await request(app).delete('/api/v1/auth/account')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ deletionAuthorization: granted.body.data.deletionAuthorization });
  assert.equal(deleted.status, 200);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM app_users WHERE id = $1',
    [owner.user.id])).rows[0].count, 0);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM auth_identities WHERE user_id = $1',
    [owner.user.id])).rows[0].count, 0);
});

test('unknown state cannot invalidate a challenge; duplicate callback exchanges once', async () => {
  const owner = await account();
  const { issued, code } = await issueWithCode(owner);
  const url = issued.body.data.authorizationUrl;
  const state = new URL(url).searchParams.get('state');
  const before = exchanges.length;
  const wrong = await request(app).get('/api/v1/auth/account/reauth/google/callback')
    .query({ state: `${state.slice(0, -1)}${state.at(-1) === 'A' ? 'B' : 'A'}`, code });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.text.includes(state), false);
  assert.equal(exchanges.length, before);
  assert.equal((await query('SELECT google_callback_status FROM account_deletion_reauth_challenges WHERE id = $1',
    [issued.body.data.challengeId])).rows[0].google_callback_status, 'pending');
  let resume;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { resume = resolve; });
  const validToken = codes.get(code);
  codes.set(code, async () => { entered(); await hold; return validToken; });
  const first = callback(url, code).then((result) => result);
  await enteredPromise;
  const duplicate = await callback(url, code);
  assert.equal(duplicate.status, 400);
  resume();
  assert.equal((await first).status, 200);
  assert.equal(exchanges.length, before + 1);
  assert.equal((await callback(url, code)).status, 400);
  assert.equal(exchanges.length, before + 1);
});

test('a code or token from an earlier challenge cannot prove a new challenge', async () => {
  const owner = await account();
  const first = await issueWithCode(owner);
  assert.equal((await callback(first.issued.body.data.authorizationUrl, first.code)).status, 200);
  const second = await challenge(owner.accessToken);
  assert.equal(second.status, 201);
  assert.equal((await callback(second.body.data.authorizationUrl, first.code)).status, 400);
  assert.equal((await verify(owner.accessToken, second.body.data.challengeId)).body.error.code,
    'AUTH_REAUTH_INVALID');
});

test('expired, superseded, and revoked-session callbacks cannot exchange', async () => {
  const owner = await account();
  const expired = await issueWithCode(owner);
  await query(`UPDATE account_deletion_reauth_challenges
    SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1`,
  [expired.issued.body.data.challengeId]);
  const before = exchanges.length;
  assert.equal((await callback(expired.issued.body.data.authorizationUrl, expired.code)).status, 400);
  assert.equal(exchanges.length, before);
  const old = await issueWithCode(owner);
  const replacement = await issueWithCode(owner);
  assert.equal((await callback(old.issued.body.data.authorizationUrl, old.code)).status, 400);
  assert.equal(exchanges.length, before);
  const oldRow = (await query(`SELECT consumed_at, google_callback_status, google_pkce_verifier
    FROM account_deletion_reauth_challenges WHERE id = $1`, [old.issued.body.data.challengeId])).rows[0];
  assert.ok(oldRow.consumed_at);
  assert.equal(oldRow.google_callback_status, 'failed');
  assert.equal(oldRow.google_pkce_verifier, null);
  assert.equal((await callback(replacement.issued.body.data.authorizationUrl, replacement.code)).status, 200);

  const other = await account();
  const revoked = await issueWithCode(other);
  assert.equal((await request(app).post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${other.accessToken}`)).status, 200);
  const afterSuccess = exchanges.length;
  assert.equal((await callback(revoked.issued.body.data.authorizationUrl, revoked.code)).status, 400);
  assert.equal(exchanges.length, afterSuccess);
  assert.equal((await verify(other.accessToken, revoked.issued.body.data.challengeId)).body.error.code,
    'AUTH_INVALID_TOKEN');
});

test('revocation, supersession, and expiry during code exchange fail closed', async () => {
  for (const change of ['revoke', 'supersede', 'expire']) {
    const owner = await account();
    const valid = await issueWithCode(owner);
    let resume;
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const hold = new Promise((resolve) => { resume = resolve; });
    const signedToken = codes.get(valid.code);
    codes.set(valid.code, async () => { entered(); await hold; return signedToken; });
    const pending = callback(valid.issued.body.data.authorizationUrl, valid.code).then((result) => result);
    await enteredPromise;
    if (change === 'revoke') {
      assert.equal((await request(app).post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${owner.accessToken}`)).status, 200);
    } else if (change === 'supersede') {
      assert.equal((await challenge(owner.accessToken)).status, 201);
    } else {
      await query(`UPDATE account_deletion_reauth_challenges
        SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1`,
      [valid.issued.body.data.challengeId]);
    }
    resume();
    assert.equal((await pending).status, 400);
    const row = (await query(`SELECT google_callback_status, google_pkce_verifier
      FROM account_deletion_reauth_challenges WHERE id = $1`, [valid.issued.body.data.challengeId])).rows[0];
    assert.equal(row.google_callback_status, 'failed');
    assert.equal(row.google_pkce_verifier, null);
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_deletion_authorizations
      WHERE user_id = $1`, [owner.user.id])).rows[0].count, 0);
  }
});

test('Google cancellation is terminal for a valid state and never exchanges a code', async () => {
  const owner = await account();
  const issued = await challenge(owner.accessToken);
  const state = new URL(issued.body.data.authorizationUrl).searchParams.get('state');
  const before = exchanges.length;
  const response = await request(app).get('/api/v1/auth/account/reauth/google/callback')
    .query({ state, error: 'access_denied' });
  assert.equal(response.status, 400);
  assert.match(response.text, /Verification could not be completed/);
  assert.equal(response.text.includes(state), false);
  assert.equal(exchanges.length, before);
  const row = (await query(`SELECT google_callback_status, google_pkce_verifier
    FROM account_deletion_reauth_challenges WHERE id = $1`, [issued.body.data.challengeId])).rows[0];
  assert.equal(row.google_callback_status, 'failed');
  assert.equal(row.google_pkce_verifier, null);
});

test('wrong account or changed linked subject fails even if email is the same', async () => {
  const owner = await account();
  const wrong = await issueWithCode(owner, {
    subject: randomUUID(), claims: { email: `${owner.subject}@gmail.com`, email_verified: true }
  });
  assert.equal((await callback(wrong.issued.body.data.authorizationUrl, wrong.code)).status, 400);
  const failed = (await query(`SELECT google_callback_status, google_pkce_verifier
    FROM account_deletion_reauth_challenges WHERE id = $1`, [wrong.issued.body.data.challengeId])).rows[0];
  assert.equal(failed.google_callback_status, 'failed');
  assert.equal(failed.google_pkce_verifier, null);
  assert.equal((await verify(owner.accessToken, wrong.issued.body.data.challengeId)).body.error.code,
    'AUTH_REAUTH_INVALID');

  const changed = await issueWithCode(owner);
  assert.equal((await callback(changed.issued.body.data.authorizationUrl, changed.code)).status, 200);
  await query(`UPDATE auth_identities SET provider_subject = $2
    WHERE user_id = $1 AND provider = 'google'`, [owner.user.id, randomUUID()]);
  assert.equal((await verify(owner.accessToken, changed.issued.body.data.challengeId)).body.error.code,
    'AUTH_REAUTH_FAILED');

  const unlinked = await account();
  const pending = await issueWithCode(unlinked);
  await query("DELETE FROM auth_identities WHERE user_id = $1 AND provider = 'google'", [unlinked.user.id]);
  assert.equal((await callback(pending.issued.body.data.authorizationUrl, pending.code)).status, 400);
  assert.equal((await verify(unlinked.accessToken, pending.issued.body.data.challengeId)).body.error.code,
    'AUTH_REAUTH_INVALID');
});

test('deletion verifier rejects ordinary, stale, wrong-audience, and forged Google ID tokens', async () => {
  const variants = [
    (nonce, subject) => ({ nonce: 'wrong', subject }),
    (_nonce, subject) => ({ nonce: undefined, subject }),
    (nonce, subject) => ({ nonce, subject, audience: 'normal-google-client' }),
    (nonce, subject) => ({ nonce, subject, issuer: 'https://attacker.example' }),
    (nonce, subject) => ({ nonce, subject, privateKey: untrusted.privateKey }),
    (nonce, subject) => ({ nonce, subject, issuedAt: Math.floor(Date.now() / 1000) - 600 }),
    (nonce, subject) => ({ nonce, subject, issuedAt: null }),
    (nonce) => ({ nonce, subject: undefined }),
    (nonce, subject) => ({ nonce, subject, claims: { azp: 'another-client' } }),
    (nonce, subject) => ({ nonce, subject, expiresIn: -10 })
  ];
  for (const variant of variants) {
    const owner = await account();
    const issued = await challenge(owner.accessToken);
    assert.equal(issued.status, 201);
    const nonce = new URL(issued.body.data.authorizationUrl).searchParams.get('nonce');
    const code = randomUUID();
    codes.set(code, await token(variant(nonce, owner.subject)));
    assert.equal((await callback(issued.body.data.authorizationUrl, code)).status, 400);
    assert.equal((await verify(owner.accessToken, issued.body.data.challengeId)).body.error.code,
      'AUTH_REAUTH_INVALID');
  }
});

test('token-exchange failures are terminal, and parallel finalization issues one grant', async () => {
  for (const failure of [new Error('timeout'), new Error('provider 500'), undefined]) {
    const owner = await account();
    const issued = await challenge(owner.accessToken);
    const code = randomUUID();
    codes.set(code, failure);
    const result = await callback(issued.body.data.authorizationUrl, code);
    assert.equal(result.status, 400);
    assert.equal((await callback(issued.body.data.authorizationUrl, code)).status, 400);
    const row = (await query(`SELECT google_callback_status, google_pkce_verifier
      FROM account_deletion_reauth_challenges WHERE id = $1`, [issued.body.data.challengeId])).rows[0];
    assert.equal(row.google_callback_status, 'failed');
    assert.equal(row.google_pkce_verifier, null);
  }
  const owner = await account();
  const valid = await issueWithCode(owner);
  assert.equal((await callback(valid.issued.body.data.authorizationUrl, valid.code)).status, 200);
  const id = valid.issued.body.data.challengeId;
  const results = await Promise.all([verify(owner.accessToken, id), verify(owner.accessToken, id)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_deletion_authorizations
    WHERE user_id = $1 AND consumed_at IS NULL`, [owner.user.id])).rows[0].count, 1);
  const replacement = await challenge(owner.accessToken);
  assert.equal(replacement.status, 201);
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_deletion_authorizations
    WHERE user_id = $1 AND consumed_at IS NULL`, [owner.user.id])).rows[0].count, 0);
});

test('token endpoint exchange uses only required values and rejects bad responses', async () => {
  const calls = [];
  const exchangeCode = createGoogleCodeExchanger({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ id_token: 'signed-id-token', access_token: 'ignored' }) };
    }, timeoutMs: 100
  });
  assert.equal(await exchangeCode({ code: 'one-time-code', clientId: 'web-client',
    clientSecret: 'server-secret', redirectUri: config.GOOGLE_DELETION_OAUTH_REDIRECT_URI,
    codeVerifier: 'v'.repeat(43) }), 'signed-id-token');
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(Object.fromEntries(calls[0].options.body), {
    code: 'one-time-code', client_id: 'web-client', client_secret: 'server-secret',
    redirect_uri: config.GOOGLE_DELETION_OAUTH_REDIRECT_URI,
    code_verifier: 'v'.repeat(43), grant_type: 'authorization_code'
  });
  for (const response of [
    { ok: false, status: 400 }, { ok: false, status: 503 },
    { ok: true, json: async () => ({}) }, { ok: true, json: async () => { throw new Error('bad JSON'); } }
  ]) {
    const broken = createGoogleCodeExchanger({ fetchImpl: async () => response });
    await assert.rejects(() => broken({ code: 'x', clientId: 'x', clientSecret: 'x',
      redirectUri: 'https://example.test', codeVerifier: 'v'.repeat(43) }));
  }
  const timeout = createGoogleCodeExchanger({ fetchImpl: async (_url, options) => {
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort',
      () => reject(new Error('timeout')), { once: true }));
  }, timeoutMs: 10 });
  await assert.rejects(() => timeout({ code: 'x', clientId: 'x', clientSecret: 'x',
    redirectUri: 'https://example.test', codeVerifier: 'v'.repeat(43) }),
  (error) => error.code === 'AUTH_PROVIDER_UNAVAILABLE');
});

test('HTTP request logging suppresses OAuth callback code and state', async () => {
  const marker = `sensitive-oauth-${randomUUID()}`;
  const script = `
    import request from 'supertest';
    import { createApp } from './src/app.js';
    const app = createApp();
    await request(app).get('/api/v1/health');
    await request(app).get('/api/v1/auth/account/reauth/google/callback')
      .query({ state: ${JSON.stringify(marker)}, code: ${JSON.stringify(marker)} });
  `;
  const { stdout } = await execFileAsync(process.execPath,
    ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, LOG_LEVEL: 'info',
        GOOGLE_DELETION_OAUTH_CLIENT_ID: '', GOOGLE_DELETION_OAUTH_CLIENT_SECRET: '',
        GOOGLE_DELETION_OAUTH_REDIRECT_URI: '' }
    });
  assert.match(stdout, /\/api\/v1\/health/);
  assert.equal(stdout.includes(marker), false);
});

test('redirect validation rejects non-HTTPS production or wrong callback paths', () => {
  const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/test',
    JWT_SECRET: 'x'.repeat(32), AUTH_EMAIL_DELIVERY_MODE: 'resend', RESEND_API_KEY: 'x',
    AUTH_EMAIL_FROM: 'sender@example.test',
    ALCHEMY_NOTIFY_API_KEY: 'x',
    ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET: 'a',
    ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET: 'b',
    ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET: 'x',
    ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET: 'y' };
  for (const redirect of ['http://api.example.test/api/v1/auth/account/reauth/google/callback',
    'https://api.example.test/other']) {
    assert.throws(() => parseEnvironment({ ...base,
      GOOGLE_DELETION_OAUTH_REDIRECT_URI: redirect }), /GOOGLE_DELETION_OAUTH_REDIRECT_URI/);
  }
});
